// Validates the catalog: schema and cross-file errors, search cases, then quality warnings.
// `--strict` (used in CI) also fails on warnings.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCatalog } from "../src/lib/catalog/load";
import { lintCatalog } from "../src/lib/catalog/tooling/lint";
import { SearchCasesSchema, runSearchCases, type SearchCases } from "../src/lib/catalog/tooling/search-cases";

const strict = process.argv.includes("--strict");
const catalog = await loadCatalog();

let cases: SearchCases | null = null;
const caseErrors: string[] = [];
try {
  const parsed = SearchCasesSchema.safeParse(JSON.parse(readFileSync(path.join(process.cwd(), "catalog", "search-cases.json"), "utf8")));
  if (parsed.success) cases = parsed.data;
  else caseErrors.push(`search-cases.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
} catch (err) {
  caseErrors.push(`search-cases.json: ${(err as Error).message}`);
}
if (cases) {
  const known = new Set(catalog.workflows.map((w) => w.id));
  for (const c of cases.cases) for (const id of c.expect) if (!known.has(id)) caseErrors.push(`search-cases.json: "${c.query}" expects unknown workflow "${id}"`);
  for (const r of runSearchCases(catalog.workflows, cases)) {
    if (r.missing.length) caseErrors.push(`search case "${r.query}" missed ${r.missing.join(", ")} (top ${cases.limit}: ${r.got.join(", ") || "nothing"})`);
  }
}

const warnings = lintCatalog(catalog, cases);

for (const w of catalog.workflows) console.log(`✓ ${(catalog.sources[w.id] ?? w.id).padEnd(44)} ${w.version.padEnd(7)} ${w.status}`);
if (catalog.errors.length) console.log("");
for (const e of catalog.errors) console.error(`✗ ${e.file}: ${e.message}`);
for (const e of caseErrors) console.error(`✗ ${e}`);
if (warnings.length) console.log("");
for (const w of warnings) console.warn(`! ${w.file}: ${w.message}`);

const failed = catalog.errors.length + caseErrors.length + (strict ? warnings.length : 0);
console.log(`\n${catalog.workflows.length} valid · ${catalog.errors.length} error(s) · ${caseErrors.length} search case failure(s) · ${warnings.length} warning(s)${strict ? " (strict)" : ""}`);
process.exit(failed ? 1 : 0);
