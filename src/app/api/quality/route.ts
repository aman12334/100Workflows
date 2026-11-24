import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { catalogReadiness, releaseReport } from "@/lib/server/quality/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Readiness of every workflow, derived from recorded evidence, plus the level-3 release report. */
export async function GET() {
  const readiness = await catalogReadiness(getDb());
  return NextResponse.json(
    {
      generatedAt: readiness.generatedAt,
      goldenErrors: readiness.goldenErrors,
      release: releaseReport(readiness, 3),
      workflows: readiness.workflows.map((w) => ({ ...w, scorecard: { ...w.scorecard, criteria: w.scorecard.criteria.map((c) => ({ ...c, evidence: c.evidence ? { id: c.evidence.id, mode: c.evidence.mode, status: c.evidence.status, createdAt: c.evidence.createdAt, detail: c.evidence.detail } : null })) } })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
