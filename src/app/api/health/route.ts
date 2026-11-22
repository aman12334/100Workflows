import { NextResponse } from "next/server";
import { loadCatalog } from "@/lib/catalog/load";
import { getDb } from "@/lib/server/db";
import { readMigrations } from "@/lib/server/db/migrate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness and readiness for local process managers. Reachable without signing in,
 * so it reports only counts and states: no settings, keys, paths or user data.
 * 200 when the database is usable and migrations are applied, 503 otherwise.
 */
export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>).map((r) => r.id));
    const pending = readMigrations().filter((m) => !applied.has(m.id)).length;
    checks.database = "ok";
    checks.migrations = { applied: applied.size, pending };
    if (pending) ok = false;
  } catch {
    checks.database = "error";
    ok = false;
  }
  try {
    const catalog = await loadCatalog();
    checks.catalog = { workflows: catalog.workflows.length, errors: catalog.errors.length };
    if (!catalog.workflows.length) ok = false;
  } catch {
    checks.catalog = "error";
    ok = false;
  }
  return NextResponse.json({ ok, ...checks, time: new Date().toISOString() }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
