// Validates the golden datasets in quality/golden and reports coverage.
//   npm run quality:golden           exits 1 if a dataset is invalid or an executable workflow has none
import { loadCatalog } from "../src/lib/catalog/load";
import { loadGoldens } from "../src/lib/server/quality/service";

const { goldens, errors } = loadGoldens();
const catalog = (await loadCatalog()).workflows;
const executable = catalog.filter((w) => w.status === "available");
const missing = executable.filter((w) => !goldens[w.id]).map((w) => w.id);
const orphans = Object.keys(goldens).filter((id) => !catalog.some((w) => w.id === id));
const scripted = executable.filter((w) => goldens[w.id]?.scenarios.some((s) => s.mock)).length;
const scenarios = Object.values(goldens).reduce((n, g) => n + g.scenarios.length, 0);
console.log(`${Object.keys(goldens).length} golden datasets, ${scenarios} scenarios; ${scripted} of ${executable.length} executable workflows have a scripted scenario.`);
for (const e of errors) console.log(`✗ ${e}`);
for (const id of missing) console.log(`✗ no golden dataset for executable workflow ${id}`);
for (const id of orphans) console.log(`✗ golden dataset for unknown workflow ${id}`);
process.exit(errors.length || missing.length || orphans.length ? 1 : 0);
