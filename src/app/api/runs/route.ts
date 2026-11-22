import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { listRuns } from "@/lib/server/db/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Run history, newest first. Filters: q (package name or workflow id), status, workflowId, since (ISO date), limit (≤ 500). */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const runs = listRuns(getDb(), {
    q: p.get("q")?.slice(0, 100) ?? undefined,
    status: p.get("status") ?? undefined,
    workflowId: p.get("workflowId") ?? undefined,
    since: p.get("since") ?? undefined,
    limit: Number(p.get("limit")) || 50,
  });
  return NextResponse.json({ runs }, { headers: { "cache-control": "no-store" } });
}
