import "server-only";
import { randomUUID } from "node:crypto";
import { addUsage, emptyUsage, type Usage } from "@/lib/runtime/budget";
import type { Confidence } from "@/lib/runtime/engine";
import type { EvaluatedCriterion, Evaluation } from "@/lib/runtime/evaluation";
import { COST_EXCLUSIONS, estimateCostUsd, noPriceReason, type PriceBasis } from "@/lib/runtime/pricing";
import type { ToolCallRecord } from "@/lib/runtime/tools/runner";
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
  /** Tool calls in order (empty for runs before migration 005 and for model-only workflows). */
  toolCalls: Array<ToolCallRecord & { seq: number }>;
  evaluations: EvaluationRecord[];
  /** Set when this result was reused from an earlier run's identical, accepted result instead of executing again. */
  reusedFrom: { workflowRunId: string; runId: string } | null;
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
  /** The run this one retried, if any. */
  retryOf: string | null;
}

/** Totals across every workflow in a run. */
export interface RunUsageSummary {
  usage: Usage;
  /** Tool calls by tool id, with how many failed. */
  tools: Record<string, { calls: number; failed: number }>;
  /** Tool costs are never estimated: what they are, in plain language. */
  toolCostNote: string | null;
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

export function setInputsHash(db: DB, workflowRunId: string, hash: string) {
  db.prepare("UPDATE workflow_runs SET inputs_hash = ? WHERE id = ?").run(hash, workflowRunId);
}

/** Accepted results of a run that can be reused by a retry: workflow id → workflow run id and fingerprint. */
export function reusableResults(db: DB, runId: string): Map<string, { workflowRunId: string; hash: string; output: unknown }> {
  const rows = db.prepare("SELECT id, workflow_id, inputs_hash, output_json FROM workflow_runs WHERE run_id = ? AND status = 'succeeded' AND inputs_hash IS NOT NULL").all(runId) as Array<{ id: string; workflow_id: string; inputs_hash: string; output_json: string | null }>;
  return new Map(rows.map((r) => [r.workflow_id, { workflowRunId: r.id, hash: r.inputs_hash, output: json(r.output_json) }]));
}

/**
 * Copies an accepted result (output, score, checks) into a retry's workflow run instead of executing it again.
 * Usage is not copied, so the retry's cost covers only what it executed. Proposed actions are not copied:
 * they stay with (and are approved on) the original run.
 */
export function reuseWorkflowResult(db: DB, fromId: string, toId: string) {
  db.transaction(() => {
    db.prepare(
      `UPDATE workflow_runs SET (status, status_reason, attempts, quality_score, decision, confidence_json, output_json, output_markdown, inputs_hash, started_at, finished_at) =
         (SELECT 'succeeded', 'Reused the accepted result of an earlier run: same version, inputs and upstream results.', attempts, quality_score, decision, confidence_json, output_json, output_markdown, inputs_hash, ?, ? FROM workflow_runs WHERE id = ?),
         reused_from = ? WHERE id = ?`,
    ).run(now(), now(), fromId, fromId, toId);
    const evals = db.prepare("SELECT attempt, score, passed, decision, criteria_json, created_at FROM evaluations WHERE workflow_run_id = ?").all(fromId) as Array<Record<string, unknown>>;
    const insert = db.prepare("INSERT INTO evaluations (id, workflow_run_id, attempt, score, passed, decision, criteria_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const e of evals) insert.run(randomUUID(), toId, e.attempt, e.score, e.passed, e.decision, e.criteria_json, e.created_at);
  })();
}

export function setRetryOf(db: DB, runId: string, retryOf: string) {
  db.prepare("UPDATE runs SET retry_of = ? WHERE id = ?").run(retryOf, runId);
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

export function insertToolCall(db: DB, workflowRunId: string, c: ToolCallRecord) {
  db.transaction(() => {
    const { next } = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tool_calls WHERE workflow_run_id = ?").get(workflowRunId) as { next: number };
    db.prepare(
      `INSERT INTO tool_calls (id, workflow_run_id, seq, step_id, tool_id, tool_version, status, error_kind, error, attempts, target, started_at, finished_at, duration_ms, input_bytes, output_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), workflowRunId, next, c.stepId, c.toolId, c.toolVersion, c.status, c.errorKind, c.error, c.attempts, c.target, c.startedAt, c.finishedAt, c.durationMs, c.inputBytes, c.outputBytes);
  })();
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
  reused_from: string | null;
}

const durationMs = (from: string | null, to: string | null): number | null =>
  from && to ? Math.max(0, new Date(to).getTime() - new Date(from).getTime()) : null;

export function getRun(db: DB, runId: string): RunRecord | null {
  const row = db
    .prepare(
      "SELECT id, package_id AS packageId, status, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, provider, model, pricing_json, retry_of AS retryOf FROM runs WHERE id = ?",
    )
    .get(runId) as (Omit<RunRecord, "workflows" | "pricing" | "summary"> & { pricing_json: string | null }) | undefined;
  const reusedRun = db.prepare("SELECT run_id FROM workflow_runs WHERE id = ?");
  if (!row) return null;
  const { pricing_json, ...run } = row;
  const pricing = json<PriceBasis>(pricing_json);
  const cost = (usage: Usage | null) => (usage && usage.modelCalls > 0 ? estimateCostUsd(usage, pricing) : pricing && usage ? 0 : null);
  const rows = db.prepare("SELECT * FROM workflow_runs WHERE run_id = ? ORDER BY position").all(runId) as WorkflowRunRow[];
  const steps = db.prepare("SELECT * FROM run_steps WHERE workflow_run_id = ? ORDER BY seq");
  const evals = db.prepare("SELECT * FROM evaluations WHERE workflow_run_id = ? ORDER BY attempt");
  const toolRows = db.prepare("SELECT * FROM tool_calls WHERE workflow_run_id = ? ORDER BY seq");
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
    reusedFrom: r.reused_from ? { workflowRunId: r.reused_from, runId: (reusedRun.get(r.reused_from) as { run_id: string } | undefined)?.run_id ?? "" } : null,
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
    toolCalls: (toolRows.all(r.id) as Array<Record<string, unknown>>).map((t) => ({
      seq: t.seq as number,
      stepId: t.step_id as string,
      toolId: t.tool_id as string,
      toolVersion: t.tool_version as string,
      status: t.status as "ok" | "error",
      errorKind: (t.error_kind as ToolCallRecord["errorKind"]) ?? null,
      error: (t.error as string | null) ?? null,
      attempts: t.attempts as number,
      target: t.target as string,
      startedAt: t.started_at as string,
      finishedAt: t.finished_at as string,
      durationMs: t.duration_ms as number,
      inputBytes: t.input_bytes as number,
      outputBytes: t.output_bytes as number,
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
  const tools: RunUsageSummary["tools"] = {};
  for (const c of workflows.flatMap((w) => w.toolCalls)) {
    const t = (tools[c.toolId] ??= { calls: 0, failed: 0 });
    t.calls++;
    if (c.status === "error") t.failed++;
  }
  const notes = [
    usage.webSearches ? `${usage.webSearches} web search${usage.webSearches === 1 ? "" : "es"} not priced (no verified price; billed by Anthropic separately from tokens)` : "",
    tools["web-fetch"] ? `${tools["web-fetch"].calls} page read${tools["web-fetch"].calls === 1 ? "" : "s"} run on this computer (no provider charge)` : "",
  ].filter(Boolean);
  return {
    usage,
    tools,
    toolCostNote: notes.length ? `Tool costs: ${notes.join("; ")}.` : null,
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
  workflowIds: string[];
  /** Proposed external actions still waiting for a person. */
  pendingActions: number;
}

export interface RunFilter {
  packageId?: string;
  status?: string;
  /** Runs that include this workflow. */
  workflowId?: string;
  /** Text matched against the package name and workflow ids. */
  q?: string;
  /** ISO date or date-time: runs created at or after. */
  since?: string;
  limit?: number;
}

export function listRuns(db: DB, opts: RunFilter = {}): RunSummary[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.packageId) (where.push("r.package_id = ?"), args.push(opts.packageId));
  if (opts.status) (where.push("r.status = ?"), args.push(opts.status));
  if (opts.workflowId) (where.push("EXISTS (SELECT 1 FROM workflow_runs w WHERE w.run_id = r.id AND w.workflow_id = ?)"), args.push(opts.workflowId));
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(lower(p.name) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM workflow_runs w WHERE w.run_id = r.id AND w.workflow_id LIKE ? ESCAPE '\\'))");
    args.push(like, like);
  }
  if (opts.since && !Number.isNaN(Date.parse(opts.since))) (where.push("r.created_at >= ?"), args.push(new Date(opts.since).toISOString()));
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = db
    .prepare(
      `SELECT r.id, r.package_id AS packageId, p.name AS packageName, r.status, r.created_at AS createdAt, r.finished_at AS finishedAt
       FROM runs r JOIN packages p ON p.id = r.package_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(...args, limit) as Array<Omit<RunSummary, "counts" | "workflowIds" | "pendingActions">>;
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM workflow_runs WHERE run_id = ? GROUP BY status");
  const ids = db.prepare("SELECT workflow_id FROM workflow_runs WHERE run_id = ? ORDER BY position");
  const pending = db.prepare("SELECT COUNT(*) AS n FROM action_requests a JOIN workflow_runs w ON w.id = a.workflow_run_id WHERE w.run_id = ? AND a.status = 'pending_approval'");
  return rows.map((r) => ({
    ...r,
    counts: Object.fromEntries((counts.all(r.id) as Array<{ status: string; n: number }>).map((c) => [c.status, c.n])),
    workflowIds: (ids.all(r.id) as Array<{ workflow_id: string }>).map((x) => x.workflow_id),
    pendingActions: (pending.get(r.id) as { n: number }).n,
  }));
}

export interface WorkflowStats {
  workflowId: string;
  runs: number;
  succeeded: number;
  needsReview: number;
  failed: number;
  avgQuality: number | null;
  avgAttempts: number | null;
  lastRunAt: string;
}

/** Per-workflow outcomes across run history, for spotting workflows that often need review or fail. */
export function workflowStats(db: DB): WorkflowStats[] {
  return db
    .prepare(
      `SELECT workflow_id AS workflowId, COUNT(*) AS runs,
              SUM(status = 'succeeded') AS succeeded, SUM(status = 'needs_review') AS needsReview, SUM(status = 'failed') AS failed,
              AVG(quality_score) AS avgQuality, AVG(NULLIF(attempts, 0)) AS avgAttempts, MAX(COALESCE(finished_at, started_at, '')) AS lastRunAt
       FROM workflow_runs WHERE status NOT IN ('pending', 'skipped', 'blocked') GROUP BY workflow_id ORDER BY runs DESC, workflowId`,
    )
    .all() as WorkflowStats[];
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
