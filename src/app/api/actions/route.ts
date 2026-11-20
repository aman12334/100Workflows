import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { expireStale, listActions } from "@/lib/server/db/actions";
import { fail } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["pending_approval", "approved", "executing", "succeeded", "dry_run", "failed", "unconfirmed", "rejected", "superseded", "expired"]);

/** Proposed external actions for a run (or all recent ones), with their audit trail. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  if (status && !STATUSES.has(status)) return fail(400, "invalid_request", "Unknown status.");
  const db = getDb();
  expireStale(db);
  return NextResponse.json({ actions: listActions(db, { runId, status }) }, { headers: { "cache-control": "no-store" } });
}
