import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { fail } from "@/lib/server/http";
import { catalogReadiness } from "@/lib/server/quality/service";
import { listEvidence, listOutputs } from "@/lib/server/quality/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One workflow's scorecard with its full evidence history and the live outputs available for review. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const readiness = await catalogReadiness(db, { ids: [id] });
  const w = readiness.workflows[0];
  if (!w) return fail(404, "not_found", "Workflow not found.");
  return NextResponse.json({ ...w, history: listEvidence(db, [id]), outputs: listOutputs(db, id) }, { headers: { "cache-control": "no-store" } });
}
