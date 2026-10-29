# 100 Workflows

**Describe a business problem in chat, then discover the agentic workflows that solve it.**

100 Workflows is an open-source, local-first app. You run it on your own computer, connect your own Anthropic API key, and talk to an assistant that searches a catalog of workflow definitions across go-to-market, marketing, sales, finance and user research. It explains which workflows fit your goal and what each one needs.

> **Status: all 5 initial milestones are done.** Chat, grounded recommendations, persistent packages, setup forms, and real execution of two connected workflows (**Market Research Agent** and **Ideal Customer Profile Builder**) with evaluation, bounded retries and saved results. The catalog has 12 workflows across all 7 categories and contributor tooling to grow it. The other 10 workflows are *definition only*, and the app says so wherever they appear.

---

## Quick start

**Prerequisites:** Node.js 20.9 or newer, npm, and an [Anthropic API key](https://console.anthropic.com/settings/keys). No database, Docker or other accounts are needed.

```bash
git clone https://github.com/<your-username>/100-workflows.git
cd 100-workflows
npm install
npm run setup      # paste your Anthropic key; it is saved to .env.local
npm run dev        # creates and migrates the local database on first use
```

Open **http://127.0.0.1:3000**.

You can open the app before adding a key. The workflow library works without one, and the chat explains how to connect a key.

## Configuring your API key

Model usage is billed to **your** Anthropic account. 100 Workflows uses `claude-opus-5-5` by default.

| What | How |
| --- | --- |
| Add or replace the key | `npm run setup`. Input is hidden and written to `.env.local` with owner-only (600) permissions. |
| Do it by hand | `cp .env.example .env.local`, then set `ANTHROPIC_API_KEY=sk-ant-...` |
| Verify the key | `npm run check:config`, or **Model & keys → Check connection** in the app. Both call Anthropic's free models endpoint, so they spend **no tokens**. |
| Use a different model | Set `WORKFLOWS_MODEL=...` in `.env.local`. |
| Apply changes | Restart `npm run dev`. Env files are read at startup. |

**How the key is protected**

- The key is read only by server code (`src/lib/server/*`, guarded by `server-only`). The browser receives just two facts: whether a key is set, and which model is configured.
- `.env.local` and every other `.env*` file except `.env.example` are git-ignored.
- Logs are structured JSON and redact anything that looks like a key or an auth header.
- The dev and production servers bind to `127.0.0.1`. API routes reject requests whose `Host` isn't localhost (protection against DNS rebinding), cross-origin POSTs, and non-JSON POSTs (`src/proxy.ts`).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the app at http://127.0.0.1:3000 with hot reload |
| `npm run build` && `npm start` | Production build, also bound to 127.0.0.1 |
| `npm run setup` | Interactive key setup |
| `npm run check:config` | Verify the key and model without spending credits |
| `npm run check` | Everything CI checks except the build: typecheck, tests, strict catalog validation, generated files |
| `npm run new:workflow` | Scaffold a workflow definition (add `--executable` for executor and test stubs) |
| `npm run catalog:validate` | Validate definitions, run search cases, report quality warnings (`-- --strict` fails on warnings) |
| `npm run catalog:search -- "query"` | Show how catalog search ranks workflows for a query |
| `npm run catalog:docs` | Regenerate `docs/catalog.md` |
| `npm run catalog:schema` | Regenerate the editor JSON Schemas in `catalog/` |
| `npm run db:migrate` | Create the database if needed and apply pending migrations |
| `npm test` | Run the Vitest suite |
| `npm run typecheck` | TypeScript check |

## Running workflows

1. In chat, tick recommended workflows and choose **Create package**.
2. Open **Setup** on the package and answer the questions. Shared business context (company, product, target market) is asked once, and every workflow that declares it reuses the answer.
3. Choose **Run package**. Before anything starts, the app checks each workflow: it is ready, needs input, will be skipped (definition only, or a tool is off), or is blocked (a workflow it requires can't run). Execution follows dependency order, one workflow at a time.
4. The **Run details** page refreshes every 2 seconds. It shows the step that is actually running, then each workflow's output, its quality checks per attempt, retries, token and search usage, and the full step trace. You can cancel a run.

### Executable workflows

| Workflow | What it does | Needs |
| --- | --- | --- |
| **Market Research Agent** (`market-research@0.2.0`) | Up to 5 web searches, then a structured report in which every finding, player and trend cites a retrieved source. A separate reviewer call grades the report. | `WORKFLOWS_WEB_SEARCH=on` |
| **Ideal Customer Profile Builder** (`icp-builder@0.2.0`) | Segments, firmographics, triggers, disqualifiers and personas. When Market Research ran first and was accepted, the profile builds on its sourced findings. | Nothing extra |

**Web search is opt-in.** Market Research uses Anthropic's server-side web search tool with the same API key, so you don't need another account. Anthropic bills searches separately from tokens, so the tool is off until you add `WORKFLOWS_WEB_SEARCH=on` to `.env.local` and restart. While it is off, Market Research is skipped with that explanation, and it never produces a report without sources. Your Anthropic organization must also allow web search (an admin enables it in the Anthropic Console). If it doesn't, the run fails and shows Anthropic's own error message.

### How results are judged

Each workflow run reports three separate things:

| | Meaning |
| --- | --- |
| **Status** | Did it execute? `Accepted`, `Needs review` (best attempt kept, but it didn't pass every check), `Failed`, `Blocked`, `Skipped`, `Cancelled` or `Interrupted`. |
| **Quality score** | The mean of the workflow's evaluation criteria for the chosen attempt: schema, rules and an optional model review. A failed **critical** criterion (for example, a finding citing a source that wasn't retrieved) rejects the attempt regardless of the average. |
| **Confidence** | A labelled heuristic based on the evidence: number of sources, distinct domains, cited passages, and the reviewer rating. It is not a probability, and the model's own claims about its confidence are never used. |

When an attempt fails its checks, the runtime retries the writing step with the specific failures as feedback, up to the workflow's `maxRetries` (2 for both). Searches are not repeated on a retry. Every model call counts against `maxModelCalls`, and a wall-clock `timeoutSeconds` applies. When retries or budget run out, the best attempt is kept as **Needs review**. Downstream workflows only receive **accepted** outputs.

## Local database

Conversations and packages are stored in SQLite at `data/100-workflows.db`. The `data/` folder is git-ignored. You don't need to install anything, because the database is a file created on first use.

- **Initialize or upgrade:** the app applies pending migrations automatically at startup. To do it explicitly, run `npm run db:migrate`.
- **Location:** set `WORKFLOWS_DB_PATH=/path/to/file.db` in `.env.local` to keep it elsewhere.
- **Reset:** stop the app and delete `data/100-workflows.db*`. This permanently removes your chats and packages.
- **Migrations** are numbered SQL files in [`migrations/`](migrations). Each runs once, inside a transaction. If an already-applied file is edited, the runner refuses to start, so a schema change always goes in a new file.
- **No secrets** are written to the database. Your API key only lives in `.env.local`.
- **Runs** are stored in `runs`, `workflow_runs`, `run_steps` and `evaluations`. A run that was in progress when the server stopped is marked **Interrupted** at the next start. Runs don't resume automatically; start a new one.

## How it works

```
Browser (React)                 Local Next.js server (127.0.0.1)              Anthropic
───────────────                 ─────────────────────────────────              ─────────
Chat ── POST /api/conversations/:id/messages ──▶ proxy.ts: Host / Origin / JSON checks
                                                store user message (SQLite)
                                                runChatTurn ── messages.create ─────▶ claude-opus-5-5
                                                   ▲  │ tool_use: search_catalog / recommend_workflows
                                                   │  ▼
                                                catalog/workflows/<category>/*.json (ids validated)
                                                ... up to 4 model calls per turn ...
                                                store reply + verified recommendations
     ◀── reply, selectable workflow cards, token usage ──
Tick cards ── POST /api/packages ──▶ resolve required dependencies, pin each definition, store package
```

- **Grounded recommendations.** The assistant can only learn about workflows through the `search_catalog` tool, which reads the real catalog. It records recommendations through a second tool, `recommend_workflows`. If that call contains any id that isn't in the catalog, the server rejects the whole call and tells the model which id was wrong. Workflow ids mentioned in the reply text are checked too: unknown ones get a visible warning and never become cards.
- **Packages.** Ticking recommended workflows and choosing *Create package* stores them with every required dependency added automatically, in dependency order. Each workflow is **pinned** to the exact definition it was added with (version and content hash). If the catalog later changes, the package shows "update available" and keeps the pinned copy until you choose *Update to latest* for that workflow. You can rename a package, edit its goal, and add or remove workflows. Removing a workflow that another one requires is blocked with an explanation. The workspace also lists everything the package will need: shared business context asked once, workflow-specific inputs, tools and integrations.
- **Bounded.** Each turn makes at most 4 model calls. The last allowed call disables tools so the model must answer.
- **Honest UI.** Token counts and call counts shown under each reply come from the API response. Nothing is simulated.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The workflow catalog

Browse it in the app's **Workflow library**, or on GitHub in **[docs/catalog.md](docs/catalog.md)**, which is generated.

Workflows are plain JSON files in `catalog/workflows/<category>/<id>.json`, validated with Zod ([`src/lib/catalog/schema.ts`](src/lib/catalog/schema.ts)). Each one declares its purpose, the problems it solves, inputs, outputs, steps (agents or deterministic checks), tools, integrations, dependencies, evaluation criteria and execution limits. Three shared files keep a growing catalog consistent:

| File | Purpose |
| --- | --- |
| [`catalog/shared-inputs.json`](catalog/shared-inputs.json) | Business context defined once (company, product, target market...). Definitions reference it with `{ "use": "company_name" }`, so a package asks for it only once. |
| [`catalog/tools.json`](catalog/tools.json) | Tool ids a definition may request, and whether the runtime provides them today. |
| [`catalog/search-cases.json`](catalog/search-cases.json) | Queries and the workflows they must find. These are tested, so adding workflows can't silently break search for existing ones. |

Adding a workflow means adding one JSON file. You don't touch the chatbot or the UI. Start with `npm run new:workflow`, and see **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[docs/adding-workflows.md](docs/adding-workflows.md)**.

## Project layout

```
catalog/                shared-inputs.json, tools.json, search-cases.json, generated *.schema.json
catalog/workflows/      Workflow definitions: <category>/<id>.json
migrations/             Numbered SQL migrations
scripts/                setup, check-config, validate-catalog, migrate
src/app/                Pages (chat, packages, library, settings) and API routes
src/components/         UI components
src/lib/catalog/        Schema, catalog builder, search (shared by server and browser)
src/lib/packages/       Package logic: dependencies, ordering, input merging and validation, pin status (pure)
src/lib/runtime/        Workflow runtime: engine, budget, evaluation, executors for runnable workflows
src/lib/server/         Server-only: config, Anthropic client, chat engine, services, logging
src/lib/server/db/      SQLite connection, migration runner, repositories
src/proxy.ts            Localhost and origin guard for /api/*
tests/                  Vitest suites
docs/                   Architecture, contributor guide, generated catalog index
.github/                CI workflow, PR and issue templates
```

## Roadmap

| Milestone | Scope | Status |
| --- | --- | --- |
| 1 | Local app, chat, model configuration, workflow catalog | ✅ done |
| 2 | Recommendations with selection, persistent packages, SQLite with migrations | ✅ done |
| 3 | Market Research Agent: execution, evaluation, bounded retries, saved results | ✅ done |
| 4 | Shared input collection, dependency ordering, a second connected workflow | ✅ done |
| 5 | Contributor tooling and catalog structure for 100+ workflows | ✅ this release |

## Known limitations

- Only two workflows can execute. The other 10 are definitions.
- Catalog search is keyword-based with light stemming. It is tested by `catalog/search-cases.json` and should hold up to a few hundred workflows. Beyond that, an embedding index may be worth adding.
- Runs execute inside the dev or production server process. Closing the server interrupts a run, and it can't resume.
- One run at a time per package. Different packages can run at the same time, which also spends credits in parallel.
- Cost is bounded by model-call counts, `max_tokens` and time limits per workflow. There is no dollar-denominated budget yet.
- Neither runnable workflow has external side effects (they only read the web and write text). Human approval gates for actions such as sending email are designed for (definitions declare integrations) but not yet built, so no workflow with side effects is executable.
- Confidence levels are coarse heuristics. Treat **Accepted** as "passed its checks", not "verified true". Research output is a starting point, not a substitute for expert research.
- Chat history from Milestone 1 (browser local storage) was not imported, and there is no button for deleting chats yet.
- Replies and runs are polled, not streamed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: `npm run new:workflow`, fill in the TODOs, add a search case, then run `npm run check`.

## License

MIT
