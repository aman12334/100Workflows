import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./index";

/** Saved context (company profile, tone, ICP...) a person can insert into workflow inputs. Always scoped by workspace. */
export interface ContextItem {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export const CONTEXT_LIMITS = { title: 120, body: 20_000, items: 200 };
export const ContextBody = z.object({ title: z.string().trim().min(1).max(CONTEXT_LIMITS.title), body: z.string().trim().min(1).max(CONTEXT_LIMITS.body) }).strict();
const COLS = "id, title, body, created_at AS createdAt, updated_at AS updatedAt";

export function listContext(db: DB, workspaceId: string): ContextItem[] {
  return db.prepare(`SELECT ${COLS} FROM context_items WHERE workspace_id = ? ORDER BY updated_at DESC`).all(workspaceId) as ContextItem[];
}

export function getContext(db: DB, workspaceId: string, id: string): ContextItem | null {
  return (db.prepare(`SELECT ${COLS} FROM context_items WHERE workspace_id = ? AND id = ?`).get(workspaceId, id) as ContextItem | undefined) ?? null;
}

export function saveContext(db: DB, workspaceId: string, item: { id?: string; title: string; body: string }): ContextItem | null {
  const at = new Date().toISOString();
  if (item.id) {
    const res = db.prepare("UPDATE context_items SET title = ?, body = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(item.title, item.body, at, workspaceId, item.id);
    return res.changes ? getContext(db, workspaceId, item.id) : null;
  }
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM context_items WHERE workspace_id = ?").get(workspaceId) as { n: number };
  if (n >= CONTEXT_LIMITS.items) throw new Error(`You can keep up to ${CONTEXT_LIMITS.items} context items. Delete some first.`);
  const id = randomUUID();
  db.prepare("INSERT INTO context_items (id, workspace_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, workspaceId, item.title, item.body, at, at);
  return getContext(db, workspaceId, id);
}

export function deleteContext(db: DB, workspaceId: string, id: string): boolean {
  return db.prepare("DELETE FROM context_items WHERE workspace_id = ? AND id = ?").run(workspaceId, id).changes === 1;
}
