// Debug catalog search: `npm run catalog:search -- "cold email for agencies"` prints ranked hits with scores.
import { loadCatalog } from "../src/lib/catalog/load";
import { searchCatalog, stem, tokenize } from "../src/lib/catalog/search";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: npm run catalog:search -- "your query"');
  process.exit(1);
}
const { workflows } = await loadCatalog();
console.log(`terms: ${tokenize(query).map(stem).join(", ") || "(none)"}\n`);
const hits = searchCatalog(workflows, query, { limit: 10 });
if (!hits.length) console.log("No matches. Consider adding problems or tags that use these words.");
for (const [i, h] of hits.entries()) console.log(`${String(i + 1).padStart(2)}. ${h.workflow.id.padEnd(24)} score ${String(h.score).padStart(3)}  ${h.workflow.name}`);
