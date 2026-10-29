// Creates the SQLite database if needed and applies pending migrations.
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../src/lib/server/db/migrate";

const file = process.env.WORKFLOWS_DB_PATH?.trim() || path.join(process.cwd(), "data", "100-workflows.db");
mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma("foreign_keys = ON");
try {
  const ran = migrate(db);
  console.log(ran.length ? `Applied ${ran.length} migration(s) to ${file}:\n  ${ran.join("\n  ")}` : `Database is up to date: ${file}`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
} finally {
  db.close();
}
