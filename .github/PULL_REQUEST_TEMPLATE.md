## What this changes

<!-- One or two sentences. -->

## Checklist

- [ ] `npm run check` passes (typecheck, tests, strict catalog validation, generated files)
- [ ] `npm run build` passes

**If this adds or changes a workflow definition**

- [ ] The file lives at `catalog/workflows/<category>/<id>.json` and has no TODOs
- [ ] Shared business context uses `{ "use": "..." }` from `catalog/shared-inputs.json`
- [ ] A query that should find it is in `catalog/search-cases.json`
- [ ] The version is bumped (patch for wording, minor for behavior changes)
- [ ] `docs/catalog.md` was regenerated with `npm run catalog:docs`

**If this makes a workflow executable**

- [ ] The executor is registered in `src/lib/runtime/executors/index.ts` for the definition's major.minor line
- [ ] Tests cover an accepted run, a retry with feedback, and an escalation
- [ ] The workflow has no external side effects, or this PR adds an approval gate for them
- [ ] Nothing in the output can come from the model alone that should have come from a tool (sources, records, numbers)
