import "server-only";
import { randomUUID } from "node:crypto";
import { addUsage, emptyUsage, type Usage } from "@/lib/runtime/budget";
import type { Confidence } from "@/lib/runtime/engine";
import type { EvaluatedCriterion, Evaluation } from "@/lib/runtime/evaluation";
import { COST_EXCLUSIONS, estimateCostUsd, noPriceReason, type PriceBasis } from "@/lib/runtime/pricing";
import type { DB } from "./index";

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "needs_review"
  | "failed"
  | "blocked"
  | "skipped"
  | "cancelled"
  | "interrupted";

export interface StepRecord {
  id: string;
  seq: number;
  stepId: string;
  kind: "agent" | "check";
  attempt: number;
  status: "running" | "done" | "failed";
  detail: string | null;
  error: string | null;
  usage: Usage | null;
  startedAt: string;
  finishedAt: string | null;
  /** Wall-clock time from start to finish; null while running. */
  durationMs: number | null;
  /** Estimated US dollars; null when the run has no verified price or the step made no model calls. */
  costUsd: number | null;
}

export interface EvaluationRecord {
  attempt: number;
  score: number | null;
  passed: boolean;
  decision: Evaluation["decision"];
  criteria: EvaluatedCriterion[];
  threshold: number;
  criticalFailures: string[];
  createdAt: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  version: string;
  position: number;
  status: WorkflowRunStatus;
  statusReason: string | null;
  attempts: number;
  qualityScore: number | null;
  decision: string | null;
  confidence: Confidence | null;
  output: unknown;
  markdown: string | null;
  usage: Usage | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  steps: StepRecord[];
  evaluations: EvaluationRecord[];
}

export interface RunRecord {
  id: string;
  packageId: string;
  status: RunStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Provider and model the run was configured with; null for runs recorded before migration 004. */
  provider: string | null;
  model: string | null;
  /** The verified price snapshotted at run start, or null (unknown model, or an older run). */
  pricing: PriceBasis | null;
  summary: RunUsageSummary;
  workflows: WorkflowRunRecord[];
}

/** Totals across every workflow in a run. */
export interface RunUsageSummary {
  usage: Usage;
  durationMs: number | null;
  /** Null when no verified price applies; see costNote. */
  costUsd: number | null;
  /** What the estimate covers, or why there is none. */
  costNote: string;
}

export interface RunMeta {
  provider: string;
  model: string;
  pricing: PriceBasis | null;
}

const now = () => new Date().toISOString();
const json = <T>(v: string | null): T | null => (v ? (JSON.parse(v) as T) : null);

export function createRun(
  db: DB,
  packageId: string,
  workflows: Array<{ workflowId: string; version: string; status: WorkflowRunStatus; reason?: string }>,
  meta?: RunMeta,
): { runId: string; workflowRunIds: string[] } {
  const runId = randomUUID();
  const ids = workflows.map(() => randomUUID());
  db.transaction(() => {
    db.prepare("INSERT INTO runs (id, package_id, status, created_at, started_at, provider, model, pricing_json) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)").run(
      runId,
      packageId,
      now(),
      now(),
      meta?.provider ?? null,
      meta?.model ?? null,
      meta?.pricing ? JSON.stringify(meta.pricing) : null,
    );
    const insert = db.prepare(
      "INSERT INTO workflow_runs (id, run_id, workflow_id, version, position, status, status_reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    workflows.forEach((w, i) => insert.run(ids[i], runId, w.workflowId, w.version, i + 1, w.status, w.reason ?? null));
  })();
  return { runId, workflowRunIds: ids };
}

export function activeRunFor(db: DB, packageId: string): string | null {
  const row = db.prepare("SELECT id FROM runs WHERE package_id = ? AND status = 'running' LIMIT 1").get(packageId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function setWorkflowRunStatus(db: DB, id: string, status: WorkflowRunStatus, reason: string | null = null) {
  const stamp = status === "running" ? "started_at" : "finished_at";
  db.prepare(`UPDATE workflow_runs SET status = ?, status_reason = ?, ${stamp} = ? WHERE id = ?`).run(status, reason, now(), id);
}

export function finishWorkflowRun(
  db: DB,
  id: string,
  outcome: {
    status: WorkflowRunStatus;
    reason?: string;
    attempts: number;
    qualityScore: number | null;
    decision: string | null;
    confidence: Confidence | null;
    result: { json: unknown; markdown: string } | null;
    usage: Usage;
  },
) {
  db.prepare(
    `UPDATE workflow_runs SET status = ?, status_reason = ?, attempts = ?, quality_score = ?, decision = ?, confidence_json = ?,
       output_json = ?, output_markdown = ?, usage_json = ?, finished_at = ? WHERE id = ?`,
  ).run(
    outcome.status,
    outcome.reason ?? null,
    outcome.attempts,
    outcome.qualityScore,
    outcome.decision,
    outcome.confidence ? JSON.stringify(outcome.confidence) : null,
    outcome.result ? JSON.stringify(outcome.result.json) : null,
    outcome.result?.markdown ?? null,
    JSON.stringify(outcome.usage),
    now(),
    id,
  );
}

export function finishRun(db: DB, runId: string, status: RunStatus, error: string | null = null) {
  db.prepare("UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error, now(), runId);
}

export function insertStep(db: DB, workflowRunId: string, stepId: string, kind: "agent" | "check", attempt: number): string {
  const id = randomUUID();
  db.transaction(() => {
    const { next } = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_steps WHERE workflow_run_id = ?").get(workflowRunId) as { next: number };
    db.prepare("INSERT INTO run_steps (id, workflow_run_id, seq, step_id, kind, attempt, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)").run(
      id,
      workflowRunId,
      next,
      stepId,
      kind,
      attempt,
      now(),
    );
  })();
  return id;
}

export function finishStep(db: DB, id: string, status: "done" | "failed", detail: string | null, error: string | null, usage?: Usage) {
  db.prepare("UPDATE run_steps SET status = ?, detail = ?, error = ?, usage_json = ?, finished_at = ? WHERE id = ?").run(
    status,
    detail,
    error,
    usage ? JSON.stringify(usage) : null,
    now(),
    id,
  );
}

export function insertEvaluation(db: DB, workflowRunId: string, e: Evaluation) {
  db.prepare(
    "INSERT INTO evaluations (id, workflow_run_id, attempt, score, passed, decision, criteria_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    randomUUID(),
    workflowRunId,
    e.attempt,
    e.score,
    e.passed ? 1 : 0,
    e.decision,
    JSON.stringify({ criteria: e.criteria, threshold: e.threshold, criticalFailures: e.criticalFailures }),
    now(),
  );
}

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  version: string;
  position: number;
  status: WorkflowRunStatus;
  status_reason: string | null;
  attempts: number;
  quality_score: number | null;
  decision: string | null;
  confidence_json: string | null;
  output_json: string | null;
  output_markdown: string | null;
  usage_json: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const durationMs = (from: string | null, to: string | null): number | null =>
  from && to ? Math.max(0, new Date(to).getTime() - new Date(from).getTime()) : null;

export function getRun(db: DB, runId: string): RunRecord | null {
  const row = db
    .prepare(
      "SELECT id, package_id AS packageId, status, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, provider, model, pricing_json FROM runs WHERE id = ?",
    )
    .get(runId) as (Omit<RunRecord, "workflows" | "pricing" | "summary"> & { pricing_json: string | null }) | undefined;
  if (!row) return null;
  const { pricing_json, ...run } = row;
  const pricing = json<PriceBasis>(pricing_json);
  const cost = (usage: Usage | null) => (usage && usage.modelCalls > 0 ? estimateCostUsd(usage, pricing) : pricing && usage ? 0 : null);
  const rows = db.prepare("SELECT * FROM workflow_runs WHERE run_id = ? ORDER BY position").all(runId) as WorkflowRunRow[];
  const steps = db.prepare("SELECT * FROM run_steps WHERE workflow_run_id = ? ORDER BY seq");
  const evals = db.prepare("SELECT * FROM evaluations WHERE workflow_run_id = ? ORDER BY attempt");
  const workflows: WorkflowRunRecord[] = rows.map((r) => ({
    id: r.id,
    workflowId: r.workflow_id,
    version: r.version,
    position: r.position,
    status: r.status,
    statusReason: r.status_reason,
    attempts: r.attempts,
    qualityScore: r.quality_score,
    decision: r.decision,
    confidence: json<Confidence>(r.confidence_json),
    output: json(r.output_json),
    markdown: r.output_markdown,
    usage: json<Usage>(r.usage_json),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: durationMs(r.started_at, r.finished_at),
    costUsd: cost(json<Usage>(r.usage_json)),
    steps: (steps.all(r.id) as Array<Record<string, unknown>>).map((s) => ({
      id: s.id as string,
      seq: s.seq as number,
      stepId: s.step_id as string,
      kind: s.kind as "agent" | "check",
      attempt: s.attempt as number,
      status: s.status as StepRecord["status"],
      detail: s.detail as string | null,
      error: s.error as string | null,
      usage: json<Usage>(s.usage_json as string | null),
      startedAt: s.started_at as string,
      finishedAt: s.finished_at as string | null,
      durationMs: durationMs(s.started_at as string, s.finished_at as string | null),
      costUsd: cost(json<Usage>(s.usage_json as string | null)),
    })),
    evaluations: (evals.all(r.id) as Array<Record<string, unknown>>).map((e) => {
      const body = JSON.parse(e.criteria_json as string) as { criteria: EvaluatedCriterion[]; threshold: number; criticalFailures: string[] };
      return {
        attempt: e.attempt as number,
        score: e.score as number | null,
        passed: e.passed === 1,
        decision: e.decision as Evaluation["decision"],
        criteria: body.criteria,
        threshold: body.threshold,
        criticalFailures: body.criticalFailures,
        createdAt: e.created_at as string,
      };
    }),
  }));
  return { ...run, pricing, summary: summarize(run, workflows, pricing), workflows };
}

function summarize(
  run: { model: string | null; startedAt: string | null; finishedAt: string | null },
  workflows: WorkflowRunRecord[],
  pricing: PriceBasis | null,
): RunUsageSummary {
  const usage = workflows.reduce((total, w) => (w.usage ? addUsage(total, w.usage) : total), emptyUsage());
  return {
    usage,
    durationMs: durationMs(run.startedAt, run.finishedAt),
    costUsd: pricing ? estimateCostUsd(usage, pricing) : null,
    costNote: pricing
      ? `${COST_EXCLUSIONS} Prices: $${pricing.inputPerMTok} / $${pricing.outputPerMTok} per million input / output tokens for ${pricing.model}.`
      : noPriceReason(run.model),
  };
}

export interface RunSummary {
  id: string;
  packageId: string;
  packageName: string;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  counts: Record<string, number>;
}

export function listRuns(db: DB, opts: { packageId?: string; limit?: number } = {}): RunSummary[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.package_id AS packageId, p.name AS packageName, r.status, r.created_at AS createdAt, r.finished_at AS finishedAt
       FROM runs r JOIN packages p ON p.id = r.package_id ${opts.packageId ? "WHERE r.package_id = ?" : ""}
       ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(...(opts.packageId ? [opts.packageId, opts.limit ?? 50] : [opts.limit ?? 50])) as Omit<RunSummary, "counts">[];
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM workflow_runs WHERE run_id = ? GROUP BY status");
  return rows.map((r) => ({
    ...r,
    counts: Object.fromEntries((counts.all(r.id) as Array<{ status: string; n: number }>).map((c) => [c.status, c.n])),
  }));
}

/** Runs that were in flight when the server stopped can't resume; mark them so the UI doesn't show them as live. */
export function markInterrupted(db: DB): number {
  return db.transaction(() => {
    const at = now();
    db.prepare("UPDATE workflow_runs SET status = 'interrupted', status_reason = 'The server stopped while this was running.', finished_at = ? WHERE status IN ('pending', 'running') AND run_id IN (SELECT id FROM runs WHERE status = 'running')").run(at);
    db.prepare("UPDATE run_steps SET status = 'failed', error = 'Interrupted', finished_at = ? WHERE status = 'running'").run(at);
    return db.prepare("UPDATE runs SET status = 'interrupted', error = 'The server stopped during this run.', finished_at = ? WHERE status = 'running'").run(at).changes;
  })();
}
