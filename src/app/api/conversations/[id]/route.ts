import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { deleteConversation } from "@/lib/server/db/conversations";
import { fail } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!deleteConversation(getDb(), id)) return fail(404, "not_found", "Conversation not found.");
  return NextResponse.json({ ok: true });
}
