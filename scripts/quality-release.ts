// Release gate. Exits 1 unless every checked workflow reaches the required readiness level
// with no blockers. Production certification is level 3.
//
//   npm run quality:release                      full catalog, level 3 (production-ready)
//   npm run quality:release -- --level 1         only require "implemented"
//   npm run quality:release -- --workflow prd-writer --json
import { LEVEL_LABELS } from "../src/lib/quality/scorecard";
import { getDb } from "../src/lib/server/db";
import { catalogReadiness, releaseReport } from "../src/lib/server/quality/service";

const args = process.argv.slice(2);
const level = Number(args[args.indexOf("--level") + 1] ?? 3) as 1 | 2 | 3;
const requiredLevel = ([1, 2, 3] as const).includes(level) && args.includes("--level") ? level : 3;
const ids = args.flatMap((a, i) => (a === "--workflow" ? [args[i + 1]] : []));

const readiness = await catalogReadiness(getDb(), { ids: ids.length ? ids : undefined });
const report = releaseReport(readiness, requiredLevel);

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const counts = [0, 1, 2, 3].map((l) => readiness.workflows.filter((w) => w.scorecard.level === l).length);
  console.log(`Readiness of ${readiness.workflows.length} workflows (${report.checked} executable):`);
  for (const l of [3, 2, 1, 0] as const) console.log(`  Level ${l} ${LEVEL_LABELS[l].padEnd(17)} ${counts[l]}`);
  console.log(`  Blocked by a critical failure  ${readiness.workflows.filter((w) => w.scorecard.release === "blocked").length}`);
  if (readiness.goldenErrors.length) console.log(`\nGolden dataset problems:\n  ${readiness.goldenErrors.join("\n  ")}`);
  if (report.regressions.length) {
    console.log(`\nStale evidence (re-verify; possible regressions): ${report.regressions.length}`);
    for (const r of report.regressions.slice(0, 15)) console.log(`  ${r.id} ${r.criterion}: ${r.reason}`);
  }
  const blocked = report.failing.filter((f) => f.blockers.length);
  if (blocked.length) {
    console.log(`\nRelease blockers:`);
    for (const f of blocked) console.log(`  ${f.id}: ${f.blockers.join(" | ")}`);
  }
  const gaps = new Map<string, number>();
  for (const f of report.failing) for (const m of f.missing) gaps.set(m, (gaps.get(m) ?? 0) + 1);
  if (gaps.size) {
    console.log(`\nMost common gaps to level ${requiredLevel}:`);
    for (const [c, n] of [...gaps].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${c.padEnd(26)} ${n} workflow(s)`);
  }
  console.log(`\n${report.ok ? "PASS" : "FAIL"}: ${report.passing.length} of ${report.checked} executable workflows meet level ${requiredLevel} (${LEVEL_LABELS[requiredLevel]}).`);
}
process.exit(report.ok ? 0 : 1);
