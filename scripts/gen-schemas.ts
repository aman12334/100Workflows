// Writes catalog/*.schema.json from the Zod schemas. `--check` fails if they are out of date (used in CI).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GENERATED_SCHEMAS, renderSchema } from "../src/lib/catalog/tooling/json-schemas";

const check = process.argv.includes("--check");
let stale = 0;
for (const name of Object.keys(GENERATED_SCHEMAS) as Array<keyof typeof GENERATED_SCHEMAS>) {
  const file = path.join(process.cwd(), "catalog", name);
  const next = renderSchema(name);
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  if (current === next) continue;
  if (check) {
    console.error(`✗ catalog/${name} is out of date. Run \`npm run catalog:schema\`.`);
    stale++;
  } else {
    writeFileSync(file, next);
    console.log(`✓ wrote catalog/${name}`);
  }
}
if (!stale && check) console.log("✓ JSON schemas are up to date");
process.exit(stale ? 1 : 0);
