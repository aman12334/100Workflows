import "server-only";
import { loadCatalog } from "@/lib/catalog/load";
import { historyWindow, type StoredMessage } from "@/lib/chat-types";
import { runChatTurn } from "./chat";
import type { MappedError } from "./claude";
import { createMessage, mapModelError } from "./model-client";
import { getModelConfig } from "./config";
import { appendMessage, getConversation } from "./db/conversations";
import type { DB } from "./db";
import { log } from "./log";

export type RespondResult = { ok: true; message: StoredMessage } | { ok: false; error: MappedError };

/**
 * Answers the latest user message in a stored conversation and stores the reply.
 * If the model call fails, nothing is stored, so the same turn can be retried.
 */
export async function respond(db: DB, conversationId: string): Promise<RespondResult> {
  const config = getModelConfig();
  if (!config.configured) return { ok: false, error: { status: 503, code: "not_configured", message: config.problem ?? "Model is not configured." } };

  const stored = getConversation(db, conversationId);
  if (!stored) return { ok: false, error: { status: 404, code: "not_found", message: "Conversation not found." } };
  const history = historyWindow(stored.messages).map((m) => ({ role: m.role, content: m.content }));
  if (!history.length || history[history.length - 1].role !== "user") {
    return { ok: false, error: { status: 409, code: "nothing_to_answer", message: "The latest message already has a reply." } };
  }

  const catalog = await loadCatalog();
  if (catalog.errors.length) log.warn("catalog.invalid_entries", { count: catalog.errors.length });

  const started = Date.now();
  try {
    const reply = await runChatTurn({ createMessage, model: config.model, workflows: catalog.workflows, history });
    log.info("chat.turn", {
      conversationId,
      ms: Date.now() - started,
      modelCalls: reply.usage.modelCalls,
      inputTokens: reply.usage.inputTokens,
      outputTokens: reply.usage.outputTokens,
      recommended: reply.recommendations.map((r) => r.workflow.id),
      unknown: reply.unknownWorkflowIds,
      stopped: reply.stopped,
    });
    return { ok: true, message: appendMessage(db, conversationId, "assistant", reply.text, reply) };
  } catch (err) {
    const error = mapModelError(err);
    log.error("chat.failed", { conversationId, ms: Date.now() - started, code: error.code, error: err });
    return { ok: false, error };
  }
}
