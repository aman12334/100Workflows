# Adding a workflow

A workflow is a single JSON file in `catalog/workflows/<category>/`. The chat assistant, search, library and `docs/catalog.md` pick it up automatically. You don't need to change any application code. [CONTRIBUTING.md](../CONTRIBUTING.md) has the short version.

## 1. Create the file

```bash
npm run new:workflow -- --id churn-risk-review --name "Churn Risk Review" --category operations
```

This writes `catalog/workflows/operations/churn-risk-review.json` with `TODO`s to replace. The file name must match the id, and the folder must match the category. [`gtm/market-research.json`](../catalog/workflows/gtm/market-research.json) is a complete reference example.

The `$schema` line connects the file to `catalog/workflow.schema.json`, so editors such as VS Code autocomplete fields and underline mistakes as you type.

```jsonc
{
  "$schema": "../../workflow.schema.json",
  "id": "churn-risk-review",          // lowercase kebab-case, unique, never reused
  "version": "0.1.0",                 // semver: patch for wording, minor for behavior changes
  "name": "Churn Risk Review",
  "category": "operations",           // gtm | marketing | sales | finance | product | user-research | operations
  "summary": "One sentence, ≤200 chars, shown on cards.",
  "description": "A paragraph on what it does and what it does NOT do.",
  "status": "planned",                // keep "planned" until the runtime can execute it
  "problems": ["Customers cancel and I don't know why"],   // phrased the way a user would say it
  "tags": ["churn", "retention"],
  "inputs": [
    { "use": "company_name", "required": true },   // shared business context, from catalog/shared-inputs.json
    { "key": "churned_accounts", "label": "Churned accounts", "type": "long_text", "required": true,
      "description": "Accounts that cancelled recently, with any notes.", "example": "Brightline (cancelled in March): said reporting was too slow" }
  ],
  "outputs": [ ... ],
  "steps": [ ... ],
  "tools": [],
  "integrations": [],
  "dependencies": [],
  "evaluation": { "criteria": [ ... ], "threshold": 0.7 },
  "limits": { "maxRetries": 1, "timeoutSeconds": 180, "maxModelCalls": 6 }
}
```

(Comments are for illustration only. Real files must be plain JSON.)

## 2. Field guide

**`problems`**: write these the way users describe pain points ("I don't have a marketing team"). They carry heavy weight in search, so they decide when the assistant finds your workflow.

**`inputs`**: there are two kinds.
- **Shared business context** (company, product, target market, price point, research question) is defined once in [`catalog/shared-inputs.json`](../catalog/shared-inputs.json). Reference it with `{ "use": "<key>", "required": true|false }`. A package asks for it once and passes the answer to every workflow that uses it. Redefining one of these keys inline is an error. If several workflows need a new piece of context, add it to `shared-inputs.json` rather than marking a field `shared` yourself.
- **Workflow-specific inputs** have `key` (snake_case), `label`, `type` (`text`, `long_text`, `url`, `number`, `select`, `list`), `required`, `description` and, ideally, an `example`. The example becomes the placeholder in the setup form. `select` inputs need `options`.

**`steps`**: `kind: "agent"` is a model-driven step. `kind: "check"` is deterministic validation implemented by the app, never by the definition. Add a second agent only when a distinct role (for example, a critic) measurably improves the output. A step may list `tools`, but every tool it uses must also be declared in the top-level `tools` array.

**`tools`**: capabilities the runtime must provide, by id from [`catalog/tools.json`](../catalog/tools.json) (`web-search`, `web-fetch`). A definition can only *request* tools; it can never ship code. Unknown tool ids are an error. A tool listed with `"available": false` is known but not provided yet.

**`integrations`**: external accounts the workflow needs (CRM, email provider). Anything with external side effects will require human approval in the runtime.

**`dependencies`**: other workflows by id. `required: true` means "must run first". `required: false` means "uses its output if present". The catalog rejects unknown ids, self-dependencies and cycles.

**`evaluation`**: criteria with `method` set to `schema`, `rule` or `model`. Set `critical: true` when a failure must reject the output regardless of the overall score, for example invented sources or wrong numbers. `threshold` (0–1) is the minimum quality score to accept an output.

**`limits`**: hard bounds. `maxRetries` (0–3), `timeoutSeconds` (10–1800) and `maxModelCalls` (1–50) are enforced by schema validation.

## 3. Make it findable

Add a query that a user might type, and the workflows it must return, to [`catalog/search-cases.json`](../catalog/search-cases.json). `npm test` fails if a case's expected workflows aren't in the top results. To see how search ranks your workflow, run:

```bash
npm run catalog:search -- "customers keep cancelling"
```

## 4. Validate and regenerate

```bash
npm run catalog:validate -- --strict   # errors and quality warnings
npm run catalog:docs                   # refresh docs/catalog.md
npm test
```

`catalog:validate` lists every definition, then errors (the definition is skipped), search-case failures and warnings: placeholder text, fewer than 3 problems, no tags, required inputs without examples, no critical check besides the schema, no search case. `--strict` fails on warnings too, as CI does. At runtime, invalid files are skipped and listed at the top of the Library page, so one bad file never breaks the app.

## 5. Check it in the app

With `npm run dev` running, open `/library/<id>`. The catalog is re-read on every request, so you don't need to restart. Then ask the chat assistant about a problem your workflow solves and confirm it finds the workflow.

## 6. Making a workflow executable

A definition alone is discoverable and can be packaged, but it doesn't run. To make one run (`npm run new:workflow -- ... --executable` creates stubs for steps 1 and 4):

1. Write an executor in `src/lib/runtime/executors/<id>.ts` that implements `Executor` from `src/lib/runtime/engine.ts`:
   - `prepare` runs once (gathering, fetching).
   - `produce` creates one attempt. It receives feedback from failed checks on retries.
   - `check` returns one `CriterionResult` per criterion in the definition. `schema_valid` is added for you when `produce` parses cleanly.
   - `confidence` and `render` describe the accepted output.
   - `preflight` returns a reason when a required tool isn't configured.
   Wrap every model call in `ctx.step("<step id from the definition>", ...)` and make it through `ctx.call(...)`, so it is traced and counted against the budget.
2. Register it in `src/lib/runtime/executors/index.ts`. Its `versions` are major.minor lines (`["0.2"]`): patch releases of the definition run on the same code, while a minor bump needs the executor updated.
3. Set `"status": "available"` and bump the definition's version. Existing packages stay pinned to their version and show *Update to latest*.
4. Add tests with a scripted model (see `tests/runtime.test.ts` and `tests/runtime-helpers.ts`). Cover acceptance, a retry and escalation, and run `npm test`. A test fails if a definition is `available` without a matching executor.

Keep checks deterministic wherever possible. Use a model review only for judgments code can't make, and never let an executor invent tool results (sources, records) that a real tool didn't return.

## Rules for definitions

- Definitions are data. Never add code, prompts that instruct the assistant, or URLs that the runtime should trust.
- Don't mark a workflow `available` unless an executor for its major.minor line is registered. Tests enforce this.
- Don't claim capabilities the steps don't implement. Say what the workflow can't do in `description`.
