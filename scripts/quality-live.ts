// Controlled LIVE verification. This calls the real model (and real web tools or provider
// reads for workflows that use them) and SPENDS CREDITS. It never approves or executes
// proposed actions.
//
//   npm run quality:live -- --workflow prd-writer                 shows the plan and worst-case cost; runs nothing
//   npm run quality:live -- --workflow prd-writer --confirm       runs the "typical" golden scenario once
//   npm run quality:live -- --workflow prd-writer --scenario typical --confirm
import { loadAppCatalog } from "../src/lib/catalog/load";
import { getDb } from "../src/lib/server/db";
import { getModelConfig } from "../src/lib/server/config";
import { createMessage } from "../src/lib/server/model-client";
import { liveCostCeiling, liveProblems, runLive } from "../src/lib/server/quality/live";
import { loadGoldens, profileOf } from "../src/lib/server/quality/service";
import { workflowFingerprint } from "../src/lib/server/quality/fingerprint";

// Same settings the app uses (values are never printed).
try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local: the checks below say what is missing
}

const args = process.argv.slice(2);
const ids = args.flatMap((a, i) => (a === "--workflow" ? [args[i + 1]] : []));
const scenario = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : "typical";
const confirm = args.includes("--confirm");
if (!ids.length) {
  console.error("Name the workflow(s) to run live: --workflow <id> (one run each). There is deliberately no --all.");
  process.exit(2);
}
const catalog = (await loadAppCatalog()).workflows;
const { goldens } = loadGoldens();
const config = getModelConfig();
let total = 0;
let unknown = false;
let tokens = 0;
const targets = ids.map((id) => {
  const wf = catalog.find((w) => w.id === id);
  if (!wf) throw new Error(`Unknown workflow ${id}`);
  const golden = goldens[id];
  if (!golden) throw new Error(`No golden dataset for ${id}`);
  const profile = profileOf(wf);
  const t = { wf, profile, golden, fingerprint: workflowFingerprint(wf, profile, golden.datasetVersion) };
  const ceiling = liveCostCeiling(profile, config.model);
  total += ceiling.usd ?? 0;
  if (ceiling.usd === null) unknown = true;
  tokens += ceiling.inTokens + ceiling.outTokens;
  const problems = liveProblems(t, scenario, process.env);
  console.log(
    `${id} (${profile.executionType}) scenario "${scenario}" on ${config.provider}/${config.model}: at most ${ceiling.calls} model calls, worst case ${ceiling.usd !== null ? `$${ceiling.usd.toFixed(2)}` : "unknown cost (no verified price)"}${profile.usesWebSearch ? " plus web search charges" : ""}.${problems.length ? `\n  Can't run: ${problems.join("; ")}` : ""}`,
  );
  return { t, problems };
});
if (!confirm) {
  const cost = unknown ? `unknown (no verified price for ${config.model}); up to about ${tokens.toLocaleString("en")} tokens` : `$${total.toFixed(2)}`;
  console.log(`\nNothing was run. Worst case for all: ${cost}${targets.some((x) => x.t.profile.usesWebSearch) ? " plus web search" : ""}. Add --confirm to run (this spends credits).`);
  process.exit(0);
}
const db = getDb();
for (const { t, problems } of targets) {
  if (problems.length) continue;
  const r = await runLive(db, t, scenario, { createMessage });
  console.log(`${t.wf.id}: ${r.status} in ${Math.round(r.durationMs / 1000)}s, ${r.usage.inputTokens + r.usage.outputTokens} tokens. Output ${r.outputId} is ready for human review at /quality/${t.wf.id}.${r.reason ? ` (${r.reason})` : ""}`);
}
