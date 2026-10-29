import "server-only";
import { randomUUID } from "node:crypto";
import type { ChatReply, StoredMessage } from "@/lib/chat-types";
import type { DB } from "./index";

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  reply_json: string | null;
  created_at: string;
}

const now = () => new Date().toISOString();

export function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 70 ? `${oneLine.slice(0, 67).trimEnd()}…` : oneLine || "New conversation";
}

export function createConversation(db: DB, firstMessage: string): ConversationSummary {
  const c = { id: randomUUID(), title: titleFrom(firstMessage), createdAt: now(), updatedAt: now() };
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(c.id, c.title, c.createdAt, c.updatedAt);
  return c;
}

export function listConversations(db: DB, limit = 20): ConversationSummary[] {
  return db
    .prepare("SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as ConversationSummary[];
}

export function getConversation(db: DB, id: string): { conversation: ConversationSummary; messages: StoredMessage[] } | null {
  const conversation = db
    .prepare("SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ?")
    .get(id) as ConversationSummary | undefined;
  if (!conversation) return null;
  const rows = db
    .prepare("SELECT id, role, content, reply_json, created_at FROM messages WHERE conversation_id = ? ORDER BY seq")
    .all(id) as MessageRow[];
  return {
    conversation,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      reply: r.reply_json ? (JSON.parse(r.reply_json) as ChatReply) : undefined,
      createdAt: r.created_at,
    })),
  };
}

export function appendMessage(db: DB, conversationId: string, role: "user" | "assistant", content: string, reply?: ChatReply): StoredMessage {
  const message: StoredMessage = { id: randomUUID(), role, content, reply, createdAt: now() };
  db.transaction(() => {
    const { next } = db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { next: number };
    db.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, reply_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      message.id,
      conversationId,
      next,
      role,
      content,
      reply ? JSON.stringify(reply) : null,
      message.createdAt,
    );
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(message.createdAt, conversationId);
  })();
  return message;
}

export function deleteConversation(db: DB, id: string): boolean {
  return db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
}
