# 100 Workflows

**Describe a business problem in chat, then discover the agentic workflows that solve it.**

100 Workflows is an open-source, local-first app. You run it on your own computer, connect your own Anthropic or OpenAI API key, and talk to an assistant that searches a catalog of workflow definitions across go-to-market, marketing, sales, finance, product, user research and operations. It explains which workflows fit your goal and what each one needs.

> **Status: Phase 5 is done.** The catalog has **100 workflows**; **93 can run**, and 7 are *definition only*, which the app says wherever they appear.
>
> - Two runnable workflows are hand-written (**Market Research Agent**, **Ideal Customer Profile Builder**); the other 91 run on the schema-v2 generic executor straight from their JSON definitions.
> - **48** work from what you type in.
> - **20 research workflows** search the web and read pages with read-only tools, and keep every source with the result.
> - **13 calculation workflows** compute their numbers in tested code and use the model only to explain them.
> - **10 integration workflows** read from and propose changes to email, CRM, calendar, tasks, Slack, invoices, social posts and tickets. Every action waits for your approval of its exact payload and runs once. Approvals are dry runs until you turn real actions on.
>
> Around them: discovery filters, run history with retry, a basic workflow builder, workspace context and file uploads, audit logs, optional sign-in and a health check.

---

## Quick start

**Prerequisites:** Node.js 20.9 or newer, npm, and an [Anthropic API key](https://console.anthropic.com/settings/keys) or an [OpenAI API key](https://platform.openai.com/api-keys). No database, Docker or other accounts are needed.

```bash
git clone https://github.com/aman12334/100Workflows.git
cd 100Workflows
npm install
npm run setup      # paste your Anthropic key; it is saved to .env.local (for OpenAI, see below)
npm run dev        # creates and migrates the local database on first use
```

Open **http://127.0.0.1:3000**.

You can open the app before adding a key. The workflow library works without one, and the chat explains how to connect a key.

## Configuring your API key

Bring a key from **Anthropic** or **OpenAI**. Model usage is billed to that account.

| Provider | Key variable | Default model | Notes |
| --- | --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-5-5` | Everything works, including web search for Market Research |
| OpenAI | `OPENAI_API_KEY` | `gpt-6.1-sol` | Everything except web search: Market Research and the research workflows that search are skipped (web search is Anthropic-only for now); workflows that read pages you link work |

The app uses whichever key is set. With both set, Anthropic wins, unless you add `WORKFLOWS_PROVIDER=openai` (or `anthropic`).

| What | How |
| --- | --- |
| Add an Anthropic key | `npm run setup`. Input is hidden and written to `.env.local` with owner-only (600) permissions. |
| Add an OpenAI key | Add `OPENAI_API_KEY=sk-...` to `.env.local` |
| Do it by hand | `cp .env.example .env.local`, then fill in one key |
| Verify the key | `npm run check:config`, or **Model & keys → Check connection** in the app. Both call the provider's free models endpoint, so they spend **no tokens**. |
| Use a different model | Set `WORKFLOWS_MODEL=...` in `.env.local`. |
| Apply changes | Restart `npm run dev`. Env files are read at startup. |

**How the key is protected**

- The key is read only by server code (`src/lib/server/*`, guarded by `server-only`). The browser receives just two facts: whether a key is set, and which model is configured.
- `.env.local` and every other `.env*` file except `.env.example` are git-ignored.
- Logs are structured JSON and redact anything that looks like an Anthropic or OpenAI key, or an auth header.
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
4. The **Run details** page refreshes every 2 seconds. It shows the step that is actually running, then each workflow's output, its quality checks per attempt, retries, the full step trace with each step's duration and token usage, and a usage summary for the whole run. You can cancel a run.

### Executable workflows

| Workflow | What it does | Needs |
| --- | --- | --- |
| **Market Research Agent** (`market-research@0.2.0`) | Up to 5 web searches, then a structured report in which every finding, player and trend cites a retrieved source. A separate reviewer call grades the report. | `WORKFLOWS_WEB_SEARCH=on` |
| **Ideal Customer Profile Builder** (`icp-builder@0.2.0`) | Segments, firmographics, triggers, disqualifiers and personas. When Market Research ran first and was accepted, the profile builds on its sourced findings. | Nothing extra |
| **Survey Designer** (`survey-designer@0.2.0`) | A short survey with a rationale and analysis method for every question, then a bias-review rewrite. Code checks your question limit, missing rationales and repeats. | Nothing extra |
| **SOP Writer** (`sop-writer@0.2.0`) | A numbered procedure with an owner and a check for every step, failure modes and assumptions. A reviewer call grades whether anything you didn't say is listed as an assumption. | Nothing extra |
| **Discovery Call Prep** (`discovery-call-prep@0.2.0`) | Facts, hypotheses, questions mapped to each hypothesis, and qualification criteria. A "fact" must quote your notes word for word, so guesses can't pass as facts. Uses an accepted ICP when it ran first. | Nothing extra |

The last three are schema-v2 definitions that run on the generic executor: their prompts, output schema and checks are data in the JSON file, with no workflow-specific code. All of them run on either provider except Market Research, which needs Anthropic's web search.

**45 more model-only workflows** (Phase 1) run the same way, from PRDs, launch plans and battlecards to postmortems, OKRs and vendor scorecards. [docs/catalog.md](docs/catalog.md#workflow-details) lists each one with who it is for, its inputs, output, checks and limitations. They work only from what you type in and from the model's general knowledge: none of them searches the web, reads files or contacts another system, and outputs label what you supplied apart from what the model assumed.

**20 research workflows** (Phase 2) retrieve evidence before writing: company research, news digests, due diligence, regulation research, vendor shortlists, fact-checking, review mining, SEO page audits, privacy-policy reviews, API feasibility reviews and more. Fourteen search the web (Anthropic only) and read the top results; six read only the pages you link and work with either provider. Every claim cites a retrieved source, quotes are checked word for word against the page text, and the result lists every source with how it was retrieved, plus pages that could not be accessed. They need research tools turned on:

```bash
# .env.local
WORKFLOWS_WEB_SEARCH=on   # web search through Anthropic (billed per search by Anthropic)
WORKFLOWS_WEB_FETCH=on    # read public web pages from this computer (GET only, public addresses only)
```

How the tools work, their limits and the security model: [docs/tools.md](docs/tools.md).

**13 calculation workflows** (Phase 3) do the maths in code, not in the model: unit economics, break-even, revenue forecast, budget variance, investment return, conversion funnel, cohort retention, acquisition efficiency, A/B test results, inventory reorder point, demand forecast, supplier scorecard and workforce capacity. Each runs a registered, versioned calculation with documented formulas, units and rounding. The model only explains the results, and a check rejects any number in its explanation that the calculation did not produce. If the explanation fails, you still get the calculated results. See [docs/calculations.md](docs/calculations.md).

**10 integration workflows** (Phase 4) work with other services: Email Campaign Executor (Resend), CRM Contact Manager, CRM Deal Pipeline Updater and Customer Support Ticket Manager (HubSpot), Calendar Meeting Coordinator (Google Calendar), Meeting Notes & Follow-up Agent and Project Task Manager (Linear), Slack Communication Agent, Invoice & Payment Follow-up Agent (Stripe read-only, plus Resend), and Social Media Publishing Agent (Mastodon).

- They read what they need, draft, and **propose** actions. Nothing is sent or changed until you approve an action's exact payload on the run page.
- Each approval runs once and is recorded with your name and the provider's result.
- Approvals are **dry runs** until you set `WORKFLOWS_ACTIONS=live`.
- None is connected by default: each needs its own credentials in `.env.local`.

See [docs/integrations.md](docs/integrations.md).

**Around the workflows** (Phase 5):
- **Library filters:** by what a workflow needs (model only, web research, calculations, apps) and by tag.
- **Run history:** search and filters, per-workflow outcomes, and **Retry failed**, which re-runs only what didn't succeed and reuses identical accepted results.
- **Workflow builder:** for your own model-only workflows (`/builder`).
- **Context & files:** saved context and uploaded TXT/CSV/DOCX/XLSX/PDF text that you can insert into any long text input.
- **Security:** optional sign-in (`WORKFLOWS_ACCESS_TOKEN`), audit logs in Settings → Security, and `/api/health`.

See [docs/api.md](docs/api.md), [docs/security.md](docs/security.md) and [docs/deployment.md](docs/deployment.md).

**Web search is opt-in.** Market Research uses Anthropic's server-side web search tool with the same API key, so you don't need another account. Anthropic bills searches separately from tokens, so the tool is off until you add `WORKFLOWS_WEB_SEARCH=on` to `.env.local` and restart. While it is off, Market Research is skipped with that explanation, and it never produces a report without sources. Your Anthropic organization must also allow web search (an admin enables it in the Anthropic Console). If it doesn't, the run fails and shows Anthropic's own error message.

### How results are judged

Each workflow run reports three separate things:

| | Meaning |
| --- | --- |
| **Status** | Did it execute? `Accepted`, `Needs review` (best attempt kept, but it didn't pass every check), `Failed`, `Blocked`, `Skipped`, `Cancelled` or `Interrupted`. |
| **Quality score** | The mean of the workflow's evaluation criteria for the chosen attempt: schema, rules and an optional model review. A failed **critical** criterion (for example, a finding citing a source that wasn't retrieved) rejects the attempt regardless of the average. |
| **Confidence** | A labelled heuristic based on the evidence: number of sources, distinct domains, cited passages, and the reviewer rating. It is not a probability, and the model's own claims about its confidence are never used. |

When an attempt fails its checks, the runtime retries the writing step with the specific failures as feedback, up to the workflow's `maxRetries` (1 or 2, depending on the workflow). Searches are not repeated on a retry. Every model call counts against `maxModelCalls`, and a wall-clock `timeoutSeconds` applies. When retries or budget run out, the best attempt is kept as **Needs review**. Downstream workflows only receive **accepted** outputs.

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
src/lib/runtime/        Workflow runtime: engine, budget, evaluation, rules, pricing, generic and hand-written executors
src/lib/server/         Server-only: config, Anthropic client, chat engine, services, logging
src/lib/server/db/      SQLite connection, migration runner, repositories
src/lib/integrations/   Providers, versioned actions, side-effect classes, HTTP core (timeouts, retries, rate limits)
src/lib/files/          Dependency-free text extraction for uploads (TXT/CSV/DOCX/XLSX/PDF)
src/proxy.ts            Localhost and origin guard for /api/*, optional sign-in
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
| 5 | Contributor tooling and catalog structure for 100+ workflows | ✅ done |
| 6–10 | Schema v2 and the generic executor, three migrated workflows, run usage and cost estimates | ✅ done |
| Phase 1 | 45 new model-only workflows on the generic executor (57 in the catalog, 50 executable) | ✅ done |
| Phase 2 | Shared read-only tool layer (web search, page reading), 20 research workflows with checked citations (77 in the catalog, 70 executable) | ✅ done |
| Phase 3 | Registered deterministic calculation layer and 13 calculation workflows (90 in the catalog, 83 executable) | ✅ done |
| Phase 4 | Integration layer with approval gates, 7 providers, 10 integration workflows (100 in the catalog, 93 executable) | ✅ done |
| Phase 5 | Discovery filters, run history and retry, builder, workspace context and files, audit, sign-in, health, API and deployment docs | ✅ this release |

## Known limitations

- 93 workflows can execute. The other 7 are definitions. Calculation workflows use simple, documented methods (flat baseline forecasts, a normal-approximation z-test, cycle-service-level safety stock) and cannot read spreadsheets directly: paste figures as text or use the typed inputs. The 45 Phase 1 workflows are model-only. The 20 research workflows read public web pages only: no PDFs, no pages that need JavaScript or a login, no paywalled content, and many review sites block automated reading. Search coverage depends on what Anthropic's web search returns that day. Web search cost is not estimated (no verified price), and page reads run on your computer. All Phase 1 and Phase 2 workflows have been tested with scripted model responses and canned pages, not yet against a live model or the live web.
- There are no separate categories for customer success, HR or strategy yet: those workflows live under Sales and Operations.
- Catalog search is keyword-based with light stemming. It is tested by `catalog/search-cases.json` and should hold up to a few hundred workflows. Beyond that, an embedding index may be worth adding.
- Runs execute inside the dev or production server process. Closing the server interrupts a run, and it can't resume.
- One run at a time per package. Different packages can run at the same time, which also spends credits in parallel.
- Cost is bounded by model-call counts, `max_tokens` and time limits per workflow. There is no dollar-denominated budget yet. Run details show an **estimated** cost only for models with a verified list price (current Claude models, excluding Haiku 5.5's tiered pricing). It excludes web search charges and caching discounts. OpenAI runs show token usage without a cost estimate, because no verified OpenAI price is recorded.
- Integration workflows have been tested only against **mocked** providers (canned HTTP responses). No real provider was called while building them, so try each one with a low-risk action before relying on it. Approvals are dry runs until `WORKFLOWS_ACTIONS=live`. Supported:
  - Resend, HubSpot, Slack, Google Calendar (with a refresh token you obtain yourself), Linear, Stripe (read-only) and Mastodon;
  - no X, LinkedIn or Bluesky publishing, no HubSpot ticket assignment, no attachments.
- Single user: no accounts or roles. Optional sign-in is one shared token. Context, files and audit events are stored per workspace, but there is one workspace per installation. Don't host publicly; see [docs/deployment.md](docs/deployment.md).
- File reading is basic:
  - PDF text only (scanned PDFs need OCR, which isn't supported; unusual font encodings may not decode);
  - spreadsheet dates show as serial numbers;
  - only the extracted text is kept.
- Builder workflows are model-only (no tools, calculations or integrations) and are local to the computer they were made on.
- Confidence levels are coarse heuristics. Treat **Accepted** as "passed its checks", not "verified true". Research output is a starting point, not a substitute for expert research.
- Chat history from Milestone 1 (browser local storage) was not imported, and there is no button for deleting chats yet.
- Replies and runs are polled, not streamed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: `npm run new:workflow`, fill in the TODOs, add a search case, then run `npm run check`.

## License

MIT
