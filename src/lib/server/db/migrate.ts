import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");

/** Migrations are numbered SQL files, applied in file-name order. */
export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ""), sql: readFileSync(path.join(/*turbopackIgnore: true*/ dir, f), "utf8") }));
}

/**
 * Applies pending migrations, each in its own transaction. Refuses to run if an
 * already-applied migration was edited, because that would leave databases
 * created before and after the edit with different schemas.
 */
export function migrate(db: Database.Database, migrations: Migration[] = readMigrations()): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Map(
    (db.prepare("SELECT id, checksum FROM schema_migrations").all() as Array<{ id: string; checksum: string }>).map((r) => [r.id, r.checksum]),
  );

  for (const m of migrations) {
    const known = applied.get(m.id);
    if (known && known !== checksum(m.sql)) {
      throw new Error(`Migration ${m.id} was modified after it was applied. Add a new migration instead of editing an old one.`);
    }
  }

  const ran: string[] = [];
  const record = db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)");
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.id, checksum(m.sql), new Date().toISOString());
    })();
    ran.push(m.id);
  }
  return ran;
}
