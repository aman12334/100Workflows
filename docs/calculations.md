# Calculations: registry, numerical policy and adding a calculation

Calculation workflows never let a model produce a number. Numbers come from **registered, versioned, deterministic calculations** in `src/lib/runtime/calc/`; the model only reads the user's data into the calculation's input (when it is a table in free text) and explains the results. The formulas, units, rounding and assumptions of every calculation are listed in [catalog.md › Calculation reference](catalog.md#calculation-reference), generated from the registry.

## How a calculation workflow runs

```
prepare (once)
  extract (optional, model)   reads tables/free text into the calculation's input schema
    └─ provenance check        every extracted number must appear in what the user typed (else retry once, then fail)
  calculate (check step)       runs "<id>@<version>" from the allowlist → results, warnings, formulas, units
per attempt (engine loop, unchanged)
  explain (generate, model)    explains <calculation_results>; adds no numbers
  check_explanation            numbers_from_calculation: every number in the text must match a result or input
```

- Typed inputs (numbers, selects, number lists) go straight into the calculation through the definition's `inputs` map. No model is involved, and nothing is guessed: "about a thousand" in a number field fails with a clear reason.
- Extraction and calculation run once. Retries only rewrite the explanation, so the calculation is never repeated or changed.
- The stored result is `{ calculation: { id, version, input, output, units, formulas, assumptions, rounding }, explanation }`. The markdown shows the calculated tables, warnings and "How this was calculated" before the explanation.
- **If the explanation fails** (model error, invalid output on every attempt, or budget), the calculated results are still returned, with `explanation: null` and the reason, and the run ends as *Needs review* (the engine's `salvage` hook).
- Every calculation run is logged as a tool call (`calculation:<id>`, version, status, timing, sizes) in the existing `tool_calls` table. No migration was needed.

## Numerical policy

| Topic | Policy |
| --- | --- |
| Representation | IEEE-754 doubles (about 15 significant digits). Inputs are bounded to ±1e12. Money that must sum exactly (budget lines, MRR schedules) is computed in integer cents. |
| Rounding | Half away from zero, applied once when a value is reported, using a decimal-string method that avoids the `1.005 → 1.00` float error. Each calculation states its rounding (for example money 2 dp, months 1 dp, whole units rounded up). |
| Division by zero | Never Infinity or NaN: the value is `null` and a warning says why (for example "CAC is 0, so LTV:CAC is undefined"). |
| Invalid input | Rejected, not coerced: numbers must be numbers, counts whole numbers, percentages within range, amounts with at most 2 decimals where exactness matters, and enums exact. The reason is shown to the user. |
| Missing data | Optional inputs that are missing leave the dependent results `null` with a warning. Missing observations (cohorts, supplier metrics) are excluded from both numerator and denominator and never treated as zero. |
| Units | Every result field has a declared unit. Time units are converted explicitly before combining (week = 7 days, month = 30.4375 days). |
| Statistics | Significance is only assessed when samples meet the stated minimum (≥ 10 conversions and non-conversions per arm). Forecast accuracy is only claimed after a holdout test (history ≥ 8). |
| Reproducibility | Calculations are pure functions: no clock, randomness, I/O or model calls. The same input always gives the same output. |

## The registry and runner

- `types.ts`: the `CalculationDefinition` contract: id, version, name, strict Zod input and output, units, formulas, assumptions, rounding, `maxItems` (size budget) and `run()`.
- `registry.ts`: the allowlist, `CALCULATIONS[id][version]`. A version never changes meaning; new behaviour gets a new version, and pinned definitions keep theirs.
- `runner.ts`: `runCalculation(ref, input)`. It checks the allowlist and version, validates input (strict, no unknown fields), enforces the size budget, honours cancellation, runs the calculation, rejects non-finite output, validates output against its schema, and logs the run.
- `numbers.ts`: rounding, cents conversion, safe division, the normal CDF, z tables and strict input building blocks.

## Adding a calculation

1. Write a `CalculationDefinition` in `src/lib/runtime/calc/` with a strict input schema (ranges, no coercion), an output schema, units for every result field, formulas, assumptions and a rounding policy. Return `null` plus a warning for undefined values; throw `CalcError` for invalid input.
2. Register it in `registry.ts` as a new id, or a new version of an existing id.
3. Unit-test it with **independently computed** expected values (by hand or another tool, written in as literals): normal, boundary, zero, negative, missing, invalid, precision and division-by-zero cases. See `tests/calculations.test.ts`.
4. Use it from a workflow (below), then run `npm run catalog:docs` to add it to the reference.

## Writing a calculation workflow

```jsonc
"steps": [
  { "id": "read_data", "kind": "agent", "mode": "extract", "prompt": "Read each line ...", ... },   // only for tables in free text
  { "id": "calculate", "kind": "check", "responsibility": "...",
    "calculate": { "calculation": "budget_variance@1",
                   "inputs": { "currency": { "input": "currency", "as": "text" } } } },        // number | text | number_list
  { "id": "explain", "kind": "agent", "mode": "generate", "prompt": "Explain ..." },
  { "id": "check_explanation", "kind": "check", ... }
],
"evaluation": { "criteria": [
  { "id": "schema_valid", "method": "schema", "critical": true, ... },
  { "id": "summary_numbers", "method": "rule", "critical": true,
    "rule": { "id": "numbers_from_calculation", "step": "check_explanation", "params": { "path": "summary" } } }
] }
```

The catalog checks the following when it loads:
- the calculation is registered at that version;
- every mapped field exists with a compatible input type;
- every required field is mapped or an extract step exists;
- the steps are in order: extract, then calculate, then generate;
- a critical `numbers_from_calculation` rule exists;
- `maxModelCalls` covers the extract step (up to 2 calls) plus the explanation attempts.

Test with a fixture in `tests/fixtures/phase3/<id>.json`. It needs `inputs`, `extracted` (the scripted extract reply), `expected` values worked out independently, a `good` explanation and a `bad` one that invents a number. [`tests/phase3-workflows.test.ts`](../tests/phase3-workflows.test.ts) then covers:
- acceptance against the expected values;
- an invented number;
- the explanation model failing;
- invalid explanations;
- cancellation;
- unreadable inputs;
- the run service.
