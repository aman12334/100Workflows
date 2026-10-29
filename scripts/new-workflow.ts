// Scaffolds a workflow definition (and optionally an executor + test).
//   npm run new:workflow                                   (asks questions)
//   npm run new:workflow -- --id churn-review --name "Churn Review" --category operations [--summary "..."] [--executable]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { loadCatalog } from "../src/lib/catalog/load";
import { CATEGORIES, type Category } from "../src/lib/catalog/schema";
import { definitionTemplate, executorTemplate, testTemplate, validateScaffold, type ScaffoldOptions } from "../src/lib/catalog/tooling/scaffold";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const opts: Partial<ScaffoldOptions> = {
  id: flag("id"),
  name: flag("name"),
  category: flag("category") as Category | undefined,
  summary: flag("summary"),
  executable: process.argv.includes("--executable"),
};

if (process.stdin.isTTY && (!opts.id || !opts.name || !opts.category)) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  opts.name ||= (await rl.question("Workflow name (e.g. Churn Risk Review): ")).trim();
  const suggested = (opts.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  opts.id ||= (await rl.question(`Id [${suggested}]: `)).trim() || suggested;
  opts.category ||= ((await rl.question(`Category (${CATEGORIES.join(", ")}): `)).trim() as Category);
  opts.summary ||= (await rl.question("One-line summary (optional): ")).trim() || undefined;
  if (!process.argv.includes("--executable")) opts.executable = /^y/i.test((await rl.question("Also create an executor stub? [y/N]: ")).trim());
  rl.close();
}

const catalog = await loadCatalog();
const problems = validateScaffold(opts, new Set(catalog.workflows.map((w) => w.id)));
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
const o = opts as ScaffoldOptions;
const created: string[] = [];
const write = (rel: string, content: string) => {
  const file = path.join(process.cwd(), rel);
  if (existsSync(file)) {
    console.error(`✗ ${rel} already exists; not overwriting.`);
    process.exit(1);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  created.push(rel);
};

write(`catalog/workflows/${o.category}/${o.id}.json`, JSON.stringify(definitionTemplate(o), null, 2) + "\n");
if (o.executable) {
  write(`src/lib/runtime/executors/${o.id}.ts`, executorTemplate(o));
  write(`tests/executors/${o.id}.test.ts`, testTemplate(o));
}

console.log(`Created:\n${created.map((c) => `  ${c}`).join("\n")}\n`);
console.log("Next:");
console.log(`  1. Replace every TODO in catalog/workflows/${o.category}/${o.id}.json (your editor validates it via $schema).`);
console.log(`  2. Add a query that should find it to catalog/search-cases.json.`);
if (o.executable) {
  console.log(`  3. Implement src/lib/runtime/executors/${o.id}.ts and register it in src/lib/runtime/executors/index.ts.`);
  console.log(`  4. When it runs, set "status": "available" and bump the version.`);
}
console.log(`  ${o.executable ? 5 : 3}. Run \`npm run catalog:validate -- --strict\`, \`npm run catalog:docs\` and \`npm test\`.`);
