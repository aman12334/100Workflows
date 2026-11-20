import { describe, expect, it } from "vitest";
import type { JsonSchemaNode } from "@/lib/catalog/output-schema";
import { normalizeForQuote } from "@/lib/runtime/rules/builtin";
import { isBlank, select } from "@/lib/runtime/rules/path";
import { RULES, runRule, validateRuleRef, type RuleContext } from "@/lib/runtime/rules/registry";

const obj = (properties: Record<string, JsonSchemaNode>, required: string[] = Object.keys(properties)): JsonSchemaNode => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const str: JsonSchemaNode = { type: "string" };
const strings: JsonSchemaNode = { type: "array", items: str };

/** One schema covering the three pilot workflows' shapes. */
const schema = obj(
  {
    questions: { type: "array", items: obj({ text: str, tests: strings, rationale: str, analysis: str }, ["text"]) },
    steps: { type: "array", items: obj({ action: str, owner: str }) },
    facts: { type: "array", items: obj({ statement: str, evidence: str }) },
    hypotheses: { type: "array", items: obj({ id: str, statement: str }) },
    tags: strings,
    summary: str,
    score: { type: "integer" },
  },
  [],
);

const ctx = (output: unknown, inputs: Record<string, unknown> = {}): RuleContext => ({ output, inputs, upstream: {} });
const run = (id: string, params: unknown, output: unknown, inputs: Record<string, unknown> = {}) => runRule({ id, params }, ctx(output, inputs));
const target = { outputSchema: schema, inputKeys: ["max_questions", "prospect", "prospect_notes"] };

describe("select", () => {
  const output = { questions: [{ text: "Q1", tests: ["H1", "H2"] }, { text: "Q2", tests: [] }, { text: "Q3" }] };

  it("walks properties and array items", () => {
    expect(select(output, "").values).toEqual([output]);
    expect(select(output, "questions").values).toEqual([output.questions]);
    expect(select(output, "questions[].text").values).toEqual(["Q1", "Q2", "Q3"]);
    expect(select(output, "questions[].tests[]").values).toEqual(["H1", "H2"]);
  });

  it("counts places where a value was expected but absent", () => {
    expect(select(output, "questions[].tests")).toEqual({ values: [["H1", "H2"], []], missing: 1 });
    expect(select({ questions: "oops" }, "questions[]")).toEqual({ values: [], missing: 1 });
    expect(select(null, "questions")).toEqual({ values: [], missing: 1 });
  });

  it("never reads inherited properties", () => {
    expect(select({}, "constructor").values).toEqual([]);
  });

  it("throws on malformed paths, which catalog validation should have caught", () => {
    expect(() => select(output, "questions[0]")).toThrow(/Malformed rule path/);
  });

  it("treats blank text and empty lists as blank", () => {
    expect([undefined, null, "", "  ", []].every(isBlank)).toBe(true);
    expect([0, false, "x", [1]].some(isBlank)).toBe(false);
  });
});

describe("registry", () => {
  it("registers the Phase 0-4 rules with permanent ids", () => {
    expect(Object.keys(RULES).sort()).toEqual(["cites_sources", "count", "distinct", "max_words", "numbers_from_calculation", "quoted_from_sources", "references", "required_fields", "valid_action_payloads", "verbatim_in_inputs"]);
    expect(Object.isFrozen(RULES)).toBe(true);
  });

  it("rejects unknown rules and invalid params when the catalog loads", () => {
    expect(validateRuleRef({ id: "vibes", params: {} }, target)[0]).toMatch(/unknown rule "vibes" \(available: cites_sources, count, distinct/);
    expect(validateRuleRef({ id: "count", params: { path: "questions" } }, target)).toEqual(['rule "count" params: set min, max or maxFromInput']);
    expect(validateRuleRef({ id: "count", params: { path: "questions", min: 5, max: 2 } }, target)).toEqual(['rule "count" params: min is greater than max']);
    expect(validateRuleRef({ id: "count", params: { path: "questions", max: 3, extra: 1 } }, target)[0]).toMatch(/Unrecognized key/);
  });

  it("checks paths exist in the output schema and have a usable type", () => {
    expect(validateRuleRef({ id: "count", params: { path: "answers", max: 3 } }, target)).toEqual([
      'rule "count" path: "answers" does not exist in the output schema',
    ]);
    expect(validateRuleRef({ id: "count", params: { path: "summary", max: 3 } }, target)).toEqual([
      'rule "count" path: "summary" is a string, but this rule needs array',
    ]);
    expect(validateRuleRef({ id: "count", params: { path: "questions[0]", max: 3 } }, target)[0]).toMatch(/is not a valid path/);
    expect(validateRuleRef({ id: "references", params: { from: "questions[].tests", to: "hypotheses[].id" } }, target)).toEqual([
      'rule "references" from: "questions[].tests" is an array, but this rule needs string',
    ]);
  });

  it("checks inputs the rule reads are declared", () => {
    expect(validateRuleRef({ id: "count", params: { path: "questions", maxFromInput: "question_cap" } }, target)).toEqual([
      'rule "count" reads input "question_cap", which the workflow doesn\'t declare',
    ]);
    expect(validateRuleRef({ id: "verbatim_in_inputs", params: { path: "facts[].evidence", inputs: ["prospect", "linkedin"] } }, target)).toHaveLength(1);
  });

  it("runs rule-specific static checks", () => {
    expect(validateRuleRef({ id: "required_fields", params: { path: "steps[]", fields: ["owner", "deadline"] } }, target)).toEqual([
      'rule "required_fields": field "deadline" is not a property of steps[]',
    ]);
  });

  it("accepts the references the three pilot workflows will use", () => {
    for (const ref of [
      { id: "count", params: { path: "questions", min: 1, max: 10, maxFromInput: "max_questions" } },
      { id: "required_fields", params: { path: "questions[]", fields: ["rationale", "analysis"] } },
      { id: "required_fields", params: { path: "steps[]", fields: ["owner", "action"] } },
      { id: "verbatim_in_inputs", params: { path: "facts[].evidence", inputs: ["prospect", "prospect_notes"] } },
      { id: "references", params: { from: "questions[].tests[]", to: "hypotheses[].id", everyTargetReferenced: true } },
      { id: "max_words", params: { path: "questions[].text", max: 25 } },
      { id: "distinct", params: { path: "hypotheses[].id" } },
      { id: "distinct", params: { path: "score" } },
    ]) {
      expect(validateRuleRef(ref, target), ref.id).toEqual([]);
    }
  });

  it("throws at run time for references that skipped validation", () => {
    expect(() => run("vibes", {}, {})).toThrow(/Unknown rule/);
    expect(() => run("count", { path: "questions" }, {})).toThrow();
  });
});

describe("count", () => {
  const questions = (n: number) => ({ questions: Array.from({ length: n }, (_, i) => ({ text: `Q${i + 1}` })) });
  const params = { path: "questions", min: 1, max: 10, maxFromInput: "max_questions" };

  it("passes within bounds and says where the limit came from", () => {
    expect(run("count", params, questions(8))).toEqual({ passed: true, score: 1, detail: "8 items in questions (at least 1, at most 10)." });
    expect(run("count", params, questions(4), { max_questions: 5 }).detail).toBe("4 items in questions (at least 1, at most 5 (your max_questions setting)).");
  });

  it("fails over the maximum with partial credit, preferring the user's input over the default", () => {
    expect(run("count", params, questions(14))).toMatchObject({ passed: false, detail: "14 items in questions; must be at most 10." });
    expect(run("count", params, questions(14)).score).toBeCloseTo(10 / 14);
    expect(run("count", params, questions(8), { max_questions: 5 })).toMatchObject({ passed: false, detail: "8 items in questions; must be at most 5 (your max_questions setting)." });
    expect(run("count", params, questions(8), { max_questions: "6" }).passed).toBe(false);
  });

  it("ignores unusable input values and falls back to the default", () => {
    for (const bad of [-1, 2.5, "lots", "", null]) {
      expect(run("count", params, questions(10), { max_questions: bad }).passed, String(bad)).toBe(true);
    }
  });

  it("fails under the minimum and when the list is missing", () => {
    expect(run("count", params, questions(0))).toEqual({ passed: false, score: 0, detail: "0 items in questions; needs at least 1." });
    expect(run("count", { path: "questions", min: 4 }, questions(2)).score).toBe(0.5);
    expect(run("count", params, {})).toEqual({ passed: false, score: 0, detail: '"questions" is missing from the output.' });
  });
});

describe("required_fields", () => {
  const params = { path: "steps[]", fields: ["owner", "action"] };

  it("passes when every item fills in every field", () => {
    expect(run("required_fields", params, { steps: [{ action: "Export", owner: "Finance" }] }).passed).toBe(true);
  });

  it("names the incomplete items and gives partial credit", () => {
    const r = run("required_fields", params, {
      steps: [{ action: "Export", owner: "Finance" }, { action: "Check", owner: "  " }, { owner: "Ops" }, "not an object"],
    });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.25);
    expect(r.detail).toBe("1/4 items in steps[] are complete: item 2 is missing owner, item 3 is missing action, item 4 is missing owner and action.");
  });

  it("passes vacuously on an empty list (use count to require items)", () => {
    expect(run("required_fields", params, { steps: [] })).toEqual({ passed: true, score: 1, detail: "No items in steps[] to check." });
  });
});

describe("verbatim_in_inputs", () => {
  const params = { path: "facts[].evidence", inputs: ["prospect", "prospect_notes"] };
  const inputs = { prospect: "Dana Lee, COO at Brightline", prospect_notes: "Booked after our post on month-end close.\nMentioned   “spreadsheets everywhere” twice." };

  it("finds quotes despite case, curly quotes, extra spaces and surrounding punctuation", () => {
    const r = run("verbatim_in_inputs", params, { facts: [{ evidence: "COO at Brightline" }, { evidence: '"Mentioned "spreadsheets everywhere" twice."' }] }, inputs);
    expect(r).toEqual({ passed: true, score: 1, detail: "All 2 quotes appear word-for-word in your prospect or prospect_notes." });
  });

  it("fails invented evidence and says which quote", () => {
    const r = run("verbatim_in_inputs", params, { facts: [{ evidence: "COO at Brightline" }, { evidence: "Their CFO wants a demo next week" }] }, inputs);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
    expect(r.detail).toMatch(/1\/2 quotes found word-for-word: "Their CFO wants a demo next week" is not in your prospect or prospect_notes/);
  });

  it("rejects quotes too short to prove anything", () => {
    const r = run("verbatim_in_inputs", params, { facts: [{ evidence: "COO" }] }, inputs);
    expect(r).toMatchObject({ passed: false, score: 0 });
    expect(r.detail).toMatch(/"COO" is too short to verify/);
    expect(run("verbatim_in_inputs", { ...params, minChars: 3 }, { facts: [{ evidence: "COO" }] }, inputs).passed).toBe(true);
  });

  it("can't be satisfied by missing inputs, and reads list inputs", () => {
    expect(run("verbatim_in_inputs", params, { facts: [{ evidence: "COO at Brightline" }] }, {}).passed).toBe(false);
    expect(run("verbatim_in_inputs", { path: "facts[].evidence", inputs: ["prospect"] }, { facts: [{ evidence: "second line of notes" }] }, { prospect: ["first line", "second line of notes"] }).passed).toBe(true);
  });

  it("passes when no facts are claimed", () => {
    expect(run("verbatim_in_inputs", params, { facts: [] }, inputs).passed).toBe(true);
  });

  it("normalizes text consistently", () => {
    expect(normalizeForQuote("  “Hello,   World!”  ")).toBe('hello, world');
  });
});

describe("references", () => {
  const params = { from: "questions[].tests[]", to: "hypotheses[].id", everyTargetReferenced: true };
  const hypotheses = [{ id: "H1" }, { id: "H2" }];

  it("passes when every reference exists and every target is tested", () => {
    expect(run("references", params, { hypotheses, questions: [{ tests: ["H1"] }, { tests: ["H2", "H1"] }] })).toEqual({
      passed: true,
      score: 1,
      detail: "Every reference in questions[].tests[] exists, and all 2 ids in hypotheses[].id are referenced.",
    });
  });

  it("fails dangling references and untested targets with partial credit", () => {
    const r = run("references", params, { hypotheses, questions: [{ tests: ["H1", "H9"] }] });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5); // 4 checks: H1 ok, H9 dangling, H1 referenced, H2 not
    expect(r.detail).toBe("H9 is referenced in questions[].tests[] but not defined in hypotheses[].id; H2 in hypotheses[].id is never referenced from questions[].tests[].");
  });

  it("only checks dangling references unless everyTargetReferenced is set", () => {
    expect(run("references", { from: params.from, to: params.to }, { hypotheses, questions: [{ tests: ["H1"] }] }).passed).toBe(true);
    expect(run("references", { from: params.from, to: params.to }, { hypotheses, questions: [] }).detail).toBe("No references in questions[].tests[] to check.");
  });

  it("fails when targets exist but nothing references them", () => {
    expect(run("references", params, { hypotheses, questions: [] })).toMatchObject({ passed: false, score: 0 });
  });
});

describe("max_words", () => {
  it("names texts over the limit", () => {
    const r = run("max_words", { path: "questions[].text", max: 4 }, { questions: [{ text: "Short one" }, { text: "This question is far too long" }] });
    expect(r).toEqual({ passed: false, score: 0.5, detail: "1/2 texts in questions[].text are within 4 words: item 2 has 6." });
    expect(run("max_words", { path: "summary", max: 3 }, { summary: "  three   words here " }).passed).toBe(true);
  });
});

describe("distinct", () => {
  it("catches repeats, ignoring case and spacing by default", () => {
    const r = run("distinct", { path: "hypotheses[].id" }, { hypotheses: [{ id: "H1" }, { id: "h1 " }, { id: "H2" }] });
    expect(r.passed).toBe(false);
    expect(r.score).toBeCloseTo(2 / 3);
    expect(r.detail).toBe('hypotheses[].id repeats "h1" ×2.');
    expect(run("distinct", { path: "hypotheses[].id", caseSensitive: true }, { hypotheses: [{ id: "H1" }, { id: "h1" }] }).passed).toBe(true);
  });

  it("passes unique values", () => {
    expect(run("distinct", { path: "tags[]" }, { tags: ["a", "b"] }).passed).toBe(true);
  });
});

describe("determinism and safety", () => {
  it("gives the same result for the same output every time", () => {
    const output = { hypotheses: [{ id: "H1" }], questions: [{ tests: ["H2"] }] };
    const results = Array.from({ length: 3 }, () => run("references", { from: "questions[].tests[]", to: "hypotheses[].id" }, output));
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("clamps scores to 0..1 and never returns NaN", () => {
    for (const id of Object.keys(RULES)) {
      const params =
        id === "count" ? { path: "questions", max: 1 } :
        id === "required_fields" ? { path: "steps[]", fields: ["owner"] } :
        id === "verbatim_in_inputs" ? { path: "facts[].evidence", inputs: ["prospect"] } :
        id === "references" ? { from: "questions[].tests[]", to: "hypotheses[].id" } :
        id === "max_words" ? { path: "summary", max: 1 } :
        id === "quoted_from_sources" ? { path: "facts[]", sourceField: "evidence", quoteField: "evidence" } :
        id === "numbers_from_calculation" ? { path: "summary" } :
        id === "valid_action_payloads" ? { path: "steps[]", action: "slack.post_message@1" } : { path: "tags[]" };
      for (const output of [{}, null, "junk", { questions: [], steps: [], facts: [], tags: [] }]) {
        const r = run(id, params, output);
        expect(r.score, `${id} ${JSON.stringify(output)}`).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
        expect(typeof r.detail).toBe("string");
      }
    }
  });
});
