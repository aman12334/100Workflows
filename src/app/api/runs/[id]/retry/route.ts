import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { getRun } from "@/lib/server/db/runs";
import { fail } from "@/lib/server/http";
import { loadPackageView } from "@/lib/server/package-service";
import { RunError, startRun } from "@/lib/server/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a new run of the same package that reuses this run's identical accepted results and re-runs the rest. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const run = getRun(db, id);
  if (!run) return fail(404, "not_found", "Run not found.");
  if (run.status === "running") return fail(409, "cannot_run", "This run is still running.");
  const view = await loadPackageView(db, run.packageId);
  if (!view) return fail(404, "not_found", "The package for this run no longer exists.");
  try {
    return NextResponse.json({ runId: startRun(db, view, { retryOf: id }) }, { status: 202 });
  } catch (err) {
    if (err instanceof RunError) return fail(err.status, "cannot_run", err.message);
    throw err;
  }
}
