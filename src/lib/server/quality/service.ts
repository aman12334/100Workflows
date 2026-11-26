import "server-only";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateGenericDefinition } from "@/lib/catalog/catalog";
import { loadAppCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { PROVIDERS } from "@/lib/integrations/registry";
import { CRITERION } from "@/lib/quality/criteria";
import { GoldenSchema, checkExpectations, type Golden } from "@/lib/quality/golden";
import { CANARY_ENV } from "@/lib/quality/mocks";
import { workflowProfile, type WorkflowProfile } from "@/lib/quality/profile";
import { computeScorecard, type Scorecard } from "@/lib/quality/scorecard";
import type { Evidence, EvidenceData, Fingerprint } from "@/lib/quality/types";
import { lookupCalculation } from "@/lib/runtime/calc/runner";
import { EXECUTORS, runnability } from "@/lib/runtime/executors";
import { estimateCostUsd, type PriceBasis } from "@/lib/runtime/pricing";
import type { Usage } from "@/lib/runtime/budget";
import type { DB } from "@/lib/server/db";
import { platformFingerprint, workflowFingerprint } from "./fingerprint";
import { finishQualityRun, listEvidence, recordEvidence, startQualityRun } from "./store";
import { runHarness } from "./harness";

export const GOLDEN_DIR = path.join(process.cwd(), "quality", "golden");
const RUNBOOK = path.join(process.cwd(), "docs", "operations.md");
export const RUNBOOK_SECTIONS = ["Backups", "Restore", "Migrations", "Incidents", "Credential rotation", "Re-verification"];

/** Loads every golden dataset. Invalid files are reported, never silently skipped. */
export function loadGoldens(dir = GOLDEN_DIR): { goldens: Record<string, Golden>; errors: string[] } {
  const goldens: Record<string, Golden> = {};
  const errors: string[] = [];
  if (!existsSync(/*turbopackIgnore: true*/ dir)) return { goldens, errors: [`${dir} does not exist`] };
  for (const f of readdirSync(/*turbopackIgnore: true*/ dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const parsed = GoldenSchema.safeParse(JSON.parse(readFileSync(path.join(/*turbopackIgnore: true*/ dir, f), "utf8")));
      if (!parsed.success) errors.push(`${f}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      else if (`${parsed.data.workflowId}.json` !== f) errors.push(`${f}: workflowId "${parsed.data.workflowId}" doesn't match the file name`);
      else goldens[parsed.data.workflowId] = parsed.data;
    } catch (err) {
      errors.push(`${f}: ${(err as Error).message}`);
    }
  }
  return { goldens, errors };
}

const providerSettings = Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, p.auth.env]));
export const profileOf = (wf: Workflow) => workflowProfile(wf, { handWritten: Boolean(EXECUTORS[wf.id]), providerSettings });

/** Static evidence: derived from the current definition and repository each time, so it is never stale. */
export function staticEvidence(wf: Workflow, profile: WorkflowProfile, fp: Fingerprint, catalogErrors: string[]): Evidence[] {
  const at = new Date().toISOString();
  const ev = (criterion: string, ok: boolean, detail: string, workflowId = wf.id, fingerprint = fp): Evidence => ({
    id: `static:${workflowId}:${criterion}`, qualityRunId: null, workflowId, workflowVersion: wf.version, criterion, mode: "static", status: ok ? "passed" : "failed", detail, fingerprint, data: null, source: "static analysis of the current definition", createdAt: at,
  });
  const out: Evidence[] = [];
  const problems = [...catalogErrors, ...(wf.schemaVersion === 2 ? validateGenericDefinition(wf) : [])];
  out.push(ev("definition_valid", problems.length === 0, problems.length ? problems.slice(0, 3).join("; ") : "Passes catalog validation and the executor's load-time checks."));
  const run = runnability(wf, CANARY_ENV);
  out.push(ev("executor_registered", profile.executable && run.runnable, !profile.executable ? "Definition only (status is not available)." : run.runnable ? `${profile.handWritten ? "Hand-written" : "Generic"} executor registered for v${wf.version}.` : run.reason));
  const [, rest = ""] = wf.description.split(" Who it's for: ");
  const docProblems = [
    ...(rest ? [] : ['description lacks "Who it\'s for:"']),
    ...(rest.includes(" Limitations: ") ? [] : ['description lacks "Limitations:"']),
    ...(wf.problems.length >= 3 ? [] : ["fewer than 3 problem statements"]),
    ...wf.inputs.filter((i) => !i.description?.trim()).map((i) => `input ${i.key} has no description`),
  ];
  out.push(ev("documented", docProblems.length === 0, docProblems.length ? docProblems.join("; ") : "Summary, audience, limitations, problems and every input are documented."));
  const lim = profile.limits;
  const bounded = lim.maxModelCalls !== null && lim.timeoutSeconds <= 600 && lim.maxRetries <= 3;
  out.push(ev("budget_bounded", bounded || profile.handWritten, `${lim.maxModelCalls ?? "executor-defined"} model calls, ${lim.maxRetries} retries, ${lim.timeoutSeconds}s, ${lim.maxOutputTokens ?? "default"} output tokens per call.`));
  const inputProblems = wf.inputs.flatMap((i) => [
    ...(i.label && i.description ? [] : [`${i.key} lacks a label or description`]),
    ...(i.required && (i.type === "text" || i.type === "long_text") && i.example === undefined && !i.shared ? [`${i.key} has no example`] : []),
    ...(i.type === "select" && !(i.options?.length) ? [`${i.key} has no options`] : []),
  ]);
  out.push(ev("inputs_explained", inputProblems.length === 0, inputProblems.length ? inputProblems.slice(0, 4).join("; ") : `All ${wf.inputs.length} inputs are labelled and described.`));
  if (profile.calculation) {
    const c = lookupCalculation(profile.calculation);
    out.push(ev("calculation_registered", Boolean(c && c.formulas.length && Object.keys(c.units).length && c.rounding), c ? `${profile.calculation}: ${c.formulas.length} formulas, units and rounding documented.` : `${profile.calculation} is not registered.`));
  }
  return out;
}

export function runbookEvidence(): Evidence {
  const text = existsSync(/*turbopackIgnore: true*/ RUNBOOK) ? readFileSync(/*turbopackIgnore: true*/ RUNBOOK, "utf8") : "";
  const missing = RUNBOOK_SECTIONS.filter((s) => !new RegExp(`^##+ .*${s}`, "im").test(text));
  return {
    id: "static:*:runbook", qualityRunId: null, workflowId: "*", workflowVersion: null, criterion: "runbook", mode: "static", status: text && !missing.length ? "passed" : "failed",
    detail: !text ? "docs/operations.md is missing." : missing.length ? `docs/operations.md lacks sections: ${missing.join(", ")}.` : `docs/operations.md covers ${RUNBOOK_SECTIONS.join(", ")}.`,
    fingerprint: platformFingerprint(), data: null, source: "static check of docs/operations.md", createdAt: new Date().toISOString(),
  };
}

export interface RealRunMetrics {
  runs: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  /** Only with at least 3 finished runs. */
  avgDurationMs: number | null;
  /** Only with at least 5 finished runs. */
  failureRate: number | null;
  avgTokens: number | null;
  /** Average over runs with a verified price; null when none had one. */
  avgCostUsd: number | null;
}

/** Operational metrics from real package runs (not harness runs). */
export function realRunMetrics(db: DB): Record<string, RealRunMetrics> {
  const rows = db
    .prepare("SELECT w.workflow_id, w.status, w.started_at, w.finished_at, w.usage_json, r.pricing_json FROM workflow_runs w JOIN runs r ON r.id = w.run_id WHERE w.status NOT IN ('pending', 'skipped', 'blocked', 'running') AND w.reused_from IS NULL")
    .all() as Array<{ workflow_id: string; status: string; started_at: string | null; finished_at: string | null; usage_json: string | null; pricing_json: string | null }>;
  const by: Record<string, typeof rows> = {};
  for (const r of rows) (by[r.workflow_id] ??= []).push(r);
  return Object.fromEntries(
    Object.entries(by).map(([id, rs]) => {
      const done = rs.filter((r) => r.started_at && r.finished_at);
      const durations = done.map((r) => Date.parse(r.finished_at!) - Date.parse(r.started_at!));
      const usages = rs.map((r) => (r.usage_json ? (JSON.parse(r.usage_json) as Usage) : null)).filter((u): u is Usage => Boolean(u));
      const costs = rs.map((r) => (r.usage_json && r.pricing_json ? estimateCostUsd(JSON.parse(r.usage_json) as Usage, JSON.parse(r.pricing_json) as PriceBasis) : null)).filter((c): c is number => c !== null);
      const sorted = rs.map((r) => r.finished_at ?? r.started_at ?? "").sort();
      const ok = rs.filter((r) => r.status === "succeeded").map((r) => r.finished_at ?? "").sort();
      return [
        id,
        {
          runs: rs.length,
          lastRunAt: sorted.at(-1) || null,
          lastSuccessAt: ok.at(-1) || null,
          avgDurationMs: durations.length >= 3 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
          failureRate: rs.length >= 5 ? rs.filter((r) => r.status === "failed").length / rs.length : null,
          avgTokens: usages.length ? Math.round(usages.reduce((a, u) => a + u.inputTokens + u.outputTokens, 0) / usages.length) : null,
          avgCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
        },
      ];
    }),
  );
}

export interface WorkflowReadiness {
  workflow: Pick<Workflow, "id" | "name" | "category" | "version" | "summary" | "description" | "status" | "problems">;
  profile: WorkflowProfile;
  fingerprint: Fingerprint;
  golden: { version: number; scenarios: number; rubric: Golden["rubric"] } | null;
  scorecard: Scorecard;
  metrics: RealRunMetrics | null;
  custom: boolean;
}

export interface CatalogReadiness {
  workflows: WorkflowReadiness[];
  goldenErrors: string[];
  generatedAt: string;
}

export async function catalogReadiness(db: DB, opts: { ids?: string[] } = {}): Promise<CatalogReadiness> {
  const catalog = await loadAppCatalog();
  const { goldens, errors: goldenErrors } = loadGoldens();
  const workflows = opts.ids ? catalog.workflows.filter((w) => opts.ids!.includes(w.id)) : catalog.workflows;
  const evidence = listEvidence(db, opts.ids);
  const metrics = realRunMetrics(db);
  const platform = platformFingerprint();
  const runbook = runbookEvidence();
  return {
    goldenErrors,
    generatedAt: new Date().toISOString(),
    workflows: workflows.map((wf) => {
      const profile = profileOf(wf);
      const golden = goldens[wf.id] ?? null;
      const fp = workflowFingerprint(wf, profile, golden?.datasetVersion ?? null);
      const errs = catalog.errors.filter((e) => e.file === catalog.sources[wf.id]).map((e) => e.message);
      const all = [...evidence, ...staticEvidence(wf, profile, fp, errs), runbook];
      return {
        workflow: { id: wf.id, name: wf.name, category: wf.category, version: wf.version, summary: wf.summary, description: wf.description, status: wf.status, problems: wf.problems },
        profile,
        fingerprint: fp,
        golden: golden ? { version: golden.datasetVersion, scenarios: golden.scenarios.length, rubric: golden.rubric } : null,
        scorecard: computeScorecard(profile, all, { workflow: fp, platform }),
        metrics: metrics[wf.id] ?? null,
        custom: catalog.sources[wf.id]?.startsWith("custom/") ?? false,
      };
    }),
  };
}

export interface ReleaseReport {
  requiredLevel: 1 | 2 | 3;
  checked: number;
  passing: string[];
  failing: Array<{ id: string; level: number; release: string; blockers: string[]; missing: string[]; stale: Array<{ criterion: string; reason: string }> }>;
  /** Evidence that went stale because the definition, code or components changed: possible regressions to re-verify. */
  regressions: Array<{ id: string; criterion: string; reason: string }>;
  ok: boolean;
}

/** Release gate: every checked workflow must reach `requiredLevel` with no blockers. Production certification is level 3. */
export function releaseReport(readiness: CatalogReadiness, requiredLevel: 1 | 2 | 3 = 3): ReleaseReport {
  const executable = readiness.workflows.filter((w) => w.profile.executable);
  const failing: ReleaseReport["failing"] = [];
  const passing: string[] = [];
  const regressions: ReleaseReport["regressions"] = [];
  for (const w of executable) {
    const s = w.scorecard;
    const stale = s.criteria.filter((c) => c.status === "stale").map((c) => ({ criterion: c.id, reason: c.staleReason ?? "" }));
    regressions.push(...stale.map((x) => ({ id: w.workflow.id, ...x })));
    if (s.level >= requiredLevel && s.release !== "blocked") passing.push(w.workflow.id);
    else
      failing.push({
        id: w.workflow.id,
        level: s.level,
        release: s.release,
        blockers: s.blockers.map((b) => `${b.id}: ${b.evidence?.detail ?? b.title}`),
        missing: s.criteria.filter((c) => c.level <= requiredLevel && (c.status === "missing" || c.status === "failed")).map((c) => c.id),
        stale,
      });
  }
  return { requiredLevel, checked: executable.length, passing, failing, regressions, ok: failing.length === 0 };
}

/** Runs the automated harness and records MOCKED evidence. Returns a summary. */
export async function verifyAutomated(db: DB, opts: { ids?: string[]; onProgress?: (id: string, passed: number, failed: number) => void } = {}) {
  const catalog = await loadAppCatalog();
  const { goldens } = loadGoldens();
  const runId = startQualityRun(db, "automated");
  const targets = catalog.workflows.filter((w) => w.status === "available" && (!opts.ids || opts.ids.includes(w.id)));
  let passed = 0;
  let failed = 0;
  for (const wf of targets) {
    const profile = profileOf(wf);
    const golden = goldens[wf.id] ?? null;
    const fp = workflowFingerprint(wf, profile, golden?.datasetVersion ?? null);
    const results = await runHarness(wf, profile, golden, catalog.workflows);
    for (const r of results) {
      if (!CRITERION[r.criterion]?.accepts.includes("mocked")) continue;
      recordEvidence(db, { qualityRunId: runId, workflowId: wf.id, workflowVersion: wf.version, criterion: r.criterion, mode: "mocked", status: r.status, detail: r.detail, fingerprint: fp, data: r.data ?? null, source: r.source });
      if (r.status === "passed") passed++;
      else failed++;
    }
    opts.onProgress?.(wf.id, results.filter((r) => r.status === "passed").length, results.filter((r) => r.status === "failed").length);
  }
  const summary = { workflows: targets.length, passed, failed };
  finishQualityRun(db, runId, summary);
  return { runId, ...summary };
}

/** Records platform-wide evidence from a test suite result (security, monitoring). */
export function recordPlatformSuite(db: DB, runId: string, criterion: "platform_security" | "monitoring", suite: { files: string[]; passed: number; failed: number; failures: string[] }) {
  const ok = suite.failed === 0 && suite.passed > 0;
  return recordEvidence(db, {
    qualityRunId: runId, workflowId: "*", workflowVersion: null, criterion, mode: "mocked", status: ok ? "passed" : "failed",
    detail: ok ? `${suite.passed} tests passed in ${suite.files.join(", ")}.` : `${suite.failed} of ${suite.passed + suite.failed} tests failed: ${suite.failures.slice(0, 3).join("; ")}`,
    fingerprint: platformFingerprint(), data: { tests: suite.passed + suite.failed, failed: suite.failed }, source: `vitest ${suite.files.join(" ")}`,
  });
}

/** Records a live execution's evidence. The caller is responsible for having the user's approval to spend credits. */
export function recordLiveExecution(
  db: DB,
  runId: string,
  w: { wf: Workflow; profile: WorkflowProfile; fingerprint: Fingerprint; golden: Golden },
  scenarioId: string,
  outcome: { status: string; reason: string | null; output: unknown; markdown: string | null; criticalFailures: string[]; proposals: number; sources: number; durationMs: number; usage: Usage; provider: string; model: string; costUsd: number | null; toolVersions: string[]; outputId: string },
) {
  const { wf, fingerprint } = w;
  const scenario = w.golden.scenarios.find((s) => s.id === scenarioId)!;
  const data: EvidenceData = {
    durationMs: outcome.durationMs, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, modelCalls: outcome.usage.modelCalls,
    costUsd: outcome.costUsd, provider: outcome.provider, model: outcome.model, toolVersions: outcome.toolVersions, scenario: scenarioId, datasetVersion: w.golden.datasetVersion, outputId: outcome.outputId,
  };
  const rec = (criterion: string, ok: boolean, detail: string) => recordEvidence(db, { qualityRunId: runId, workflowId: wf.id, workflowVersion: wf.version, criterion, mode: "live", status: ok ? "passed" : "failed", detail, fingerprint, data, source: `quality:live ${scenarioId}` });
  const succeeded = outcome.status === "succeeded";
  rec("live_execution", succeeded, `Live ${outcome.provider}/${outcome.model}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}.`);
  if (succeeded) rec("happy_path", true, "Typical scenario accepted in a live run.");
  const live = { ...scenario.expect, values: scenario.expect.values };
  const problems = checkExpectations(live, outcome);
  rec("golden_assertions_live", problems.length === 0, problems.length ? problems.join("; ") : "Live output meets every golden expectation.");
  if (w.profile.executionType === "calculation" && scenario.expect.values) rec("calculation_exact", !problems.some((p) => p.startsWith("calculation.")), problems.filter((p) => p.startsWith("calculation.")).join("; ") || "Live calculated values match exactly.");
  if (w.profile.executionType === "research") rec("tools_live", succeeded && outcome.sources > 0, `${outcome.sources} real source(s) retrieved; ${outcome.status}.`);
  const limitMs = wf.limits.timeoutSeconds * 1000 * 0.8;
  const tokenBudget = (w.profile.limits.maxModelCalls ?? 4) * (w.profile.limits.maxOutputTokens ?? 8000) * 4;
  const costOk = outcome.costUsd !== null ? outcome.costUsd <= 1 : outcome.usage.inputTokens + outcome.usage.outputTokens <= tokenBudget;
  rec("live_latency_cost", outcome.durationMs <= limitMs && costOk, `${Math.round(outcome.durationMs / 1000)}s (limit ${Math.round(limitMs / 1000)}s); ${outcome.costUsd !== null ? `$${outcome.costUsd.toFixed(4)} (limit $1.00)` : `${outcome.usage.inputTokens + outcome.usage.outputTokens} tokens, no verified price (budget ${tokenBudget})`}.`);
  // Reliability across the latest live executions at this exact fingerprint.
  const lives = listEvidence(db, [wf.id]).filter((e) => e.criterion === "live_execution" && e.mode === "live" && JSON.stringify(e.fingerprint) === JSON.stringify(fingerprint));
  const last3 = lives.slice(-3);
  rec("live_reliability", last3.length >= 3 && last3.every((e) => e.status === "passed"), `${lives.length} live run(s) at this version; last ${last3.length}: ${last3.map((e) => e.status).join(", ")}.`);
}

/** Called when an approved action succeeds in live mode: real provider evidence for the workflow that proposed it. */
export function recordProviderLive(db: DB, a: { actionId: string; provider: string; action: string; externalId: string | null; workflow: Workflow }) {
  const profile = profileOf(a.workflow);
  const { goldens } = loadGoldens();
  const fp = workflowFingerprint(a.workflow, profile, goldens[a.workflow.id]?.datasetVersion ?? null);
  return recordEvidence(db, {
    qualityRunId: null, workflowId: a.workflow.id, workflowVersion: a.workflow.version, criterion: "provider_live", mode: "live", status: "passed",
    detail: `${a.provider} confirmed ${a.action}${a.externalId ? ` (id ${a.externalId})` : ""} after approval.`, fingerprint: fp, data: { actionId: a.actionId, provider: a.provider }, source: `action ${a.actionId}`,
  });
}

/** A person's review of a stored live output. The evidence carries the output's fingerprint, so it goes stale with it. */
export function recordHumanReview(db: DB, r: { workflowId: string; workflowVersion: string; outputId: string; fingerprint: Fingerprint; scores: Record<string, number>; verdict: "accept" | "reject"; severity: "none" | "minor" | "major" | "critical"; notes: string; reviewer: string }) {
  const runId = startQualityRun(db, "human");
  const ok = r.verdict === "accept" && (r.severity === "none" || r.severity === "minor");
  const avg = Object.values(r.scores).reduce((a, b) => a + b, 0) / Math.max(1, Object.values(r.scores).length);
  const id = recordEvidence(db, {
    qualityRunId: runId, workflowId: r.workflowId, workflowVersion: r.workflowVersion, criterion: "human_review", mode: "human", status: ok ? "passed" : "failed",
    detail: `${r.reviewer} ${r.verdict === "accept" ? "accepted" : "rejected"} the output (average ${avg.toFixed(1)}/5${r.severity !== "none" ? `, ${r.severity} issue` : ""})${r.notes ? `: ${r.notes}` : "."}`,
    fingerprint: r.fingerprint, data: { scores: r.scores, verdict: r.verdict, severity: r.severity, reviewer: r.reviewer, outputId: r.outputId }, source: `human review of output ${r.outputId}`,
  });
  finishQualityRun(db, runId, { review: id, verdict: r.verdict });
  return id;
}
