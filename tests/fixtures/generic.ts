import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildCatalog, type RawEntry } from "@/lib/catalog/catalog";
import { loadRegistry } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";

/**
 * Schema-v2 versions of the three pilot workflows, used only by tests. The real
 * catalog files stay on v1 until the migration milestone.
 */

const common = (id: string, name: string, category: string) => ({
  $schema: "../../workflow.schema.json",
  schemaVersion: 2,
  id,
  version: "0.2.0",
  name,
  category,
  summary: `${name} (test fixture).`,
  description: `${name}, schema-v2 test fixture for the generic executor.`,
  status: "planned",
  problems: ["A test problem one", "A test problem two", "A test problem three"],
  tags: ["fixture"],
  tools: [],
  integrations: [],
});

const str = (extra: Record<string, unknown> = {}) => ({ type: "string", ...extra });
const list = (items: unknown, extra: Record<string, unknown> = {}) => ({ type: "array", items, ...extra });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties), extra: Record<string, unknown> = {}) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
  ...extra,
});

export const surveyData = {
  ...common("survey-designer", "Survey Designer", "user-research"),
  inputs: [
    { use: "research_question", required: true },
    { key: "audience", label: "Audience", type: "text", required: true, description: "Who will receive the survey.", example: "Trial users" },
    { key: "max_questions", label: "Maximum questions", type: "number", required: false, description: "Upper limit on survey length." },
  ],
  outputs: [{ key: "survey", label: "Survey", description: "Questions with rationale and analysis.", format: "json" }],
  execution: { engine: "generic", system: "You design short, unbiased surveys.", effort: "medium" },
  outputSchema: obj({
    questions: list(
      // "format" is deliberately a field name: the provider schema must keep it (regression for strip()).
      obj(
        {
          text: str({ minLength: 5 }),
          format: str({ enum: ["single_choice", "multi_choice", "scale", "open"] }),
          options: list(str()),
          rationale: str(),
          analysis: str(),
        },
        ["text", "format", "rationale", "analysis"],
      ),
      { title: "Questions", minItems: 1 },
    ),
    analysis_plan: str({ title: "Analysis plan" }),
  }),
  steps: [
    { id: "draft", name: "Draft survey", kind: "agent", mode: "generate", responsibility: "Write questions mapped to the research goal.", prompt: "Write survey questions that answer the research question.", tools: [] },
    { id: "bias_review", name: "Bias review", kind: "agent", mode: "revise", responsibility: "Rewrite leading or double-barreled questions.", prompt: "Rewrite any leading, loaded or double-barreled question.", tools: [] },
    { id: "check_survey", name: "Check survey", kind: "check", responsibility: "Check length and that every question has a rationale and analysis.", tools: [] },
  ],
  dependencies: [],
  evaluation: {
    criteria: [
      { id: "schema_valid", description: "Output matches the schema.", method: "schema", critical: true },
      { id: "within_limit", description: "Question count is within the maximum.", method: "rule", critical: true, rule: { id: "count", params: { path: "questions", min: 1, max: 10, maxFromInput: "max_questions" } } },
      { id: "analysis_mapped", description: "Every question has a rationale and an analysis method.", method: "rule", critical: false, rule: { id: "required_fields", params: { path: "questions[]", fields: ["rationale", "analysis"] } } },
    ],
    threshold: 0.7,
  },
  limits: { maxRetries: 1, timeoutSeconds: 120, maxModelCalls: 4 },
};

export const sopData = {
  ...common("sop-writer", "SOP Writer", "operations"),
  inputs: [
    { use: "company_name", required: false },
    { key: "process_description", label: "Process description", type: "long_text", required: true, description: "How the process works today.", example: "Every month-end…" },
    { key: "roles", label: "Roles involved", type: "list", required: false, description: "Roles that take part." },
  ],
  outputs: [{ key: "sop", label: "Standard operating procedure", description: "Numbered steps with owners.", format: "markdown" }],
  execution: { engine: "generic", system: "You turn messy process descriptions into clear SOPs.", maxOutputTokens: 3000 },
  outputSchema: obj({
    purpose: str({ title: "Purpose" }),
    steps: list(obj({ action: str(), owner: str(), check: str() }, ["action", "owner"]), { title: "Procedure", minItems: 1 }),
    assumptions: list(str(), { title: "Assumptions" }),
  }),
  steps: [
    { id: "draft", name: "Draft procedure", kind: "agent", mode: "generate", responsibility: "Write the SOP and flag assumptions.", tools: [] },
    { id: "check_structure", name: "Check structure", kind: "check", responsibility: "Every step has an owner and an action.", tools: [] },
    { id: "review", name: "Review", kind: "agent", responsibility: "Grade whether assumptions are listed.", tools: [] },
  ],
  dependencies: [],
  evaluation: {
    criteria: [
      { id: "schema_valid", description: "Output matches the schema.", method: "schema", critical: true },
      { id: "owners_assigned", description: "Every step names an owner and an action.", method: "rule", critical: true, rule: { id: "required_fields", params: { path: "steps[]", fields: ["owner", "action"] } } },
      { id: "assumptions_listed", description: "Anything not in the description is listed as an assumption.", method: "model", critical: false, review: { step: "review", rubric: "Is everything not stated in the process description listed under assumptions?" } },
    ],
    threshold: 0.75,
  },
  limits: { maxRetries: 1, timeoutSeconds: 180, maxModelCalls: 5 },
};

export const discoveryData = {
  ...common("discovery-call-prep", "Discovery Call Prep", "sales"),
  inputs: [
    { use: "product_description", required: true },
    { key: "prospect", label: "Prospect", type: "text", required: true, description: "Who you're meeting.", example: "Dana Lee, COO at Brightline" },
    { key: "prospect_notes", label: "What you know", type: "long_text", required: false, description: "Anything you already know.", example: "Mentioned spreadsheets." },
  ],
  outputs: [{ key: "brief", label: "Call brief", description: "Facts, hypotheses and questions.", format: "markdown" }],
  execution: { engine: "generic", system: "You prepare B2B sales reps for first discovery calls.", effort: "medium" },
  outputSchema: obj({
    prospect_summary: str({ title: "Prospect" }),
    facts: list(obj({ statement: str(), evidence: str() }), { title: "What we know" }),
    hypotheses: list(obj({ id: str(), statement: str() }), { title: "Hypotheses to test" }),
    questions: list(obj({ text: str(), tests: list(str()) }), { title: "Questions" }),
  }),
  steps: [
    { id: "prepare", name: "Prepare brief", kind: "agent", mode: "generate", responsibility: "Draft facts, hypotheses and questions.", prompt: "Facts need word-for-word evidence; everything else is a hypothesis.", tools: [] },
    { id: "check_labels", name: "Check labels", kind: "check", responsibility: "Facts quote the notes; questions test hypotheses.", tools: [] },
  ],
  dependencies: [{ workflowId: "icp-builder", required: false, reason: "The ICP sharpens the questions." }],
  evaluation: {
    criteria: [
      { id: "schema_valid", description: "Output matches the schema.", method: "schema", critical: true },
      { id: "hypotheses_labelled", description: "Every stated fact quotes the prospect or notes word-for-word.", method: "rule", critical: true, rule: { id: "verbatim_in_inputs", params: { path: "facts[].evidence", inputs: ["prospect", "prospect_notes"] } } },
      { id: "questions_mapped", description: "Each hypothesis has a question that tests it.", method: "rule", critical: false, rule: { id: "references", params: { from: "questions[].tests[]", to: "hypotheses[].id", everyTargetReferenced: true } } },
    ],
    threshold: 0.75,
  },
  limits: { maxRetries: 1, timeoutSeconds: 120, maxModelCalls: 4 },
};

/** The real catalog's raw entries, with the fixture replacing the v1 file of the same id. */
async function entriesWith(data: { id: string; category: string }, overrides: Record<string, unknown>) {
  const root = path.join(process.cwd(), "catalog", "workflows");
  const entries: RawEntry[] = [];
  for (const category of await readdir(root)) {
    for (const file of await readdir(path.join(root, category))) {
      if (!file.endsWith(".json") || file === `${data.id}.json`) continue;
      entries.push({ file: `${category}/${file}`, data: JSON.parse(await readFile(path.join(root, category, file), "utf8")) });
    }
  }
  entries.push({ file: `${data.category}/${data.id}.json`, data: { ...data, ...overrides } });
  return entries;
}

async function build(data: { id: string; category: string }, overrides: Record<string, unknown>) {
  const { registry } = await loadRegistry();
  return buildCatalog(await entriesWith(data, overrides), registry);
}

/** Validates a fixture through the real catalog builder, registry and catalog, and returns the workflow. */
export async function buildFixture(data: { id: string; category: string }, overrides: Record<string, unknown> = {}): Promise<Workflow> {
  const built = await build(data, overrides);
  const problems = built.errors.filter((e) => e.file.endsWith(`/${data.id}.json`));
  if (built.errors.length) throw new Error(built.errors.map((e) => `${e.file}: ${e.message}`).join("\n"));
  if (problems.length) throw new Error(problems.map((e) => e.message).join("\n"));
  return built.workflows.find((w) => w.id === data.id)!;
}

/** Catalog problems reported for a fixture variant, for validation tests. */
export async function problemsFor(data: { id: string; category: string }, overrides: Record<string, unknown> = {}): Promise<string[]> {
  return (await build(data, overrides)).errors.filter((e) => e.file.endsWith(`/${data.id}.json`)).map((e) => e.message);
}
