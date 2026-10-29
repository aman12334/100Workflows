import type { Catalog } from "../catalog";
import type { SearchCases } from "./search-cases";

export interface LintWarning {
  file: string;
  workflowId: string;
  message: string;
}

const PLACEHOLDER = /\b(TODO|TBD|FIXME|lorem ipsum)\b/i;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

/**
 * Quality warnings beyond schema validity. They keep a growing catalog
 * searchable and consistent; `catalog:validate --strict` (CI) treats them as errors.
 */
export function lintCatalog(catalog: Catalog, cases: SearchCases | null): LintWarning[] {
  const warnings: LintWarning[] = [];
  const covered = new Set(cases?.cases.flatMap((c) => c.expect) ?? []);
  const problemOwners = new Map<string, string[]>();
  const tools = new Map((catalog.registry?.tools ?? []).map((t) => [t.id, t]));

  for (const wf of catalog.workflows) {
    const warn = (message: string) => warnings.push({ file: catalog.sources[wf.id] ?? `${wf.id}.json`, workflowId: wf.id, message });

    if (strings(wf).some((s) => PLACEHOLDER.test(s))) warn("contains placeholder text (TODO/TBD); finish it before publishing");
    if (wf.problems.length < 3) warn("list at least 3 problems, phrased the way a user would say them; they carry the most weight in search");
    if (wf.tags.length === 0) warn("add a few tags; they help search and filtering");
    if (wf.summary.length > 160) warn(`summary is ${wf.summary.length} characters; cards show about 160`);
    for (const input of wf.inputs) {
      if (input.required && !input.shared && ["text", "long_text", "list"].includes(input.type) && !input.example) {
        warn(`required input "${input.key}" has no example; examples become placeholders in the setup form`);
      }
    }
    if (!wf.evaluation.criteria.some((c) => c.critical && c.method !== "schema")) {
      warn("no critical rule or model check besides the schema; a critical check is what stops a plausible-looking but wrong output");
    }
    if (cases && !covered.has(wf.id)) warn("no search case expects this workflow; add one to catalog/search-cases.json");
    if (wf.status === "available") {
      for (const t of wf.tools.filter((t) => t.required)) {
        if (tools.get(t.id)?.available === false) warn(`is "available" but requires tool "${t.id}", which the runtime doesn't provide`);
      }
    }
    for (const p of wf.problems) {
      const k = p.trim().toLowerCase();
      problemOwners.set(k, [...(problemOwners.get(k) ?? []), wf.id]);
    }
  }

  // The same problem in several workflows is fine (that's how bundles get recommended), but more than three makes search ambiguous.
  for (const [problem, owners] of problemOwners) {
    if (owners.length > 3) {
      for (const id of owners) {
        warnings.push({ file: catalog.sources[id] ?? `${id}.json`, workflowId: id, message: `problem "${problem}" is shared by ${owners.length} workflows; make it more specific` });
      }
    }
  }
  return warnings;
}
