import { z } from "zod";
import type { Category } from "@/lib/catalog/schema";

/** Shared between the browser and the API routes. Contains no secrets. */

export const MAX_HISTORY_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 8000;

export const MessageInputSchema = z.object({
  content: z.string().trim().min(1, "message is empty").max(MAX_MESSAGE_CHARS),
});

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The model sees at most the last N messages, and the window must start with a user turn. */
export function historyWindow<T extends ChatMessage>(messages: T[]): T[] {
  let slice = messages.slice(-MAX_HISTORY_MESSAGES);
  while (slice.length && slice[0].role !== "user") slice = slice.slice(1);
  return slice;
}

export interface WorkflowRef {
  id: string;
  name: string;
  category: Category;
  status: "available" | "planned";
  summary: string;
  /** Workflows that must run first; selecting this one adds them to a package. */
  requires: string[];
}

export interface Recommendation {
  workflow: WorkflowRef;
  reason: string;
}

export interface ChatReply {
  text: string;
  /** Explicit, validated recommendations with the model's reason for each. */
  recommendations: Recommendation[];
  /** Other catalog workflows the reply mentioned. */
  workflows: WorkflowRef[];
  /** IDs the reply mentioned that are NOT in the catalog; shown as a warning, never as cards. */
  unknownWorkflowIds: string[];
  searchedWorkflowIds: string[];
  usage: { inputTokens: number; outputTokens: number; modelCalls: number };
  model: string;
  stopped?: "refusal" | "max_tokens" | "step_limit";
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reply?: ChatReply;
  createdAt: string;
}

export interface ApiError {
  error: { code: string; message: string };
}
