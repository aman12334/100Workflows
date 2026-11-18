import { RULES, validateRuleRef } from "@/lib/runtime/rules/registry";
import { callsPerAttempt, producerSteps } from "@/lib/runtime/executors/generic";
import { gatherModelCalls } from "@/lib/runtime/executors/research";
import { SOURCE_RULE_IDS } from "@/lib/runtime/rules/sources";
import { TOOLS } from "@/lib/runtime/tools/registry";
import { z } from "zod";
import { lookupCalculation } from "@/lib/runtime/calc/runner";
import { calculationModelCalls } from "@/lib/runtime/executors/calculation";
import { CALCULATION_RULE_IDS } from "@/lib/runtime/rules/calculation";
import { InputRefSchema, WorkflowSchema, type SharedInputDef, type ToolDef, type Workflow } from "./schema";

export interface CatalogError {
  file: string;
  message: string;
}

export interface Registry {
  sharedInputs: SharedInputDef[];
  tools: ToolDef[];
}

export interface Catalog {
  workflows: Workflow[];
  errors: CatalogError[];
  /** Definition file per workflow id, relative to catalog/workflows. */
  sources: Record<string, string>;
  registry: Registry | null;
}

export interface RawEntry {
  /** Path relative to catalog/workflows, e.g. "gtm/market-research.json". */
  file: string;
  data: unknown;
}

/**
 * Turns a definition file into a full workflow object: drops `$schema` and
 * replaces `{ "use": "company_name" }` references with the shared definition.
 * Returns the problems it finds instead of throwing.
 */
export function expandManifest(data: unknown, registry: Registry | null): { data: unknown; errors: string[] } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { data, errors: [] };
  const { $schema: _ignored, ...rest } = data as Record<string, unknown>;
  if (!Array.isArray(rest.inputs)) return { data: rest, errors: [] };
  const shared = new Map((registry?.sharedInputs ?? []).map((d) => [d.key, d]));
  const errors: string[] = [];

  const inputs = rest.inputs.map((input, i) => {
    if (input && typeof input === "object" && "use" in input) {
      const ref = InputRefSchema.safeParse(input);
      if (!ref.success) {
        errors.push(`inputs.${i}: ${ref.error.issues.map((x) => x.message).join("; ")}`);
        return input;
      }
      const def = shared.get(ref.data.use);
      if (!def) {
        errors.push(`inputs.${i}: "${ref.data.use}" is not defined in catalog/shared-inputs.json`);
        return input;
      }
      return { ...def, required: ref.data.required, shared: true };
    }
    if (registry && input && typeof input === "object") {
      const field = input as { key?: string; shared?: boolean };
      if (field.key && shared.has(field.key)) {
        errors.push(`inputs.${i}: "${field.key}" is shared business context; write { "use": "${field.key}", "required": ... } instead of redefining it`);
      } else if (field.shared) {
        errors.push(`inputs.${i}: "${field.key}" is marked shared but isn't in catalog/shared-inputs.json; add it there and reference it with "use"`);
      }
    }
    return input;
  });
  return { data: { ...rest, inputs }, errors };
}

const SCHEMA_CRITERION = "schema_valid";

/**
 * Checks a schema-v2 definition for everything the generic executor relies on
 * and the schema alone can't see: steps that make sense in order, every
 * criterion wired to a known rule or review, rule paths and inputs that exist,
 * and an attempt that fits the model-call budget. Returns problems; empty means
 * the generic executor can run it. v1 definitions return no problems.
 */
export function validateGenericDefinition(wf: Workflow): string[] {
  if (wf.schemaVersion !== 2 || !wf.execution || !wf.outputSchema) return [];
  const problems: string[] = [];
  const steps = new Map(wf.steps.map((s) => [s.id, s]));

  // Read-only tools only, through a gather step; no integrations or side effects.
  if (wf.integrations.length) problems.push("generic workflows can't use integrations yet; remove \"integrations\"");
  const gatherSteps = wf.steps.filter((s) => s.mode === "gather");
  const gatherStep = gatherSteps[0];
  if (wf.tools.length && !gatherStep) problems.push('generic workflows use tools only in a "gather" step; add one or remove "tools"');
  for (const t of wf.tools) {
    if (!Object.hasOwn(TOOLS, t.id)) problems.push(`tool "${t.id}" is not provided by the runtime (available: ${Object.keys(TOOLS).sort().join(", ")})`);
  }
  for (const st of wf.steps) {
    if (st.kind === "check" && (st.mode || st.prompt || st.gather)) problems.push(`step "${st.id}" is a check step, so it can't have a mode, prompt or gather`);
    if (st.gather && st.mode !== "gather") problems.push(`step "${st.id}" has "gather" settings but its mode is not "gather"`);
    if (st.tools.length && st.mode !== "gather") problems.push(`step "${st.id}" lists tools; only a "gather" step can use tools`);
  }
  if (gatherSteps.length > 1) problems.push('only one step can "gather"');
  if (gatherStep) {
    const g = gatherStep.gather;
    const declared = new Set(wf.tools.map((t) => t.id));
    const needs = [...(g?.search ? ["web-search"] : []), ...(g?.fetch ? ["web-fetch"] : [])];
    if (gatherStep.kind !== "agent") problems.push(`gather step "${gatherStep.id}" must be an agent step`);
    if (!g) problems.push(`gather step "${gatherStep.id}" needs "gather" settings (search, fetch or both)`);
    if (wf.steps.indexOf(gatherStep) > wf.steps.findIndex((s) => s.mode === "generate")) problems.push(`gather step "${gatherStep.id}" must come before the generate step`);
    for (const id of needs) {
      if (!declared.has(id)) problems.push(`gather step "${gatherStep.id}" uses ${id}; declare it in "tools"`);
      if (!gatherStep.tools.includes(id)) problems.push(`gather step "${gatherStep.id}" uses ${id}; list it in the step's "tools"`);
    }
    for (const id of gatherStep.tools) if (!needs.includes(id)) problems.push(`gather step "${gatherStep.id}" lists ${id} but its settings don't use it`);
    if (g?.fetch) {
      if (!g.fetch.urlInputs?.length && !g.fetch.fromSearch) problems.push(`gather step "${gatherStep.id}": fetch needs urlInputs, fromSearch or both`);
      if (g.fetch.fromSearch && !g.search) problems.push(`gather step "${gatherStep.id}": fetch.fromSearch needs search`);
      for (const key of g.fetch.urlInputs ?? []) {
        const input = wf.inputs.find((i) => i.key === key);
        if (!input) problems.push(`gather step "${gatherStep.id}": url input "${key}" is not declared`);
        else if (input.type !== "url" && input.type !== "list") problems.push(`gather step "${gatherStep.id}": input "${key}" must be of type url or list`);
      }
    }
    if (wf.outputSchema.type === "object") {
      for (const reserved of ["retrieved_sources", "unavailable_sources"]) {
        if (Object.hasOwn(wf.outputSchema.properties, reserved)) problems.push(`outputSchema can't define "${reserved}"; the runtime adds it`);
      }
    }
    const citationCheck = wf.evaluation.criteria.some((c) => c.critical && c.rule && SOURCE_RULE_IDS.has(c.rule.id));
    if (!citationCheck) problems.push(`research workflows need a critical citation rule (${[...SOURCE_RULE_IDS].sort().join(" or ")})`);
  } else {
    for (const c of wf.evaluation.criteria) {
      if (c.rule && SOURCE_RULE_IDS.has(c.rule.id)) problems.push(`criterion "${c.id}": rule "${c.rule.id}" checks retrieved sources, so it needs a gather step`);
    }
  }

  const producers = producerSteps(wf);
  if (!producers.length || producers[0].mode !== "generate") {
    problems.push('the first producing step must have "mode": "generate"');
  }
  if (producers.slice(1).some((s) => s.mode === "generate")) problems.push('only one step can "generate"; later producing steps must "revise"');

  const reviewSteps = new Set<string>();
  const checkStepsUsed = new Set<string>();
  const firstCheck = wf.steps.find((s) => s.kind === "check");
  const inputKeys = wf.inputs.map((i) => i.key);

  const schemaCriterion = wf.evaluation.criteria.find((c) => c.id === SCHEMA_CRITERION);
  if (!schemaCriterion || schemaCriterion.method !== "schema" || !schemaCriterion.critical) {
    problems.push(`generic workflows need a critical "${SCHEMA_CRITERION}" criterion with method "schema"`);
  }

  for (const c of wf.evaluation.criteria) {
    const where = `criterion "${c.id}"`;
    if (c.method === "schema") {
      if (c.id !== SCHEMA_CRITERION) problems.push(`${where}: only "${SCHEMA_CRITERION}" can use method "schema"`);
      if (c.rule || c.review) problems.push(`${where}: a schema criterion can't have a rule or review`);
      continue;
    }
    if (c.method === "rule") {
      if (c.review) problems.push(`${where}: a rule criterion can't have a review`);
      if (!c.rule) {
        problems.push(`${where}: method "rule" needs a "rule" (one of ${Object.keys(RULES).sort().join(", ")})`);
        continue;
      }
      problems.push(...validateRuleRef(c.rule, { outputSchema: wf.outputSchema, inputKeys }).map((p) => `${where}: ${p}`));
      const stepId = c.rule.step ?? firstCheck?.id;
      const step = stepId ? steps.get(stepId) : undefined;
      if (!stepId) problems.push(`${where}: rules run in a "check" step, and this workflow has none`);
      else if (!step) problems.push(`${where}: rule step "${stepId}" is not declared`);
      else if (step.kind !== "check") problems.push(`${where}: rule step "${stepId}" must be a "check" step`);
      else checkStepsUsed.add(stepId);
      continue;
    }
    // method === "model"
    if (c.rule) problems.push(`${where}: a model criterion can't have a rule`);
    if (!c.review) {
      problems.push(`${where}: method "model" needs a "review" with a step and rubric`);
      continue;
    }
    const step = steps.get(c.review.step);
    if (!step) problems.push(`${where}: review step "${c.review.step}" is not declared`);
    else if (step.kind !== "agent" || step.mode) problems.push(`${where}: review step "${c.review.step}" must be an agent step without a mode`);
    else reviewSteps.add(step.id);
  }

  for (const st of wf.steps) {
    if (st.kind === "agent" && !st.mode && !reviewSteps.has(st.id)) {
      problems.push(`agent step "${st.id}" has no mode and no review uses it; give it "mode" or remove it`);
    }
    if (st.kind === "check" && !st.calculate && !checkStepsUsed.has(st.id)) problems.push(`check step "${st.id}" runs no rules; remove it or point a rule at it`);
  }

  problems.push(...calculationProblems(wf));

  const calls = callsPerAttempt(wf) + gatherModelCalls(wf) + calculationModelCalls(wf);
  if (calls > wf.limits.maxModelCalls) {
    const why = gatherModelCalls(wf) ? ` (including ${gatherModelCalls(wf)} for web search)` : "";
    problems.push(`one attempt needs ${calls} model calls${why}, but limits.maxModelCalls is ${wf.limits.maxModelCalls}`);
  }
  return problems;
}

type JsonNode = { type?: string | string[]; properties?: Record<string, JsonNode>; required?: string[]; items?: JsonNode; anyOf?: JsonNode[] };

/** The JSON Schema node at a dot path of a calculation's input, or null. */
function calcField(root: JsonNode, path: string): JsonNode | null {
  let node: JsonNode | undefined = root;
  for (const part of path.split(".")) {
    node = node?.properties?.[part];
    if (!node) return null;
  }
  return node ?? null;
}
const typesOf = (n: JsonNode): string[] => [...(Array.isArray(n.type) ? n.type : n.type ? [n.type] : []), ...(n.anyOf ?? []).flatMap(typesOf)];

/** Checks a workflow's calculate and extract steps against the calculation registry. */
function calculationProblems(wf: Workflow): string[] {
  const problems: string[] = [];
  const calcSteps = wf.steps.filter((s) => s.calculate);
  const extract = wf.steps.filter((s) => s.mode === "extract");
  const usesNumbersRule = wf.evaluation.criteria.filter((c) => c.rule && CALCULATION_RULE_IDS.has(c.rule.id));
  if (!calcSteps.length) {
    if (extract.length) problems.push('an "extract" step needs a calculate step to feed');
    for (const c of usesNumbersRule) problems.push(`criterion "${c.id}": rule "${c.rule!.id}" checks calculation results, so it needs a calculate step`);
    return problems;
  }
  if (calcSteps.length > 1) problems.push("only one step can calculate");
  if (extract.length > 1) problems.push('only one step can "extract"');
  const step = calcSteps[0];
  const ref = step.calculate!.calculation;
  if (step.kind !== "check") problems.push(`step "${step.id}" calculates, so it must be a "check" step`);
  if (wf.steps.some((s) => s.mode === "gather")) problems.push("a workflow can't both gather and calculate yet");
  const generateAt = wf.steps.findIndex((s) => s.mode === "generate");
  if (wf.steps.indexOf(step) > generateAt) problems.push(`calculate step "${step.id}" must come before the generate step`);
  if (extract.length && wf.steps.indexOf(extract[0]) > wf.steps.indexOf(step)) problems.push(`extract step "${extract[0].id}" must come before the calculate step`);
  if (extract.length && extract[0].kind !== "agent") problems.push(`extract step "${extract[0].id}" must be an agent step`);
  if (!usesNumbersRule.some((c) => c.critical)) problems.push("calculation workflows need a critical numbers_from_calculation rule on the explanation");

  const def = lookupCalculation(ref);
  if (!def) {
    problems.push(`calculation "${ref}" is not registered`);
    return problems;
  }
  const schema = z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }) as JsonNode;
  const mapped = Object.entries(step.calculate!.inputs ?? {});
  for (const [field, map] of mapped) {
    const node = calcField(schema, field);
    const input = wf.inputs.find((i) => i.key === map.input);
    if (!node) problems.push(`calculate step "${step.id}": "${field}" is not an input of ${ref}`);
    if (!input) problems.push(`calculate step "${step.id}": input "${map.input}" is not declared`);
    if (!node || !input) continue;
    const types = typesOf(node);
    const ok =
      map.as === "number" ? (types.includes("number") || types.includes("integer")) && input.type === "number" :
      map.as === "number_list" ? types.includes("array") && ["list", "long_text", "text"].includes(input.type) :
      types.includes("string") && ["text", "select", "long_text"].includes(input.type);
    if (!ok) problems.push(`calculate step "${step.id}": "${field}" can't be filled from ${input.type} input "${map.input}" as ${map.as}`);
  }
  if (!extract.length) {
    const covered = new Set(mapped.map(([f]) => f.split(".")[0]));
    for (const req of schema.required ?? []) if (!covered.has(req)) problems.push(`calculate step "${step.id}": required field "${req}" of ${ref} is not mapped, and there is no extract step`);
  }
  return problems;
}

function basename(file: string) {
  return file.split("/").pop() ?? file;
}

/**
 * Validates every entry on its own, then checks the catalog as a whole
 * (duplicate IDs, unknown dependencies, dependency cycles). Invalid entries are
 * left out and reported, so one bad contribution never takes the app down.
 */
export function buildCatalog(entries: RawEntry[], registry: Registry | null = null): Catalog {
  const errors: CatalogError[] = [];
  const byId = new Map<string, { file: string; workflow: Workflow }>();
  const toolIds = new Set((registry?.tools ?? []).map((t) => t.id));

  for (const entry of entries) {
    const expanded = expandManifest(entry.data, registry);
    if (expanded.errors.length) {
      for (const message of expanded.errors) errors.push({ file: entry.file, message });
      continue;
    }
    const parsed = WorkflowSchema.safeParse(expanded.data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const where = issue.path.length ? issue.path.join(".") : "(root)";
        errors.push({ file: entry.file, message: `${where}: ${issue.message}` });
      }
      continue;
    }
    const wf = parsed.data;
    if (basename(entry.file) !== `${wf.id}.json`) {
      errors.push({ file: entry.file, message: `file name must match the workflow id: expected "${wf.id}.json"` });
      continue;
    }
    if (entry.file.includes("/") && entry.file.split("/").at(-2) !== wf.category) {
      errors.push({ file: entry.file, message: `category "${wf.category}" doesn't match its folder; move it to ${wf.category}/${wf.id}.json` });
      continue;
    }
    const genericProblems = validateGenericDefinition(wf);
    if (genericProblems.length) {
      for (const message of genericProblems) errors.push({ file: entry.file, message });
      continue;
    }
    const unknownTools = registry ? wf.tools.filter((t) => !toolIds.has(t.id)).map((t) => t.id) : [];
    if (unknownTools.length) {
      errors.push({ file: entry.file, message: `unknown tool(s) ${unknownTools.join(", ")}; tools must be listed in catalog/tools.json` });
      continue;
    }
    const existing = byId.get(wf.id);
    if (existing) {
      errors.push({ file: entry.file, message: `duplicate workflow id "${wf.id}" (already defined in ${existing.file})` });
      continue;
    }
    byId.set(wf.id, { file: entry.file, workflow: wf });
  }

  // Unknown dependencies. Removing one workflow can orphan another, so repeat until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [wfId, { file, workflow }] of byId) {
      const missing = workflow.dependencies.filter((d) => !byId.has(d.workflowId));
      if (missing.length) {
        for (const d of missing) {
          errors.push({ file, message: `dependency "${d.workflowId}" is not in the catalog` });
        }
        byId.delete(wfId);
        changed = true;
      }
    }
  }

  for (const cycle of findCycles(byId)) {
    for (const wfId of cycle) {
      const entry = byId.get(wfId);
      if (!entry) continue;
      errors.push({ file: entry.file, message: `dependency cycle: ${[...cycle, cycle[0]].join(" → ")}` });
      byId.delete(wfId);
    }
  }

  const workflows = [...byId.values()]
    .map((e) => e.workflow)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { workflows, errors, sources: Object.fromEntries([...byId].map(([wfId, e]) => [wfId, e.file])), registry };
}

function findCycles(byId: Map<string, { workflow: Workflow }>): string[][] {
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  const stack: string[] = [];

  const visit = (wfId: string) => {
    if (state.get(wfId) === "done") return;
    if (state.get(wfId) === "visiting") {
      cycles.push(stack.slice(stack.indexOf(wfId)));
      return;
    }
    state.set(wfId, "visiting");
    stack.push(wfId);
    for (const dep of byId.get(wfId)?.workflow.dependencies ?? []) {
      if (byId.has(dep.workflowId)) visit(dep.workflowId);
    }
    stack.pop();
    state.set(wfId, "done");
  };

  for (const wfId of byId.keys()) visit(wfId);
  return cycles;
}

export function findWorkflow(catalog: Catalog, workflowId: string): Workflow | undefined {
  return catalog.workflows.find((w) => w.id === workflowId);
}
