import "server-only";
import { randomUUID } from "node:crypto";
import type { ProposedAction } from "@/lib/runtime/executors/integration";
import type { DB } from "./index";

export type ActionStatus = "pending_approval" | "approved" | "executing" | "succeeded" | "dry_run" | "failed" | "unconfirmed" | "rejected" | "superseded" | "expired";

export interface ActionRecord {
  id: string;
  workflowRunId: string;
  runId: string;
  proposalKey: string;
  action: string;
  actionVersion: string;
  provider: string;
  sideEffect: string;
  target: string;
  summary: string;
  payload: unknown;
  payloadHash: string;
  status: ActionStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  executedAt: string | null;
  externalId: string | null;
  result: unknown;
  error: string | null;
  errorKind: string | null;
  supersedes: string | null;
  createdAt: string;
  expiresAt: string;
  events: Array<{ event: string; actor: string; detail: string | null; createdAt: string }>;
}

/** Approvals must happen within this window; older proposals expire and need a fresh run. */
export const APPROVAL_TTL_MS = 7 * 24 * 3600 * 1000;
const now = () => new Date().toISOString();

export function addEvent(db: DB, actionId: string, event: string, actor: string, detail: string | null = null) {
  db.prepare("INSERT INTO action_events (id, action_id, event, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), actionId, event, actor, detail?.slice(0, 1000) ?? null, now());
}

export function insertProposals(db: DB, workflowRunId: string, proposals: ProposedAction[], supersedes: string | null = null): string[] {
  const ids: string[] = [];
  db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO action_requests (id, workflow_run_id, proposal_key, action, action_version, provider, side_effect, target, summary, payload_json, payload_hash, status, idempotency_key, supersedes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?)`,
    );
    for (const p of proposals) {
      const id = randomUUID();
      insert.run(id, workflowRunId, p.key, p.action, p.version, p.provider, p.side_effect, p.target.slice(0, 300), p.summary.slice(0, 500), JSON.stringify(p.input), p.payload_hash, `act-${id}`, supersedes, now(), new Date(Date.now() + APPROVAL_TTL_MS).toISOString());
      addEvent(db, id, "proposed", "workflow", `${p.action}@${p.version} → ${p.target}`);
      ids.push(id);
    }
  })();
  return ids;
}

type Row = Record<string, unknown>;
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : null);
function toRecord(db: DB, r: Row): ActionRecord {
  return {
    id: r.id as string,
    workflowRunId: r.workflow_run_id as string,
    runId: r.run_id as string,
    proposalKey: r.proposal_key as string,
    action: r.action as string,
    actionVersion: r.action_version as string,
    provider: r.provider as string,
    sideEffect: r.side_effect as string,
    target: r.target as string,
    summary: r.summary as string,
    payload: json(r.payload_json),
    payloadHash: r.payload_hash as string,
    status: r.status as ActionStatus,
    approvedBy: (r.approved_by as string) ?? null,
    approvedAt: (r.approved_at as string) ?? null,
    executedAt: (r.executed_at as string) ?? null,
    externalId: (r.external_id as string) ?? null,
    result: json(r.result_json),
    error: (r.error as string) ?? null,
    errorKind: (r.error_kind as string) ?? null,
    supersedes: (r.supersedes as string) ?? null,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    events: (db.prepare("SELECT event, actor, detail, created_at AS createdAt FROM action_events WHERE action_id = ? ORDER BY created_at, rowid").all(r.id) as ActionRecord["events"]) ?? [],
  };
}

const SELECT = "SELECT a.*, w.run_id FROM action_requests a JOIN workflow_runs w ON w.id = a.workflow_run_id";

export function getAction(db: DB, id: string): ActionRecord | null {
  const r = db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as Row | undefined;
  return r ? toRecord(db, r) : null;
}

export function listActions(db: DB, filter: { runId?: string; workflowRunId?: string; status?: string } = {}): ActionRecord[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.runId) (where.push("w.run_id = ?"), args.push(filter.runId));
  if (filter.workflowRunId) (where.push("a.workflow_run_id = ?"), args.push(filter.workflowRunId));
  if (filter.status) (where.push("a.status = ?"), args.push(filter.status));
  const rows = db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.created_at DESC, a.rowid LIMIT 500`).all(...args) as Row[];
  return rows.map((r) => toRecord(db, r));
}

/** Atomic status transition: succeeds only if the action is still in `from`. This is what makes approvals single-use. */
export function transition(db: DB, id: string, from: ActionStatus[], to: ActionStatus, fields: Record<string, unknown> = {}): boolean {
  const cols = Object.keys(fields);
  const sets = ["status = ?", ...cols.map((c) => `${c} = ?`)].join(", ");
  const res = db.prepare(`UPDATE action_requests SET ${sets} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`).run(to, ...cols.map((c) => fields[c]), id, ...from);
  return res.changes === 1;
}

/** External ids of executed actions in the same workflow run, by proposal key (dependencies such as "blocks"). */
export function resolvedKeys(db: DB, workflowRunId: string): Record<string, string> {
  const rows = db.prepare("SELECT proposal_key, result_json FROM action_requests WHERE workflow_run_id = ? AND status = 'succeeded'").all(workflowRunId) as Array<{ proposal_key: string; result_json: string | null }>;
  return Object.fromEntries(rows.map((r) => [r.proposal_key, (json(r.result_json) as { id?: string } | null)?.id ?? ""]).filter(([, v]) => v));
}

export function expireStale(db: DB): number {
  const at = now();
  const stale = db.prepare("SELECT id FROM action_requests WHERE status = 'pending_approval' AND expires_at < ?").all(at) as Array<{ id: string }>;
  for (const s of stale) if (transition(db, s.id, ["pending_approval"], "expired")) addEvent(db, s.id, "expired", "system");
  return stale.length;
}
