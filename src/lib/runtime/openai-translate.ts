import type OpenAI from "openai";
import type { CreateMessage, CreateParams, Message, MessageParam } from "./model";

/**
 * Lets the chat engine and the workflow runtime run on OpenAI without changing:
 * Anthropic-shaped requests (system, text, tool_use and tool_result blocks,
 * custom tools, JSON output format, effort) become an OpenAI Responses API
 * request, and the reply comes back in the Anthropic message shape they
 * already handle. Anthropic-only features are refused rather than silently dropped.
 *
 * The Responses API (not Chat Completions) is required: OpenAI's reasoning models
 * reject function tools combined with reasoning on /v1/chat/completions.
 */

type ResponseParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type InputItem = OpenAI.Responses.ResponseInputItem;
type OpenAIResponse = OpenAI.Responses.Response;
type ReasoningItem = OpenAI.Responses.ResponseReasoningItem;

export class UnsupportedFeatureError extends Error {}

/**
 * Carries OpenAI reasoning between calls within one turn. Reasoning models expect
 * their (encrypted) reasoning to be sent back alongside the tool calls it produced.
 * Only the OpenAI translator creates or reads this block.
 */
export const REASONING_BLOCK = "openai_reasoning";

type Block = { type: string; [k: string]: unknown };

function blocks(content: MessageParam["content"]): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : (content as unknown as Block[]);
}

function textOfBlocks(list: Block[]): string {
  return list
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return textOfBlocks(content as Block[]);
  return content === undefined ? "" : JSON.stringify(content);
}

function systemText(system: CreateParams["system"]): string | null {
  if (!system) return null;
  if (typeof system === "string") return system;
  return textOfBlocks(system as unknown as Block[]);
}

/** Reasoning models take `reasoning.effort`; others reject it. */
export function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-[5-9]|o\d)/.test(model) && !model.includes("chat-latest");
}

const EFFORT: Record<string, "low" | "medium" | "high" | "xhigh"> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

export function toOpenAIRequest(params: CreateParams): ResponseParams {
  const input: InputItem[] = [];
  const instructions: string[] = [];
  const system = systemText(params.system);
  if (system) instructions.push(system);

  for (const m of params.messages) {
    const list = blocks(m.content);
    if (m.role === "system") {
      input.push({ role: "developer", content: textOfBlocks(list) });
      continue;
    }
    if (m.role === "user") {
      for (const b of list.filter((x) => x.type === "tool_result")) {
        const prefix = b.is_error ? "Error: " : "";
        input.push({ type: "function_call_output", call_id: String(b.tool_use_id), output: prefix + toolResultText(b.content) });
      }
      const text = textOfBlocks(list);
      if (text) input.push({ role: "user", content: text });
      continue;
    }
    // Assistant: replay reasoning, text and tool calls in their original order.
    for (const b of list) {
      if (b.type === REASONING_BLOCK) input.push(b.item as ReasoningItem);
      else if (b.type === "text" && b.text) input.push({ role: "assistant", content: String(b.text) });
      else if (b.type === "tool_use") {
        input.push({ type: "function_call", call_id: String(b.id), name: String(b.name), arguments: JSON.stringify(b.input ?? {}) });
      }
      // Other Anthropic blocks (thinking, server tools) have no OpenAI equivalent.
    }
  }

  const request: ResponseParams = {
    model: params.model,
    input,
    max_output_tokens: params.max_tokens,
    // Local-first: OpenAI does not keep the conversation; reasoning travels back encrypted instead.
    store: false,
  };
  if (instructions.length) request.instructions = instructions.join("\n\n");

  const include = new Set<OpenAI.Responses.ResponseIncludable>();
  if (params.tools?.length) {
    request.tools = params.tools.map((t) => {
      const tool = t as unknown as { type?: string; name: string; description?: string; input_schema?: Record<string, unknown>; max_uses?: number };
      if (tool.type?.startsWith("web_search_")) {
        // Anthropic's server-side web search maps to OpenAI's built-in web_search tool. OpenAI has no
        // per-tool limit, so the search budget becomes the response's cap on built-in tool calls.
        if (tool.max_uses) request.max_tool_calls = tool.max_uses;
        include.add("web_search_call.action.sources");
        return { type: "web_search" as const };
      }
      if (tool.type && tool.type !== "custom") {
        throw new UnsupportedFeatureError(`The "${tool.name}" tool (${tool.type}) is only available with the Anthropic provider.`);
      }
      return { type: "function" as const, name: tool.name, description: tool.description ?? null, parameters: tool.input_schema ?? null, strict: false };
    });
    request.tool_choice = params.tool_choice?.type === "none" ? "none" : "auto";
  }

  const format = params.output_config?.format;
  if (format?.type === "json_schema") {
    request.text = { format: { type: "json_schema", name: "output", schema: format.schema, strict: false } };
  }

  if (supportsReasoningEffort(params.model)) {
    const effort = params.output_config?.effort;
    request.reasoning = effort ? { effort: EFFORT[effort] ?? "medium" } : {};
    include.add("reasoning.encrypted_content");
  }
  if (include.size) request.include = [...include];
  return request;
}

/**
 * OpenAI web search, in the Anthropic shape the runtime reads (server_tool_use + web_search_tool_result).
 * Only URLs and titles are carried over: OpenAI's url_citation annotations point into the model's own
 * answer, not into the page, so they are never turned into quoted passages. Workflows that need page
 * text read the pages themselves (web-fetch) and check claims against that.
 * Cited URLs come first, so "read the top N results" reads the pages the model actually relied on.
 */
function webSearchBlocks(res: OpenAIResponse): { blocks: Block[]; searches: number } {
  const titles = new Map<string, string>();
  for (const item of res.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type !== "output_text") continue;
      for (const a of part.annotations ?? []) if (a.type === "url_citation" && !titles.has(a.url)) titles.set(a.url, a.title || a.url);
    }
  }
  const blocks: Block[] = [];
  let searches = 0;
  for (const item of res.output) {
    if (item.type !== "web_search_call") continue;
    const action = item.action as { type: string; queries?: string[]; query?: string; sources?: Array<{ url: string }>; url?: string | null };
    if (action?.type === "search") searches++;
    const query = action?.queries?.join(" | ") || action?.query || action?.url || "";
    blocks.push({ type: "server_tool_use", id: item.id, name: "web_search", input: { query } });
    if (item.status === "failed" || item.status === "incomplete") {
      blocks.push({ type: "web_search_tool_result", tool_use_id: item.id, content: { type: "web_search_tool_result_error", error_code: `openai_${item.status}` } });
      continue;
    }
    const urls = action?.type === "search" ? (action.sources ?? []).map((s) => s.url) : action?.type === "open_page" && action.url ? [action.url] : [];
    const ordered = [...urls.filter((u) => titles.has(u)), ...urls.filter((u) => !titles.has(u))];
    blocks.push({
      type: "web_search_tool_result",
      tool_use_id: item.id,
      content: ordered.map((url) => ({ type: "web_search_result", url, title: titles.get(url) ?? url, page_age: null, encrypted_content: "" })),
    });
  }
  // Pages the model cited without them appearing in a search action's source list.
  const listed = new Set(blocks.flatMap((b) => (Array.isArray(b.content) ? (b.content as Array<{ url: string }>).map((r) => r.url) : [])));
  const extra = [...titles].filter(([url]) => !listed.has(url));
  if (blocks.length && extra.length) {
    blocks.push({ type: "web_search_tool_result", tool_use_id: "openai_citations", content: extra.map(([url, title]) => ({ type: "web_search_result", url, title, page_age: null, encrypted_content: "" })) });
  }
  return { blocks, searches };
}

export function fromOpenAIResponse(res: OpenAIResponse): Message {
  const search = webSearchBlocks(res);
  const content: Block[] = [...search.blocks];
  let refused = false;

  // Some models narrate between tool calls ("commentary"); keep only the final answer when there is one.
  const messages = res.output.filter((o): o is OpenAI.Responses.ResponseOutputMessage => o.type === "message");
  const hasFinal = messages.some((m) => m.phase === "final_answer");

  for (const item of res.output) {
    if (item.type === "reasoning") {
      content.push({ type: REASONING_BLOCK, item: { type: "reasoning", id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content ?? null } });
    } else if (item.type === "message") {
      if (hasFinal && item.phase === "commentary") continue;
      for (const part of item.content) {
        if (part.type === "refusal") refused = true;
        else if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text, citations: null });
      }
    } else if (item.type === "function_call") {
      let input: unknown;
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {
        // Pass the raw text through: the tool's own input validation reports it back to the model.
        input = { _unparsed: item.arguments };
      }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    }
  }

  const reason = res.incomplete_details?.reason;
  const stop: Message["stop_reason"] = refused || reason === "content_filter"
    ? "refusal"
    : content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : reason === "max_output_tokens"
        ? "max_tokens"
        : "end_turn";

  return {
    id: res.id,
    type: "message",
    role: "assistant",
    model: res.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: search.searches ? { web_search_requests: search.searches } : null,
    },
  } as unknown as Message;
}

export interface ResponsesClient {
  responses: { create(body: ResponseParams, options?: { signal?: AbortSignal; timeout?: number }): Promise<OpenAIResponse> };
}

/** A CreateMessage backed by an OpenAI client. The client is injected so tests can pass a fake. */
export function openAICreateMessage(client: () => ResponsesClient): CreateMessage {
  return async (params, options) => fromOpenAIResponse(await client().responses.create(toOpenAIRequest(params), options));
}
