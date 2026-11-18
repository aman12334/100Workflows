# Architecture

100 Workflows is one Next.js app that runs on the user's machine. There are no separate services. The guiding rule is to choose the simplest implementation that works and add abstraction only when a real workflow needs it.

## Modules

| Module | Files | Responsibility |
| --- | --- | --- |
| Catalog | `src/lib/catalog/schema.ts`, `catalog.ts`, `load.ts`, `search.ts` | Zod schemas; expansion of shared-input references; whole-catalog checks (ids, folders, tools, dependencies, cycles); recursive loader; keyword search with light stemming |
| Catalog tooling | `src/lib/catalog/tooling/*`, `scripts/*` | Lint rules, search cases, scaffold templates, generated JSON Schemas and `docs/catalog.md` |
| Chat engine | `src/lib/server/chat.ts` | One user turn: a bounded tool-use loop with `search_catalog` and `recommend_workflows`, then validation of every workflow id the reply mentions |
| Conversations | `src/lib/server/conversation-service.ts`, `db/conversations.ts`, `app/api/conversations/*` | Store the user message, answer it from stored history, and store the reply. A failed model call stores nothing, so the turn can be retried |
| Packages | `src/lib/packages/resolve.ts` (pure), `src/lib/server/package-service.ts`, `db/packages.ts`, `app/api/packages/*` | Dependency expansion, safe removal, execution order, input merging, version pinning |
| Database | `src/lib/server/db/index.ts`, `migrate.ts`, `migrations/*.sql` | One SQLite file (better-sqlite3, WAL, foreign keys), with checksummed migrations applied at startup |
| Inputs | `src/lib/packages/inputs.ts`, `app/api/packages/[id]/inputs`, `components/setup/*` | Setup form fields, per-type validation, missing-input detection, and resolving the values each workflow receives |
| Runtime | `src/lib/runtime/engine.ts`, `budget.ts`, `evaluation.ts`, `model.ts` | The bounded produce → check → evaluate → retry/accept/escalate loop, call and time budgets, and structured-output helpers |
| Executors | `src/lib/runtime/executors/*` | Hand-written executors for workflows that need code (Market Research, ICP Builder), registered by id and major.minor version; the generic executor for schema-v2 definitions; `resolveExecutor()` picks one for each pinned definition |
| Output schemas and rules | `src/lib/catalog/output-schema.ts`, `src/lib/runtime/rules/*` | The JSON Schema subset a v2 definition's `outputSchema` may use, compiled to a Zod validator; the registry of deterministic rules (`count`, `required_fields`, `verbatim_in_inputs`, `references`, `max_words`, `distinct`) and their load-time checks |
| Pricing | `src/lib/runtime/pricing.ts` | Verified list prices and the cost estimate shown for a run. Models without a verified price get no estimate |
| Tools | `src/lib/runtime/tools/*`, `src/lib/runtime/executors/research.ts` | The read-only tool allowlist (`web-search`, `web-fetch`), the runner that enforces it (validation, budgets, timeouts, retries, cancellation, logging), the SSRF-safe fetch transport, page extraction, and the gather step research workflows use. See [tools.md](tools.md) |
| Run service | `src/lib/server/run-service.ts`, `db/runs.ts`, `app/api/runs/*`, `app/runs/*` | Preflight, background execution in dependency order, cancellation, restart recovery, trace and evaluation storage |
| Model client | `src/lib/providers.ts`, `src/lib/server/model-client.ts`, `claude.ts`, `openai.ts`, `src/lib/runtime/openai-translate.ts` | Picks the provider from the environment; one file per provider SDK; a translator so OpenAI serves the same request shape |
| Config | `src/lib/server/config.ts` | Reads env at call time and reports `configured`/`model`/`problem`, never the key |
| Request guard | `src/lib/request-guard.ts`, `src/proxy.ts` | Host allowlist, same-origin and JSON checks on `/api/*` |
| Logging | `src/lib/server/log.ts` | JSON lines with recursive secret redaction |
| UI | `src/app/*`, `src/components/*` | Chat, library, workflow detail, settings |

## Key decisions

**Workflow definitions as JSON, not TypeScript.** JSON is data-only, so a contributed definition can't execute code. It is easy to diff and review, and can be validated by a script. TypeScript definitions would give type inference but would let a definition run arbitrary code at import time.

**Two providers behind one function type, not a provider framework.** The chat engine and runtime depend only on `CreateMessage` (Anthropic's request and reply shape), which is also how tests inject a fake model. `claude.ts` passes requests straight to Anthropic. For OpenAI, `openai-translate.ts` turns the same request into a Responses API call: system text as `instructions`, tool calls and results as `function_call` and `function_call_output` items, function tools, `tool_choice`, JSON output format and reasoning effort. It turns the reply back into the Anthropic shape. It uses the Responses API, not Chat Completions, because OpenAI's reasoning models reject function tools combined with reasoning on `/v1/chat/completions`. Requests set `store: false`, so OpenAI doesn't keep conversations; the model's encrypted reasoning items are carried back within a turn instead, as OpenAI requires for tool calls. Anthropic-only features, such as the server-side web search tool, are refused with a clear error instead of being dropped; that's why Market Research's preflight skips it on OpenAI. `model-client.ts` chooses per request from the environment (`WORKFLOWS_PROVIDER`, otherwise whichever key exists).

**Grounding by tool, verified by the server.** The model never sees the catalog in its prompt. It must call `search_catalog`. The system prompt requires citing workflows by `` `id` ``, and the server extracts those ids and splits them into verified and unknown. This turns "the LLM must not invent workflows" into something enforced and tested (`tests/chat.test.ts`), not just a prompt instruction.

**Bounded loop.** `MAX_MODEL_CALLS = 4` per turn. The final call sets `tool_choice: none`. Invalid tool input and unknown tool names are returned to the model as `is_error` results rather than thrown. Refusals stop the turn with a neutral message. The request also enables the API's server-side refusal fallback (`fallbacks: "default"`), so a policy decline can be retried on a suitable model in the same call.

**History lives on the server.** The browser sends only the new message (≤8,000 characters). The server replays the last 40 stored messages as plain text, so a client can't rewrite earlier turns. Tool traffic lives only within a single turn.

**Packages pin definitions.** Each package row stores the full definition JSON and its SHA-256 hash. Execution order, input merging and requirements are computed from those snapshots, never from the live catalog. Only *Update to latest* re-pins a workflow, and it adds any new required dependencies at the same time. Required dependencies are added automatically (marked `dependency`). Optional ones are offered as suggestions. Removal is refused while another member requires the workflow, and dependency-only members that nothing needs any more are pruned.

**Shared inputs.** An input key is treated as shared business context when any workflow marks it `shared` or when two or more package members use the same key. A key declared with different types by different workflows is reported as a conflict and kept separate rather than merged silently.

**SQLite via better-sqlite3.** It is synchronous, fast and already supported by Next.js as a server external package. Node's built-in `node:sqlite` would avoid a native dependency, but it isn't available on every Node version the project supports. Migrations are plain SQL files: contributors can read them, and they run anywhere.

**Orchestration: a small custom state machine, not LangGraph.js.** Both runnable workflows are short pipelines: gather (once), then write, check and review, with bounded retries. `engine.ts` implements that loop in about 200 lines and is easy to read, test and bound. Its termination is structural: at most `maxRetries + 1` attempts, a `Budget` that counts every model call against `maxModelCalls`, a wall-clock deadline, and an `AbortSignal` for cancel. A graph framework would add checkpointers and interrupt semantics that nothing needs yet. Parallel branches or long human-in-the-loop pauses would be the reasons to revisit.

**Definitions are data; behavior is reviewed code.** A JSON definition can mark itself `available`, but the runtime only executes it when `resolveExecutor()` finds something that can run that exact pinned definition (`runnability()`): a hand-written executor registered for its id and major.minor line, or, for a schema-v2 generic definition, the generic executor once `validateGenericDefinition()` accepts it. A hand-written executor always wins for its id. A test asserts that `available` and "has an executor" always agree. Executors may only trace steps and report criteria that their definition declares.

**Schema v2: a generic executor for workflows that need no code.** Most workflows are "write a structured document from the user's inputs, then check it". A v2 definition says that in data: `execution` (system prompt, token limit, effort), an `outputSchema` in a JSON Schema subset, step `prompt`s with `mode: "generate"` or `"revise"`, and criteria that name a built-in `rule` or a model `review` rubric. The generic executor (`executors/generic.ts`) runs it on the same engine as hand-written executors, so budgets, retries with feedback, critical vetoes and traces are identical. What a definition can't do is the security boundary: no tools, integrations or custom code, rules come from a fixed registry, inputs and upstream outputs are fenced as data in the prompt, and every reply is validated against the schema locally. All of this is checked when the catalog loads, including that rule paths exist in the output schema and that one attempt fits `maxModelCalls`. The v2 fields are optional and have no defaults, so v1 definitions parse to the same objects and keep their fingerprints; `tests/schema-v2.test.ts` pins the hashes of every v1 definition, including the pre-migration snapshots of the three migrated pilots in `tests/fixtures/v1-snapshots/`.

**Research through a shared, read-only tool layer.** Research workflows add a `gather` step to a schema-v2 definition: which URL inputs to read, whether to search, how many results to open, and a page limit. The generic executor runs it once in `prepare`, through `ToolRunner`, so definitions never carry code and every call passes the same allowlist, input validation, budget, timeout, retry, cancellation and logging. Web search reuses Anthropic's server-side tool inside a budgeted model call (no new provider or credential); page reading is a small built-in transport using Node's `http`/`https` with SSRF protection (DNS-pinned public addresses only, re-checked redirects, size and time limits). Retrieved text reaches the writer fenced as untrusted `<source>` data, and two citation rules check the output against the text that was actually retrieved. A run that retrieves nothing fails instead of writing from memory. Details in [tools.md](tools.md).

**Observability: per step, per workflow, per run.** Every step stores its start and finish time and the token, call and search usage the API reported. `getRun()` derives durations and adds a run-level summary (totals across workflows). A run also records the provider and model it was configured with (migration `004`), and a snapshot of the verified price for that model. The estimated cost is computed from stored token counts and that snapshot, so a later price change doesn't rewrite old estimates. Prices are only those copied from a published list (`pricing.ts`, with source and date). A model without one, which today includes every OpenAI model, shows token usage and the reason there is no estimate, never a guessed number. Estimates exclude web search charges, caching discounts and negotiated or partner pricing, and the UI says so. Runs recorded before migration `004` show "recorded before cost tracking".

**Retries rewrite; they don't re-research.** Market Research searches once (`prepare`), then each attempt re-runs only the writer with the failed checks as feedback. That keeps search cost fixed, and every attempt is judged against the same retrieved sources.

**Sources come from the API, never from the model.** Only `web_search_tool_result` blocks returned by Anthropic count as sources. Citations are matched to them by URL, and the writer's `source_ids` are verified against that list deterministically. Web content reaches prompts inside delimited blocks marked as untrusted data. Rendered links open in a new tab with `noopener noreferrer`, and HTML in markdown is not rendered.

**Structured outputs plus local validation.** Writers and reviewers use `output_config.format`, built from the same Zod schema that validates the reply (for v2 definitions, from `outputSchema`, which is compiled to Zod). Keywords the API doesn't support are stripped from the JSON Schema and enforced by Zod instead. A reply that doesn't parse becomes a failed critical `schema_valid` check, so it can be retried like any other failure. (Structured outputs can't be combined with citations, which is why search and writing are separate calls.)

**Three separate signals.** `status` (did it execute and was it accepted), `quality_score` (the mean of the criteria, with critical criteria able to veto) and `confidence` (an evidence heuristic) are stored in separate columns and shown separately. Model reviews are graded on a 1-5 rubric by a separate low-effort call, and their scores are treated as rubric scores, not probabilities.

**Runs in the server process.** `startRun` records the run and its planned statuses, then executes in the background, and the UI polls `GET /api/runs/:id`. This needs no queue or worker. The trade-off is that stopping the server interrupts runs, and `markInterrupted` cleans them up at the next start. Downstream workflows only receive upstream outputs that were **accepted**, and they re-validate them with the upstream's output schema.

**Scaling the catalog.** The catalog is designed to reach 100+ definitions without a database or an index:
- One folder per category, and the file path must match the id and category, so a contributor can always find a definition from its id.
- **Shared inputs** live in one vocabulary file and definitions reference them, so a package never asks for "Company name" twice with two different descriptions.
- **Tool ids** come from one registry, so a typo can't create a tool nobody provides.
- **Lint** turns review comments into automated checks (placeholders, too few problems, missing examples, no critical check). CI runs it in strict mode.
- **Search cases** are a small regression suite for discovery, so a new definition can't quietly push an existing workflow out of the results for its core query.
- **Generated artifacts** (editor schemas, `docs/catalog.md`) are produced from the same source, and checked in CI so they can't drift.
- **Versions:** hand-written executors declare major.minor lines, so wording fixes (patch releases) never strand packages, while behavior changes (minor) require code review of the executor. Generic definitions carry their own configuration, so a package runs exactly the prompts and checks it pinned. A pinned snapshot that relies on a rule a later runtime removed is reported as "can no longer run" rather than failing mid-run.
- **No code per workflow:** with schema v2, adding a runnable workflow is a JSON file and a scripted-model test, reviewed like any definition.

## Security model

| Threat | Mitigation |
| --- | --- |
| Key leaks to the browser | Server-only modules; client components receive booleans and the model name only |
| Key committed to git | `.env*` ignored except `.env.example`; setup writes `.env.local` with mode 600 |
| Key in logs | Recursive redaction of `sk-ant-…` patterns and secret-named fields |
| Another website driving the local API (CSRF / DNS rebinding) | Server bound to 127.0.0.1; `Host` allowlist; same-origin `Origin` required; JSON content type forces a CORS preflight |
| Malicious workflow definition | JSON only; strict schema (unknown fields rejected); steps can only reference declared tool ids; the runtime owns all behavior. Schema-v2 prompts only steer that workflow's own model calls; they can't add tools, integrations or rules, and inputs are fenced as data |
| Prompt injection through catalog text | Tool results are labeled as data in the system prompt. Cited ids are verified server-side regardless of what the text says |
| Runaway cost | Chat: per-turn model call cap, `max_tokens`, history size. Runs: per-workflow `maxModelCalls`, `maxRetries`, `timeoutSeconds`, ≤5 searches per run; web search is opt-in; generic model reviews are skipped once a critical rule has failed. Each run shows its usage and, where a price is verified, an estimated cost |
| Prompt injection through web pages | Pages are delimited, untrusted data; source ids are verified in code; downstream workflows re-validate upstream outputs with a schema |
| Repeated side effects on retry | No runnable workflow has side effects. Executors with side effects (sending, writing records) will need an approval gate and idempotency keys before they can be registered |

**Not addressed yet:** other local programs can call the API (there is no per-session token), and nothing limits a user's own request rate.

## Data model

| Table | Purpose |
| --- | --- |
| `schema_migrations` | Applied migration ids and checksums |
| `conversations`, `messages` | Chat history. Assistant messages keep their verified recommendations and token usage in `reply_json` |
| `packages` | Name, goal, and an optional link to the source conversation (`ON DELETE SET NULL`) |
| `package_workflows` | Pinned definition snapshot, version, hash, and `added_as` (`selected` or `dependency`) |
| `package_inputs` | User configuration per input key. Filled by the setup screen in Milestone 4 |
| `runs` | One execution of a package: `running`, `completed`, `failed`, `cancelled` or `interrupted`, plus the provider, model and verified price snapshot it ran with (NULL for runs before migration `004`) |
| `workflow_runs` | Per workflow: status and reason, attempts, `quality_score`, decision, `confidence_json`, output JSON and markdown, usage |
| `run_steps` | Trace: every agent call and check per attempt, with timing, detail, error and token/search usage |
| `evaluations` | One row per attempt: score, pass/fail, decision (`accept`, `retry`, `escalate`) and each criterion's result |
| `tool_calls` | One row per tool call (migration `005`): tool id and version, status and error kind, attempts, target URL or search request, timing and sizes |

Secrets never go into the database.
