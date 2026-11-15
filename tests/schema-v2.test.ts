import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "@/lib/catalog/catalog";
import { loadCatalog } from "@/lib/catalog/load";
import { ManifestSchema, WorkflowSchema, type Workflow } from "@/lib/catalog/schema";
import { definitionHash } from "@/lib/server/db/packages";
import { buildFixture, discoveryData, problemsFor, sopData, surveyData } from "./fixtures/generic";
import { entry } from "./fixtures";

/**
 * Fingerprints recorded with definitionHash() from the unchanged code, before any
 * schema-v2 field existed (2026-11-15). If one of these changes, every package that
 * pinned that definition would show "definition changed".
 */
const GOLDEN: Record<string, string> = {
  "runway-forecast@0.1.1": "cf4048ce4c3c9549f199c2a96a117cca7104f7dfa352a9a01e15446f4fd147ba",
  "pricing-analysis@0.1.1": "8fd76a22257c27e8071f4432df488f1fbc3a68293c01243cf634087356b07cb2",
  "icp-builder@0.2.1": "9ee678259d8cb7e86b4150f4182e046f6eeacfcde7eb91eaa8536b05f4687e5b",
  "market-research@0.2.2": "f231184128e088a30208dbde63d216a59e478a29133c31241c782d18d7c77979",
  "competitor-teardown@0.1.1": "e04f2502f28f9d6b2460c857f01c141580c8060d49ac20cd143ed33fd7e74100",
  "content-calendar@0.1.1": "6734a38eea3f9044857704f0b95f52f428bd01578f2a4ca8ac5b15be67774cb1",
  "sop-writer@0.1.0": "28feb40036d286537afb087c3777cece3d579613b87d9f0d36c19f6a5161728a",
  "feature-prioritization@0.1.0": "3560ae98149aaecef3d8d9761738b9a46b4aa59226df10cd67521188fd773c09",
  "outbound-sequence@0.1.1": "b276c16cbcc70a3c72ff56cc9786c84945a150296b5cdd0e0777b902fc74d768",
  "discovery-call-prep@0.1.0": "6dd1e307ed7d317f7ce07a37d16df45f5d1d1bdacc74e2f522b91fb899919bf8",
  "interview-synthesis@0.1.1": "4455904f9f0ccd4dcee2ed1b688699e1093fe0b7a781b979e50e887c5f0c04a1",
  "survey-designer@0.1.1": "630fd86d4d089634cf1b73bbe52c9424f0f47298dac8e68bc83fc7696345b742",
};

/** The v1 files of the three migrated pilots, kept verbatim: packages created before the migration pinned these. */
const SNAPSHOT_DIR = path.join(process.cwd(), "tests", "fixtures", "v1-snapshots");
const MIGRATED = ["discovery-call-prep", "sop-writer", "survey-designer"];

/** Fingerprints of the migrated pilots as committed in Phase 0; later phases must not change them. */
const PILOTS_V2: Record<string, string> = {
  "discovery-call-prep@0.2.0": "b5deabebbe65443b05c164966c791fd030cfb712893e7926f87351b530d2d153",
  "sop-writer@0.2.0": "f5af5df105e09483109c53da0ce91acaec8c51f0ff461862cfa770c8a56391a3",
  "survey-designer@0.2.0": "9593e4c07cc34980fe53e56e94ad7c8927ffb0ca781e301f627e1c9769a6b28b",
};

let catalog: Workflow[];
/** Every v1 definition: the catalog's current v1 files plus the pre-migration pilot snapshots. */
let v1: Workflow[];
beforeAll(async () => {
  catalog = (await loadCatalog()).workflows;
  const snapshots: Workflow[] = [];
  for (const file of readdirSync(SNAPSHOT_DIR).sort()) {
    // Built through the real catalog builder and registry, exactly as when they were current.
    snapshots.push(await buildFixture(JSON.parse(readFileSync(path.join(SNAPSHOT_DIR, file), "utf8"))));
  }
  v1 = [...catalog.filter((w) => w.schemaVersion !== 2), ...snapshots];
});

describe("backward compatibility: fingerprints", () => {
  it("keeps every v1 definition's fingerprint identical to the recorded golden hash", () => {
    const now = Object.fromEntries(v1.map((w) => [`${w.id}@${w.version}`, definitionHash(w)]));
    expect(now).toEqual(GOLDEN);
  });

  it("migrated the three pilots to new versions, so pinned v1 snapshots are never reinterpreted", () => {
    const migrated = catalog.filter((w) => MIGRATED.includes(w.id));
    expect(Object.fromEntries(migrated.map((w) => [`${w.id}@${w.version}`, definitionHash(w)]))).toEqual(PILOTS_V2);
    for (const wf of migrated) expect(Object.hasOwn(GOLDEN, `${wf.id}@${wf.version}`), wf.id).toBe(false);
    expect(readdirSync(SNAPSHOT_DIR).sort()).toEqual(MIGRATED.map((id) => `${id}.json`));
  });

  it("adds no schema-v2 keys to v1 definitions", () => {
    expect(v1).toHaveLength(12);
    for (const wf of v1) {
      for (const key of ["schemaVersion", "execution", "outputSchema"]) expect(Object.hasOwn(wf, key), `${wf.id}.${key}`).toBe(false);
      for (const st of wf.steps) for (const key of ["prompt", "mode"]) expect(Object.hasOwn(st, key), `${wf.id} step ${st.id}.${key}`).toBe(false);
      for (const c of wf.evaluation.criteria) for (const key of ["rule", "review"]) expect(Object.hasOwn(c, key), `${wf.id} ${c.id}.${key}`).toBe(false);
    }
  });

  it("re-validates a stored snapshot to the same object and fingerprint, as getPackage() does", () => {
    for (const wf of [...catalog, ...v1]) {
      const stored = JSON.stringify(wf); // what package_workflows.definition_json holds
      const reparsed = WorkflowSchema.parse(JSON.parse(stored));
      expect(reparsed).toEqual(wf);
      expect(definitionHash(reparsed)).toBe(createHash("sha256").update(stored).digest("hex"));
    }
  });
});

describe("schema-v2 structure", () => {
  it("rejects v2-only fields on v1 definitions", () => {
    const v1 = entry({
      steps: [{ id: "do_it", name: "Do it", kind: "agent", mode: "generate", prompt: "Hi there", responsibility: "Does it.", tools: [] }],
      evaluation: { criteria: [{ id: "valid", description: "Valid.", method: "rule", rule: { id: "count", params: {} } }], threshold: 0.7 },
    });
    const messages = buildCatalog([v1]).errors.map((e) => e.message);
    expect(messages).toEqual([
      'steps.0.prompt: "prompt" requires "schemaVersion": 2',
      'steps.0.mode: "mode" requires "schemaVersion": 2',
      'evaluation.criteria.0.rule: "rule" requires "schemaVersion": 2',
    ]);
  });

  it("requires execution and outputSchema together with schemaVersion 2", () => {
    const messages = buildCatalog([entry({ schemaVersion: 2 })]).errors.map((e) => e.message);
    expect(messages).toEqual([
      'execution: schemaVersion 2 definitions need an "execution" section',
      'outputSchema: schemaVersion 2 definitions need an "outputSchema"',
    ]);
  });

  it("reports output-schema problems at their location in the definition", async () => {
    const problems = await problemsFor(surveyData, { outputSchema: { type: "object", required: [], properties: { a: { $ref: "#/x", type: "string" } } } });
    expect(problems).toEqual([
      "outputSchema.additionalProperties: must be false so outputs can't carry unexpected fields",
      "outputSchema.properties.a.$ref: references are not supported; write the object inline",
    ]);
  });

  it("accepts the three pilot fixtures, and the editor schema accepts v2 files", async () => {
    for (const data of [surveyData, sopData, discoveryData]) {
      expect(await problemsFor(data), data.id).toEqual([]);
      expect(ManifestSchema.safeParse(data).success, data.id).toBe(true);
    }
  });
});

describe("validateGenericDefinition", () => {
  const criteria = (extra: unknown[]) => ({
    criteria: [{ id: "schema_valid", description: "Output matches the schema.", method: "schema", critical: true }, ...extra],
    threshold: 0.7,
  });

  it("keeps Phase 0 free of tools and integrations", async () => {
    expect(await problemsFor(surveyData, { integrations: [{ id: "crm", name: "CRM", purpose: "Sync", required: true }] })).toContain(
      'generic workflows can\'t use integrations yet; remove "integrations"',
    );
    const withTool = await problemsFor(surveyData, {
      tools: [{ id: "web-search", purpose: "Search", required: true }],
      steps: surveyData.steps.map((s) => (s.id === "draft" ? { ...s, tools: ["web-search"] } : s)),
    });
    expect(withTool).toContain('generic workflows can\'t use tools yet; remove "tools" or use a hand-written executor');
  });

  it("requires exactly one generate step, before any revise", async () => {
    const reviseFirst = surveyData.steps.map((s) => (s.id === "draft" ? { ...s, mode: "revise" } : s.id === "bias_review" ? { ...s, mode: "generate" } : s));
    expect(await problemsFor(surveyData, { steps: reviseFirst })).toContain('the first producing step must have "mode": "generate"');
    const twoGenerates = surveyData.steps.map((s) => (s.id === "bias_review" ? { ...s, mode: "generate" } : s));
    expect(await problemsFor(surveyData, { steps: twoGenerates })).toContain('only one step can "generate"; later producing steps must "revise"');
  });

  it("requires a critical schema_valid criterion and no other schema criteria", async () => {
    expect(await problemsFor(surveyData, { evaluation: { ...surveyData.evaluation, criteria: surveyData.evaluation.criteria.slice(1) } })).toContain(
      'generic workflows need a critical "schema_valid" criterion with method "schema"',
    );
    const extra = criteria([{ id: "looks_right", description: "Looks right.", method: "schema" }]);
    expect(await problemsFor(sopData, { evaluation: extra })).toContain('criterion "looks_right": only "schema_valid" can use method "schema"');
  });

  it("wires every rule criterion to a known, valid rule in a check step", async () => {
    const run = (extra: unknown[]) => problemsFor(surveyData, { evaluation: criteria([...surveyData.evaluation.criteria.slice(1), ...extra]) });
    expect(await run([{ id: "x", description: "No rule.", method: "rule" }])).toContain(
      'criterion "x": method "rule" needs a "rule" (one of count, distinct, max_words, references, required_fields, verbatim_in_inputs)',
    );
    expect((await run([{ id: "x", description: "Bad.", method: "rule", rule: { id: "vibes", params: {} } }]))[0]).toMatch(/criterion "x": unknown rule "vibes"/);
    expect(await run([{ id: "x", description: "Bad path.", method: "rule", rule: { id: "count", params: { path: "answers", max: 3 } } }])).toContain(
      'criterion "x": rule "count" path: "answers" does not exist in the output schema',
    );
    expect(await run([{ id: "x", description: "Bad input.", method: "rule", rule: { id: "count", params: { path: "questions", maxFromInput: "limit" } } }])).toContain(
      'criterion "x": rule "count" reads input "limit", which the workflow doesn\'t declare',
    );
    expect(await run([{ id: "x", description: "Bad step.", method: "rule", rule: { id: "count", step: "draft", params: { path: "questions", max: 3 } } }])).toContain(
      'criterion "x": rule step "draft" must be a "check" step',
    );
    expect(await run([{ id: "x", description: "Wrong field.", method: "rule", rule: { id: "count", params: { path: "questions", max: 3 } }, review: { step: "draft", rubric: "Hmm" } }])).toContain(
      'criterion "x": a rule criterion can\'t have a review',
    );
  });

  it("wires every model criterion to a review step", async () => {
    const run = (review: unknown, steps = sopData.steps) =>
      problemsFor(sopData, { steps, evaluation: criteria([sopData.evaluation.criteria[1], { id: "graded", description: "Graded.", method: "model", review }]) });
    expect(await run(undefined)).toContain('criterion "graded": method "model" needs a "review" with a step and rubric');
    expect(await run({ step: "nowhere", rubric: "Good?" })).toContain('criterion "graded": review step "nowhere" is not declared');
    expect(await run({ step: "draft", rubric: "Good?" })).toContain('criterion "graded": review step "draft" must be an agent step without a mode');
  });

  it("rejects steps that would never run", async () => {
    const unusedReview = await problemsFor(sopData, { evaluation: criteria([sopData.evaluation.criteria[1]]) });
    expect(unusedReview).toContain('agent step "review" has no mode and no review uses it; give it "mode" or remove it');
    const unusedCheck = await problemsFor(surveyData, { evaluation: criteria([]) });
    expect(unusedCheck).toContain('check step "check_survey" runs no rules; remove it or point a rule at it');
  });

  it("rejects a check step with a prompt or mode", async () => {
    const steps = surveyData.steps.map((s) => (s.id === "check_survey" ? { ...s, prompt: "Do it" } : s));
    expect(await problemsFor(surveyData, { steps })).toContain('step "check_survey" is a check step, so it can\'t have a mode or prompt');
  });

  it("rejects definitions where one attempt can't fit the model-call budget", async () => {
    expect(await problemsFor(surveyData, { limits: { ...surveyData.limits, maxModelCalls: 1 } })).toEqual([
      "one attempt needs 2 model calls, but limits.maxModelCalls is 1",
    ]);
  });
});
