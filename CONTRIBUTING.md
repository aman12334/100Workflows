# Contributing to 100 Workflows

Thanks for helping. Most contributions are **workflow definitions**: JSON files that need no application code. This guide covers those first, then executable workflows and app changes.

## Setup

```bash
nvm use            # Node 22 (see .nvmrc); Node 20.9+ also works
npm install
npm run check      # typecheck, tests, strict catalog validation, generated files
```

You don't need an API key to work on the catalog or the tests. Every test uses a scripted fake model.

## Adding a workflow definition

```bash
npm run new:workflow                     # asks a few questions
npm run new:workflow -- --id churn-review --name "Churn Review" --category operations
```

This creates `catalog/workflows/<category>/<id>.json` full of `TODO`s. It is a schema-v2 definition for the generic executor, so once it is finished it runs without any TypeScript. The file is schema-valid, so you can open the app and see it in the library straight away. `--strict` validation refuses it until every TODO is replaced.

1. **Fill it in.** Your editor validates the file and offers autocomplete through its `$schema` line. The field guide is in [docs/adding-workflows.md](docs/adding-workflows.md).
2. **Reuse shared inputs.** Business context such as `company_name`, `product_description` and `target_market` is defined once in `catalog/shared-inputs.json`. Reference it with `{ "use": "company_name", "required": true }`, so a package asks for it only once. To add a new shared field, add it to that file. Redefining a shared key inline is an error.
3. **Use known tools.** Tool ids must exist in `catalog/tools.json`. Adding a tool there doesn't make the runtime provide it, so mark it `"available": false` until it does.
4. **Make it findable.** Add a query a user might type to `catalog/search-cases.json`. To see how search ranks your workflow, run `npm run catalog:search -- "your query"`.
5. **Check and regenerate:**

   ```bash
   npm run catalog:validate -- --strict
   npm run catalog:docs
   ```

### What the validator enforces

| Errors (the definition is skipped) | Warnings (`--strict` and CI fail on them) |
| --- | --- |
| Schema violations, including unknown fields | Placeholder text (TODO/TBD) |
| File name ≠ id, or folder ≠ category | Fewer than 3 problem statements |
| Duplicate ids, unknown or cyclic dependencies | No tags |
| Unknown `use` keys, or shared keys redefined inline | Required free-text input without an example |
| Tool ids not in `catalog/tools.json` | No critical check besides the schema |
| Steps using tools they don't declare | Not covered by any search case |
| Schema v2: an `outputSchema` outside the supported subset | `available` while needing a tool the runtime lacks |
| Schema v2: unknown rules, rule paths missing from the output schema, unwired steps or reviews, or an attempt that doesn't fit `maxModelCalls` | |

### Versioning

Packages pin the exact definition a user added, and show *Update to latest* when it changes. Bump the patch version for wording or examples (`0.1.0 → 0.1.1`). Bump the minor version when inputs, outputs, steps, prompts, the output schema or checks change. Hand-written executors declare the major.minor line they implement (`"0.2"`), so a patch release runs on the same code. Generic definitions carry their own configuration, so any version runs exactly as it was pinned.

## Making a workflow executable

Most workflows need no code: write the schema-v2 `execution`, `outputSchema`, step prompts and rule or review criteria ([docs/adding-workflows.md § 6](docs/adding-workflows.md#6-running-on-the-generic-executor-schema-v2)), add a run-service test with scripted model responses (see `tests/run-service-generic.test.ts`), and set `"status": "available"`.

Workflows that need tools or custom checks get a hand-written executor ([§ 7](docs/adding-workflows.md#7-workflows-that-need-code-hand-written-executors)):

```bash
npm run new:workflow -- --id <id> --name "<Name>" --category <category> --executable
```

This creates a v1 definition, an executor stub and a test stub. Implement the executor, register it in `src/lib/runtime/executors/index.ts`, set `"status": "available"`, and write tests with the scripted model helpers in `tests/runtime-helpers.ts`.

The bar for executable workflows:

- **Bounded.** Every model call goes through `ctx.call` and every phase through `ctx.step`. The engine enforces retries, call counts and time limits.
- **Honest.** Facts that should come from a tool (sources, records, numbers) must come from that tool's real output, and code checks them. If the tool is missing or returns nothing, fail with a clear reason.
- **No unapproved side effects.** Nothing that sends, posts or writes to an outside system can run until the runtime has an approval gate for it.
- **Tested.** Cover an accepted run, a retry with feedback, and an escalation.

## App changes

- Keep the simplest thing that works. Add abstraction when a second real use appears, not before.
- `npm run check` and `npm run build` must pass.
- The API key must never reach the browser, logs or the database.
- Don't show numbers or states in the UI that didn't come from a real run.
