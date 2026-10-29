import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { getRun } from "@/lib/server/db/runs";
import { fail } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(getDb(), id);
  if (!run) return fail(404, "not_found", "Run not found.");
  return NextResponse.json(run, { headers: { "cache-control": "no-store" } });
}
