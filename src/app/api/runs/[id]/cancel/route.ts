import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { fail } from "@/lib/server/http";
import { cancelRun } from "@/lib/server/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!cancelRun(getDb(), id)) return fail(409, "not_running", "This run isn't running.");
  return NextResponse.json({ ok: true });
}
