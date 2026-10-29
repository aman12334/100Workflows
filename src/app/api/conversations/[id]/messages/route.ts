import { NextResponse } from "next/server";
import { MessageInputSchema } from "@/lib/chat-types";
import { respond } from "@/lib/server/conversation-service";
import { getModelConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { appendMessage, getConversation } from "@/lib/server/db/conversations";
import { fail, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Adds a user message to an existing conversation and answers it. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(request, MessageInputSchema);
  if ("response" in body) return body.response;

  const config = getModelConfig();
  if (!config.configured) return fail(503, "not_configured", config.problem ?? "Model is not configured.");

  const db = getDb();
  if (!getConversation(db, id)) return fail(404, "not_found", "Conversation not found.");
  const userMessage = appendMessage(db, id, "user", body.data.content);
  const result = await respond(db, id);
  if (!result.ok) return fail(result.error.status, result.error.code, result.error.message, { userMessage });
  return NextResponse.json({ messages: [userMessage, result.message] });
}
