import { NextResponse } from "next/server";
import { respond } from "@/lib/server/conversation-service";
import { getDb } from "@/lib/server/db";
import { fail } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Answers the latest user message again after a failed attempt. Nothing is stored on failure. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await respond(getDb(), id);
  if (!result.ok) return fail(result.error.status, result.error.code, result.error.message);
  return NextResponse.json({ messages: [result.message] });
}
