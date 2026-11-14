import { describe, expect, it } from "vitest";
import {
  OUTPUT_SCHEMA_LIMITS,
  OutputSchemaSpec,
  outputSchemaProblems,
  parsePath,
  schemaAt,
  toZod,
  type JsonSchemaNode,
} from "@/lib/catalog/output-schema";

/** The discovery-call-prep output from the Phase 0 proposal: a realistic, nested schema. */
const brief: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["prospect_summary", "facts", "hypotheses", "questions"],
  properties: {
    prospect_summary: { type: "string", title: "Prospect", minLength: 1 },
    facts: {
      type: "array",
      title: "What we know",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "evidence"],
        properties: { statement: { type: "string" }, evidence: { type: "string", description: "Exact words from the notes" } },
      },
    },
    hypotheses: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "statement", "confidence"],
        properties: { id: { type: "string" }, statement: { type: "string" }, confidence: { type: "string", enum: ["low", "medium", "high"] } },
      },
    },
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "tests"],
        properties: { text: { type: "string" }, tests: { type: "array", items: { type: "string" } }, priority: { type: "integer", minimum: 1, maximum: 3 } },
      },
    },
    notes: { type: "string" },
    urgent: { type: "boolean" },
  },
};

const validBrief = {
  prospect_summary: "Dana Lee, COO at Brightline",
  facts: [{ statement: "Uses spreadsheets", evidence: "mentioned spreadsheets" }],
  hypotheses: [{ id: "H1", statement: "Month-end close is slow", confidence: "medium" }],
  questions: [{ text: "How long does close take?", tests: ["H1"], priority: 1 }],
};

const messages = (value: unknown) => outputSchemaProblems(value).map((p) => `${p.path || "(root)"}: ${p.message}`);

describe("outputSchemaProblems: accepted shapes", () => {
  it("accepts a nested schema using every supported keyword", () => {
    expect(outputSchemaProblems(brief)).toEqual([]);
  });

  it("allows optional properties (not listed in required)", () => {
    expect(outputSchemaProblems({ type: "object", additionalProperties: false, required: [], properties: { a: { type: "string" } } })).toEqual([]);
  });
});

describe("outputSchemaProblems: rejected shapes, with precise locations", () => {
  const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "object",
    additionalProperties: false,
    required: [],
    properties,
    ...extra,
  });

  it("rejects non-objects and non-object roots", () => {
    expect(messages("nope")).toEqual(["(root): must be a schema object"]);
    expect(messages([])).toEqual(["(root): must be a schema object"]);
    expect(messages({ type: "array", items: { type: "string" } })).toContain('type: the top level must be an object ("type": "object")');
  });

  it("requires closed objects", () => {
    expect(messages({ type: "object", required: [], properties: { a: { type: "string" } } })).toEqual([
      "additionalProperties: must be false so outputs can't carry unexpected fields",
    ]);
    expect(messages(obj({ a: { type: "string" } }, { additionalProperties: true }))).toHaveLength(1);
  });

  it("explains unsupported JSON Schema features", () => {
    expect(messages(obj({ a: { $ref: "#/x", type: "string" } }))).toEqual(["properties.a.$ref: references are not supported; write the object inline"]);
    expect(messages(obj({ a: { type: "string", oneOf: [] } }))[0]).toMatch(/unions are not supported/);
    expect(messages(obj({ a: { type: "string", format: "email" } }))[0]).toMatch(/check formats with a rule/);
    expect(messages(obj({ a: { type: "string", maxItems: 3 } }))).toEqual(['properties.a.maxItems: "maxItems" is not allowed on a string schema']);
  });

  it("rejects unknown types and missing properties", () => {
    expect(messages(obj({ a: { type: "date" } }))).toEqual(["properties.a.type: must be one of object, array, string, number, integer, boolean"]);
    expect(messages(obj({ a: { type: "null" } }))[0]).toMatch(/must be one of/);
    expect(messages({ type: "object", additionalProperties: false, required: [], properties: {} })).toEqual(["properties: must list at least one property"]);
  });

  it("checks required lists against declared properties", () => {
    expect(messages(obj({ a: { type: "string" } }, { required: ["a", "b"] }))).toEqual(['required: "b" is not a declared property']);
    expect(messages(obj({ a: { type: "string" } }, { required: ["a", "a"] }))).toEqual(['required: lists "a" twice']);
    expect(messages(obj({ a: { type: "string" } }, { required: "a" }))).toEqual(["required: must be an array of property names"]);
  });

  it("requires snake_case property names", () => {
    expect(messages(obj({ nextSteps: { type: "string" } }))).toEqual(["properties.nextSteps: property names must be snake_case, e.g. next_steps"]);
  });

  it("validates array, string and number bounds", () => {
    expect(messages(obj({ a: { type: "array" } }))).toEqual(["properties.a.items: is required for arrays"]);
    expect(messages(obj({ a: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 1 } }))).toEqual(["properties.a.minItems: is greater than maxItems"]);
    expect(messages(obj({ a: { type: "array", items: { type: "string" }, maxItems: -1 } }))).toEqual(["properties.a.maxItems: must be a non-negative integer"]);
    expect(messages(obj({ a: { type: "string", enum: [] } }))).toEqual(["properties.a.enum: must be a non-empty list of strings"]);
    expect(messages(obj({ a: { type: "string", enum: ["x", "x"] } }))).toEqual(["properties.a.enum: contains duplicates"]);
    expect(messages(obj({ a: { type: "string", minLength: 5, maxLength: 2 } }))).toEqual(["properties.a.minLength: is greater than maxLength"]);
    expect(messages(obj({ a: { type: "integer", minimum: 5, maximum: 1 } }))).toEqual(["properties.a.minimum: is greater than maximum"]);
    expect(messages(obj({ a: { type: "number", minimum: "1" } }))).toEqual(["properties.a.minimum: must be a finite number"]);
  });

  it("enforces size limits so schemas stay cheap and safe to walk", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < OUTPUT_SCHEMA_LIMITS.maxDepth; i++) deep = { type: "array", items: deep };
    expect(messages(obj({ a: deep })).join("\n")).toMatch(/nesting is deeper than 6 levels/);

    const many = Object.fromEntries(Array.from({ length: OUTPUT_SCHEMA_LIMITS.maxProperties + 1 }, (_, i) => [`p${i}`, { type: "string" }]));
    expect(messages(obj(many))).toContain("properties: has more than 50 properties");
  });

  it("reports every problem, not just the first", () => {
    expect(messages(obj({ BadName: { type: "string", enum: [] }, b: { type: "array" } }))).toHaveLength(3);
  });
});

describe("OutputSchemaSpec (Zod field for definitions)", () => {
  it("passes a valid schema through unchanged", () => {
    expect(OutputSchemaSpec.parse(brief)).toEqual(brief);
  });

  it("turns problems into Zod issues with their paths", () => {
    const result = OutputSchemaSpec.safeParse({ type: "object", required: [], properties: { a: { type: "array" } } });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.path.join("."))).toEqual(["additionalProperties", "properties.a.items"]);
  });
});

describe("toZod", () => {
  const validate = toZod(brief);

  it("accepts a valid output, including omitted optional fields", () => {
    expect(validate.safeParse(validBrief).success).toBe(true);
  });

  it("enforces required fields, enums, array bounds and closed objects", () => {
    const { facts: _omit, ...missing } = validBrief;
    expect(validate.safeParse(missing).success).toBe(false);
    expect(validate.safeParse({ ...validBrief, hypotheses: [{ ...validBrief.hypotheses[0], confidence: "certain" }] }).success).toBe(false);
    expect(validate.safeParse({ ...validBrief, questions: [] }).success).toBe(false);
    expect(validate.safeParse({ ...validBrief, hypotheses: Array(6).fill(validBrief.hypotheses[0]) }).success).toBe(false);
    expect(validate.safeParse({ ...validBrief, extra: 1 }).success).toBe(false);
    expect(validate.safeParse({ ...validBrief, facts: [{ ...validBrief.facts[0], source: "web" }] }).success).toBe(false);
  });

  it("enforces string length, integer and numeric bounds", () => {
    expect(validate.safeParse({ ...validBrief, prospect_summary: "" }).success).toBe(false);
    expect(validate.safeParse({ ...validBrief, questions: [{ ...validBrief.questions[0], priority: 1.5 }] }).success).toBe(false);
    expect(validate.safeParse({ ...validBrief, questions: [{ ...validBrief.questions[0], priority: 4 }] }).success).toBe(false);
  });

  it("reports the failing location", () => {
    const r = validate.safeParse({ ...validBrief, questions: [{ text: "Q", tests: [7] }] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(["questions", 0, "tests", 0]);
  });

  it("caches by content, since the catalog re-reads definitions on every request", () => {
    expect(toZod(structuredClone(brief))).toBe(validate);
  });

  it("refuses schemas outside the supported subset", () => {
    expect(() => toZod({ type: "object", properties: {}, required: [], additionalProperties: false })).toThrow(/Invalid output schema/);
  });
});

describe("parsePath and schemaAt", () => {
  it("parses the path language", () => {
    expect(parsePath("")).toEqual([]);
    expect(parsePath("questions[].tests")).toEqual([
      { kind: "property", name: "questions" },
      { kind: "items" },
      { kind: "property", name: "tests" },
    ]);
    expect(parsePath("matrix[][]")).toEqual([{ kind: "property", name: "matrix" }, { kind: "items" }, { kind: "items" }]);
  });

  it("rejects malformed paths", () => {
    for (const bad of ["questions[0]", "questions.", ".questions", "Questions", "questions[", "a..b", "[]"]) {
      expect(parsePath(bad), bad).toBeNull();
    }
  });

  it("resolves paths to schema nodes", () => {
    expect(schemaAt(brief, "")).toBe(brief);
    expect(schemaAt(brief, "questions")).toMatchObject({ type: "array" });
    expect(schemaAt(brief, "questions[]")).toMatchObject({ type: "object" });
    expect(schemaAt(brief, "questions[].tests")).toMatchObject({ type: "array" });
    expect(schemaAt(brief, "questions[].tests[]")).toEqual({ type: "string" });
    expect(schemaAt(brief, "facts[].evidence")).toMatchObject({ type: "string" });
  });

  it("returns null for paths that don't exist in the schema", () => {
    expect(schemaAt(brief, "answers")).toBeNull();
    expect(schemaAt(brief, "questions.text")).toBeNull(); // forgot [] on an array
    expect(schemaAt(brief, "prospect_summary[]")).toBeNull(); // [] on a string
    expect(schemaAt(brief, "facts[].evidence.words")).toBeNull();
    expect(schemaAt(brief, "constructor")).toBeNull(); // no prototype lookups
    expect(schemaAt(brief, "questions[0]")).toBeNull();
  });
});
