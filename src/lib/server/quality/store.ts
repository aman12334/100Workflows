import "server-only";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DB } from "@/lib/server/db";
import type { Evidence, EvidenceData, EvidenceMode, Fingerprint } from "@/lib/quality/types";

/** Evidence is append-only: newer records supersede older ones in the scorecard, nothing is edited or deleted. */

const now = () => new Date().toISOString();

function gitState(): { commit: string | null; dirty: boolean | null } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

export function startQualityRun(db: DB, kind: "automated" | "live" | "human" | "platform"): string {
  const id = randomUUID();
  const g = gitState();
  db.prepare("INSERT INTO quality_runs (id, kind, git_commit, git_dirty, started_at) VALUES (?, ?, ?, ?, ?)").run(id, kind, g.commit, g.dirty === null ? null : g.dirty ? 1 : 0, now());
  return id;
}

export function finishQualityRun(db: DB, id: string, summary: Record<string, unknown>) {
  db.prepare("UPDATE quality_runs SET finished_at = ?, summary_json = ? WHERE id = ?").run(now(), JSON.stringify(summary), id);
}

export interface NewEvidence {
  qualityRunId: string | null;
  workflowId: string;
  workflowVersion: string | null;
  criterion: string;
  mode: EvidenceMode;
  status: "passed" | "failed";
  detail: string;
  fingerprint: Fingerprint;
  data?: EvidenceData | null;
  source: string;
}

const SECRET = /(sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9]{16,}|xox[bp]-[A-Za-z0-9-]{8,}|rk_(live|test)_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{16,})/g;
/** Last line of defence: evidence text is redacted before it is stored. */
const redact = (s: string) => s.replace(SECRET, "[redacted]");

export function recordEvidence(db: DB, e: NewEvidence): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO quality_evidence (id, quality_run_id, workflow_id, workflow_version, criterion, mode, status, detail, fingerprint_json, data_json, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, e.qualityRunId, e.workflowId, e.workflowVersion, e.criterion, e.mode, e.status, redact(e.detail).slice(0, 2000), JSON.stringify(e.fingerprint), e.data ? redact(JSON.stringify(e.data)) : null, e.source.slice(0, 300), now());
  return id;
}

type Row = Record<string, unknown>;
const toEvidence = (r: Row): Evidence => ({
  id: r.id as string,
  qualityRunId: (r.quality_run_id as string) ?? null,
  workflowId: r.workflow_id as string,
  workflowVersion: (r.workflow_version as string) ?? null,
  criterion: r.criterion as string,
  mode: r.mode as EvidenceMode,
  status: r.status as "passed" | "failed",
  detail: r.detail as string,
  fingerprint: JSON.parse(r.fingerprint_json as string) as Fingerprint,
  data: r.data_json ? (JSON.parse(r.data_json as string) as EvidenceData) : null,
  source: r.source as string,
  createdAt: r.created_at as string,
});

/** All evidence for the given workflows (plus platform evidence), oldest first. */
export function listEvidence(db: DB, workflowIds?: string[]): Evidence[] {
  const rows = workflowIds
    ? (db.prepare(`SELECT * FROM quality_evidence WHERE workflow_id IN (${[...workflowIds, "*"].map(() => "?").join(",")}) ORDER BY created_at, rowid`).all(...workflowIds, "*") as Row[])
    : (db.prepare("SELECT * FROM quality_evidence ORDER BY created_at, rowid").all() as Row[]);
  return rows.map(toEvidence);
}

export function getEvidence(db: DB, id: string): Evidence | null {
  const r = db.prepare("SELECT * FROM quality_evidence WHERE id = ?").get(id) as Row | undefined;
  return r ? toEvidence(r) : null;
}

export function listQualityRuns(db: DB, limit = 20) {
  return (db.prepare("SELECT * FROM quality_runs ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    gitCommit: (r.git_commit as string) ?? null,
    gitDirty: r.git_dirty === null ? null : r.git_dirty === 1,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
    summary: r.summary_json ? (JSON.parse(r.summary_json as string) as Record<string, unknown>) : null,
  }));
}

export function storeOutput(db: DB, o: { qualityRunId: string | null; workflowId: string; workflowVersion: string; scenario: string; status: string; output: unknown; markdown: string | null; fingerprint: Fingerprint }): string {
  const id = randomUUID();
  db.prepare("INSERT INTO quality_outputs (id, quality_run_id, workflow_id, workflow_version, scenario, status, output_json, output_markdown, fingerprint_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, o.qualityRunId, o.workflowId, o.workflowVersion, o.scenario, o.status, o.output === undefined ? null : redact(JSON.stringify(o.output)), o.markdown ? redact(o.markdown) : null, JSON.stringify(o.fingerprint), now(),
  );
  return id;
}

export function listOutputs(db: DB, workflowId: string) {
  return (db.prepare("SELECT * FROM quality_outputs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 20").all(workflowId) as Row[]).map((r) => ({
    id: r.id as string,
    workflowVersion: r.workflow_version as string,
    scenario: r.scenario as string,
    status: r.status as string,
    output: r.output_json ? JSON.parse(r.output_json as string) : null,
    markdown: (r.output_markdown as string) ?? null,
    fingerprint: JSON.parse(r.fingerprint_json as string) as Fingerprint,
    createdAt: r.created_at as string,
  }));
}

export function getOutput(db: DB, id: string) {
  const r = db.prepare("SELECT workflow_id, fingerprint_json, workflow_version, scenario FROM quality_outputs WHERE id = ?").get(id) as Row | undefined;
  return r ? { workflowId: r.workflow_id as string, fingerprint: JSON.parse(r.fingerprint_json as string) as Fingerprint, workflowVersion: r.workflow_version as string, scenario: r.scenario as string } : null;
}
