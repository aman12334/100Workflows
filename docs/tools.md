# Tools: architecture, security and adding a tool

Research workflows retrieve information with **registered, read-only tools**. Definitions name tools and describe what to retrieve; they never carry code. All tool execution goes through one runner, so every rule below applies to every call.

## The tools

| Id | Version | What it does | Needs | Per-run limit |
| --- | --- | --- | --- | --- |
| `web-search` | 1.0.0 | The provider's built-in web search, run inside a budgeted model call: Anthropic's server-side tool or OpenAI's `web_search` (Responses API, capped with `max_tool_calls`). Returns result URLs and titles, plus page-quoted passages with Anthropic. OpenAI's citations point into the model's own answer, so they are used for URLs and titles only, never as quotes. | A model key and `WORKFLOWS_WEB_SEARCH=on` (searches are billed by the provider); with OpenAI, research workflows also need `WORKFLOWS_WEB_FETCH=on` | 1 search request (up to 5 searches) |
| `web-fetch` | 1.0.0 | Reads one public web page on this computer (GET only) and extracts its readable text, title, publisher, date and headings. | `WORKFLOWS_WEB_FETCH=on`; works with either provider | `maxPages` from the definition, at most 10 |

Both are off until turned on in `.env.local`. A workflow whose required tools are off is skipped with the reason, never run without them.

## How a research workflow runs

```
prepare (once)                                         per attempt (engine loop, unchanged)
  gather step ─▶ web-fetch: URLs from inputs           write (generate/revise) ─▶ rules ─▶ review ─▶ accept / retry / escalate
             ─▶ web-search (model call with server tool)        ▲ sources fenced in <source> tags
             ─▶ web-fetch: top N search results                 │ rules see the retrieved text
             ─▶ sources S1..Sn + unavailable list ──────────────┘
```

- **Gather runs once.** Retries rewrite the output with feedback; they never repeat searches or page reads, so every attempt is judged against the same evidence.
- **Source ids are deterministic:** pages from your URLs first, then search results (those with cited passages first). Each source records `via: "page"` (read in full) or `via: "search_result"` (only the search engine's title and cited passages are known).
- **No sources, no output.** If nothing usable is retrieved, the workflow fails with the reasons (for example "the server answered 404"); it never writes from model memory.
- **Evidence is kept.** The accepted result stores `retrieved_sources` (id, URL, title, publisher, date, how it was retrieved, a short excerpt) and `unavailable_sources` (URL and reason). The markdown ends with a Sources list and a "Could not be accessed" list.

## The runner (`src/lib/runtime/tools/runner.ts`)

Every call to `ToolRunner.run(stepId, toolId, input)` is checked in this order:

1. **Allowlist:** the tool is registered in `TOOLS`, the workflow declares it in `tools`, and the calling step lists it.
2. **Availability:** the tool's opt-in flag and provider requirements are met.
3. **Budget:** the per-run limit (the smaller of the tool's own and the definition's) is not used up.
4. **Input:** validated against the tool's Zod schema. Unknown fields are rejected, so neither the model nor a user value can add headers, methods or other options.
5. **Execution:** a per-attempt timeout and the run's cancellation signal. Only errors the tool marks retryable (timeouts, connection resets, 5xx, 429) are retried, with backoff.
6. **Output:** validated against the tool's output schema; malformed results are errors and are never passed to the model.
7. **Log:** one record per call: tool id and version, status, error kind, attempts, target (URL or search request), start and finish times, duration, input and output size. Stored in the `tool_calls` table (migration `005`) and shown in each workflow's trace on the run page.

Budget exhaustion, time limits and cancellation from model calls inside a tool are logged and then handed to the engine, which decides the outcome as for any other workflow.

## Security model

| Risk | Control |
| --- | --- |
| Arbitrary code or shell | Definitions are JSON and can only name registered tools; there is no code or shell tool. The model never chooses a tool or its arguments for `web-fetch`; URLs come from your inputs or from search results the API returned. |
| SSRF / internal network access | `checkUrl()`: http(s) only, no credentials in URLs, ports 80/443 only, local and reserved names (`localhost`, `.local`, `.internal`, …) and private, loopback, link-local, CGNAT, multicast and documentation IPs refused (IPv4, IPv6 and IPv4-mapped forms). |
| DNS rebinding | The transport resolves the hostname itself, refuses the connection if **any** resolved address is not public, and connects to the address it checked. |
| Redirect tricks | At most 3 redirects, followed manually; every target goes through the same checks. |
| Huge or binary responses | 2 MB limit (compressed and decompressed), 15 s timeout, only text-like content types (HTML, text, XML, JSON). PDFs and other files are reported as unsupported. |
| Prompt injection from web pages | Page text is wrapped in `<source>` tags; anything in it that looks like a closing or opening prompt tag is escaped. The system prompt says retrieved text is untrusted and must never be followed. Citation rules check output against the retrieved text, so an injected "cite S99" fails. |
| Unsupported claims | `cites_sources` and `quoted_from_sources` (critical in every research workflow) check that cited ids were retrieved and that quotes appear word for word in the cited source; `requireRead` additionally rejects sources only seen as search results. |
| Credentials | Tools read no secrets except the provider key the model client already uses; nothing is sent in headers; targets in logs are URLs or search requests, and logs are redacted as before. |
| Side effects | Every tool is `read_public_web`: GET requests and searches only. Integrations and actions are rejected for generic workflows. |

## Adding a tool

1. Implement a `ToolDefinition` in `src/lib/runtime/tools/registry.ts` (or a file it imports): `id`, `version`, `permission`, input and output Zod schemas, `timeoutMs`, `retry`, `maxCallsPerRun`, `availability(env)`, `target(input)`, `execute(input, env)` and `retryable(err)`. Read-only only in this phase.
2. Add it to `TOOLS` and to `catalog/tools.json` (the catalog's list of tool ids), with how to turn it on.
3. Teach the gather step to use it (`src/lib/runtime/executors/research.ts` and `GatherSchema`), and validation to accept it (`validateGenericDefinition`).
4. Test it with a fake transport or scripted model: success, invalid input, failure, timeout, cancellation, retries, budget, malformed output (see `tests/tools.test.ts`). Tests never touch the real network.

Changing what an existing tool does means a new version; the version is recorded with every call.
