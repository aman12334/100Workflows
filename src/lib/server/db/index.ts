import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { log } from "../log";
import { migrate } from "./migrate";
import { markInterrupted } from "./runs";

export type DB = Database.Database;

export const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "100-workflows.db");

export function openDatabase(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(/*turbopackIgnore: true*/ file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

// Survives hot reloads in dev so we don't open a new connection on every edit.
const globalForDb = globalThis as unknown as { workflowsDb?: DB };

/** The app's database, created and migrated on first use. */
export function getDb(): DB {
  if (!globalForDb.workflowsDb) {
    const file = process.env.WORKFLOWS_DB_PATH?.trim() || DEFAULT_DB_PATH;
    const db = openDatabase(file);
    const ran = migrate(db);
    if (ran.length) log.info("db.migrated", { file, applied: ran });
    const interrupted = markInterrupted(db);
    if (interrupted) log.warn("runs.interrupted", { count: interrupted });
    globalForDb.workflowsDb = db;
  }
  return globalForDb.workflowsDb;
}
