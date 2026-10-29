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
