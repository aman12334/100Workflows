import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { fail } from "@/lib/server/http";
import { loadPackageView } from "@/lib/server/package-service";
import { RunError, startRun } from "@/lib/server/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a run of the package. Execution continues in the background; poll GET /api/runs/:id. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const view = await loadPackageView(db, id);
  if (!view) return fail(404, "not_found", "Package not found.");
  try {
    return NextResponse.json({ runId: startRun(db, view) }, { status: 202 });
  } catch (err) {
    if (err instanceof RunError) return fail(err.status, "cannot_run", err.message);
    throw err;
  }
}
