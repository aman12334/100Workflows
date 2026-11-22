import "server-only";
import { randomUUID } from "node:crypto";
import type { DB } from "./index";

/** Uploaded files: extracted text and metadata only (the original bytes are not kept). Always scoped by workspace. */
export interface StoredFile {
  id: string;
  name: string;
  kind: string;
  sizeBytes: number;
  sha256: string;
  truncated: boolean;
  notes: string | null;
  createdAt: string;
  chars: number;
}

const COLS = "id, name, kind, size_bytes AS sizeBytes, sha256, truncated, notes, created_at AS createdAt, length(text) AS chars";
const toFile = (r: Record<string, unknown>): StoredFile => ({ ...(r as unknown as StoredFile), truncated: r.truncated === 1 });

export function listFiles(db: DB, workspaceId: string): StoredFile[] {
  return (db.prepare(`SELECT ${COLS} FROM files WHERE workspace_id = ? ORDER BY created_at DESC`).all(workspaceId) as Record<string, unknown>[]).map(toFile);
}

export function getFileText(db: DB, workspaceId: string, id: string): { file: StoredFile; text: string } | null {
  const r = db.prepare(`SELECT ${COLS}, text FROM files WHERE workspace_id = ? AND id = ?`).get(workspaceId, id) as (Record<string, unknown> & { text: string }) | undefined;
  return r ? { file: toFile(r), text: r.text } : null;
}

/** Stores a file's text. The same content uploaded twice returns the existing record. */
export function insertFile(db: DB, workspaceId: string, f: { name: string; kind: string; sizeBytes: number; sha256: string; text: string; truncated: boolean; notes: string | null }): { file: StoredFile; duplicate: boolean } {
  const existing = db.prepare("SELECT id FROM files WHERE workspace_id = ? AND sha256 = ?").get(workspaceId, f.sha256) as { id: string } | undefined;
  if (existing) return { file: getFileText(db, workspaceId, existing.id)!.file, duplicate: true };
  const id = randomUUID();
  db.prepare("INSERT INTO files (id, workspace_id, name, kind, size_bytes, sha256, text, truncated, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, workspaceId, f.name, f.kind, f.sizeBytes, f.sha256, f.text, f.truncated ? 1 : 0, f.notes, new Date().toISOString());
  return { file: getFileText(db, workspaceId, id)!.file, duplicate: false };
}

export function deleteFile(db: DB, workspaceId: string, id: string): boolean {
  return db.prepare("DELETE FROM files WHERE workspace_id = ? AND id = ?").run(workspaceId, id).changes === 1;
}
