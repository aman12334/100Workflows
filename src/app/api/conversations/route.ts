import { NextResponse } from "next/server";
import { MessageInputSchema } from "@/lib/chat-types";
import { respond } from "@/lib/server/conversation-service";
import { getModelConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { appendMessage, createConversation } from "@/lib/server/db/conversations";
import { fail, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a conversation with its first message and answers it. */
export async function POST(request: Request) {
  const body = await readJson(request, MessageInputSchema);
  if ("response" in body) return body.response;

  const config = getModelConfig();
  if (!config.configured) return fail(503, "not_configured", config.problem ?? "Model is not configured.");

  const db = getDb();
  const conversation = createConversation(db, body.data.content);
  const userMessage = appendMessage(db, conversation.id, "user", body.data.content);
  const result = await respond(db, conversation.id);
  if (!result.ok) return fail(result.error.status, result.error.code, result.error.message, { conversationId: conversation.id, userMessage });
  return NextResponse.json({ conversationId: conversation.id, messages: [userMessage, result.message] });
}
