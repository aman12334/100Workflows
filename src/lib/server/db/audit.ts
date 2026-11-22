import "server-only";
import { randomUUID } from "node:crypto";
import type { DB } from "./index";

export function audit(db: DB, workspaceId: string, event: string, actor: string, detail: string | null = null) {
  db.prepare("INSERT INTO audit_events (id, workspace_id, event, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), workspaceId, event, actor.slice(0, 80), detail?.slice(0, 500) ?? null, new Date().toISOString());
}

export function listAudit(db: DB, workspaceId: string, limit = 100) {
  return db.prepare("SELECT event, actor, detail, created_at AS createdAt FROM audit_events WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workspaceId, Math.min(limit, 500)) as Array<{ event: string; actor: string; detail: string | null; createdAt: string }>;
}
