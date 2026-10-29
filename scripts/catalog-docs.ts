// Writes docs/catalog.md from the catalog. `--check` fails if it is out of date (used in CI and `npm run check`).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadCatalog } from "../src/lib/catalog/load";
import { renderCatalogDocs } from "../src/lib/catalog/tooling/docs";

const file = path.join(process.cwd(), "docs", "catalog.md");
const next = renderCatalogDocs(await loadCatalog());
let current = "";
try {
  current = readFileSync(file, "utf8");
} catch {}
if (process.argv.includes("--check")) {
  if (current !== next) {
    console.error("✗ docs/catalog.md is out of date. Run `npm run catalog:docs`.");
    process.exit(1);
  }
  console.log("✓ docs/catalog.md is up to date");
} else {
  writeFileSync(file, next);
  console.log("✓ wrote docs/catalog.md");
}
