import type OpenAI from "openai";
import type { CreateMessage, CreateParams, Message, MessageParam } from "./model";

/**
 * Lets the chat engine and the workflow runtime run on OpenAI without changing:
 * Anthropic-shaped requests (system, text, tool_use and tool_result blocks,
 * custom tools, JSON output format) become a Chat Completions request, and the
 * reply comes back in the Anthropic message shape they already handle.
 * Anthropic-only features are refused rather than silently dropped.
 */

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

export class UnsupportedFeatureError extends Error {}

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

/** Reasoning models take reasoning_effort; others reject it. */
export function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-[5-9]|o\d)/.test(model) && !model.includes("chat-latest");
}

export function toOpenAIRequest(params: CreateParams): ChatParams {
  const messages: ChatMessage[] = [];
  const system = systemText(params.system);
  if (system) messages.push({ role: "system", content: system });

  for (const m of params.messages) {
    if (m.role === "system") {
      messages.push({ role: "system", content: textOfBlocks(blocks(m.content)) });
      continue;
    }
    const list = blocks(m.content);
    if (m.role === "user") {
      // Tool results become "tool" messages; any text alongside them stays a user message.
      for (const b of list.filter((x) => x.type === "tool_result")) {
        const prefix = b.is_error ? "Error: " : "";
        messages.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: prefix + toolResultText(b.content) });
      }
      const text = textOfBlocks(list);
      if (text) messages.push({ role: "user", content: text });
      continue;
    }
    // Assistant: keep text and tool calls; provider-specific blocks (thinking, server tools) have no OpenAI equivalent.
    const calls = list
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: String(b.id), type: "function" as const, function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
    const text = textOfBlocks(list);
    messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
  }

  const request: ChatParams = { model: params.model, messages, max_completion_tokens: params.max_tokens };

  if (params.tools?.length) {
    request.tools = params.tools.map((t) => {
      const tool = t as unknown as { type?: string; name: string; description?: string; input_schema?: Record<string, unknown> };
      if (tool.type && tool.type !== "custom") {
        throw new UnsupportedFeatureError(`The "${tool.name}" tool (${tool.type}) is only available with the Anthropic provider.`);
      }
      return { type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.input_schema } };
    });
    const choice = params.tool_choice?.type;
    request.tool_choice = choice === "none" ? "none" : "auto";
  }

  const format = params.output_config?.format;
  if (format?.type === "json_schema") {
    request.response_format = { type: "json_schema", json_schema: { name: "output", schema: format.schema, strict: false } };
  }

  if (supportsReasoningEffort(params.model)) {
    if (request.tools?.length) {
      // Chat Completions rejects function tools combined with reasoning on these models
      // ("set reasoning_effort to 'none'"); the Responses API would allow both.
      request.reasoning_effort = "none";
    } else {
      const effort = params.output_config?.effort;
      if (effort) request.reasoning_effort = effort === "xhigh" || effort === "max" ? "high" : effort;
    }
  }
  return request;
}

const STOP: Record<string, Message["stop_reason"]> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

export function fromOpenAIResponse(res: Completion): Message {
  const choice = res.choices[0];
  const msg = choice?.message;
  const content: Block[] = [];
  if (msg?.content) content.push({ type: "text", text: msg.content, citations: null });
  for (const call of msg?.tool_calls ?? []) {
    if (call.type !== "function") continue;
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      // Pass the raw text through: the tool's own input validation reports it back to the model.
      input = { _unparsed: call.function.arguments };
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }

  let stop = STOP[choice?.finish_reason ?? "stop"] ?? "end_turn";
  if (msg?.refusal) stop = "refusal";
  else if (content.some((b) => b.type === "tool_use")) stop = "tool_use";

  return {
    id: res.id,
    type: "message",
    role: "assistant",
    model: res.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
  } as unknown as Message;
}

export interface ChatCompletionsClient {
  chat: { completions: { create(body: ChatParams, options?: { signal?: AbortSignal; timeout?: number }): Promise<Completion> } };
}

/** A CreateMessage backed by an OpenAI client. The client is injected so tests can pass a fake. */
export function openAICreateMessage(client: () => ChatCompletionsClient): CreateMessage {
  return async (params, options) => fromOpenAIResponse(await client().chat.completions.create(toOpenAIRequest(params), options));
}
