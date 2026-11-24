// Runs the automated readiness harness (MOCKED: scripted model, canned pages and providers)
// and the platform test suites, and records the results as evidence in the database.
// No network, no API key, no cost.
//
//   npm run quality:verify                     every executable workflow + platform suites
//   npm run quality:verify -- --workflow prd-writer --workflow sop-writer
//   npm run quality:verify -- --no-platform
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../src/lib/server/db";
import { finishQualityRun, startQualityRun } from "../src/lib/server/quality/store";
import { recordPlatformSuite, verifyAutomated } from "../src/lib/server/quality/service";

const args = process.argv.slice(2);
const ids = args.flatMap((a, i) => (a === "--workflow" ? [args[i + 1]] : []));
const platform = !args.includes("--no-platform");

const PLATFORM_SUITES = {
  platform_security: ["tests/security.test.ts", "tests/tools.test.ts", "tests/actions-api.test.ts", "tests/phase5.test.ts"],
  monitoring: ["tests/phase5-api.test.ts", "tests/quality.test.ts", "tests/run-service.test.ts"],
} as const;

function runSuite(files: readonly string[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-quality-"));
  const out = path.join(dir, "report.json");
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--reporter=json", `--outputFile=${out}`], { stdio: "ignore" });
  } catch {
    // failures are read from the report below
  }
  try {
    const r = JSON.parse(readFileSync(out, "utf8")) as { numPassedTests: number; numFailedTests: number; testResults: Array<{ assertionResults: Array<{ status: string; fullName: string }> }> };
    return { files: [...files], passed: r.numPassedTests, failed: r.numFailedTests, failures: r.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName)) };
  } catch {
    return { files: [...files], passed: 0, failed: 1, failures: ["the test run produced no report"] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const db = getDb();
console.log(`Recording evidence in ${process.env.WORKFLOWS_DB_PATH?.trim() || "data/100-workflows.db"} (all of it MOCKED: no model, web or provider is contacted).`);
const result = await verifyAutomated(db, {
  ids: ids.length ? ids : undefined,
  onProgress: (id, passed, failed) => console.log(`${failed ? "✗" : "✓"} ${id.padEnd(34)} ${passed} passed${failed ? `, ${failed} FAILED` : ""}`),
});
console.log(`\nHarness: ${result.workflows} workflows, ${result.passed} checks passed, ${result.failed} failed (run ${result.runId}).`);
if (platform) {
  const runId = startQualityRun(db, "platform");
  const summary: Record<string, unknown> = {};
  for (const [criterion, files] of Object.entries(PLATFORM_SUITES) as Array<[keyof typeof PLATFORM_SUITES, readonly string[]]>) {
    const s = runSuite(files);
    recordPlatformSuite(db, runId, criterion, s);
    summary[criterion] = { passed: s.passed, failed: s.failed };
    console.log(`${s.failed ? "✗" : "✓"} platform ${criterion}: ${s.passed} passed, ${s.failed} failed`);
  }
  finishQualityRun(db, runId, summary);
}
console.log("\nSee the results at /quality, or run `npm run quality:release`.");
process.exit(result.failed ? 1 : 0);
