import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type Message = Anthropic.Beta.Messages.BetaMessage;
export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export interface RequestOptions {
  signal?: AbortSignal;
  /** Milliseconds. */
  timeout?: number;
}

/** The only thing chat and the runtime need from the SDK, so tests can pass a fake. */
export type CreateMessage = (params: CreateParams, options?: RequestOptions) => Promise<Message>;

/** Request fields shared by every model call the app makes. */
export const COMMON_PARAMS = {
  // Re-route a policy decline to a suitable model server-side instead of failing the call.
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
} satisfies Partial<CreateParams>;

export function textOf(message: Message): string {
  return message.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// Structured outputs reject these keywords; Zod still enforces them when we parse the reply.
const UNSUPPORTED = new Set(["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "pattern", "format", "uniqueItems"]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, strip(v)]));
}

/** Builds an `output_config.format` from a Zod schema. */
export function jsonFormat(schema: z.ZodType): { type: "json_schema"; schema: Record<string, unknown> } {
  return { type: "json_schema", schema: strip(z.toJSONSchema(schema, { target: "draft-7", io: "output" })) as Record<string, unknown> };
}

export class OutputInvalidError extends Error {
  constructor(message: string, readonly issues: string[]) {
    super(message);
  }
}

/** Parses and validates a structured reply. Anything off-schema is an OutputInvalidError the evaluator can score. */
export function parseJson<T extends z.ZodType>(message: Message, schema: T): z.infer<T> {
  if (message.stop_reason === "refusal") throw new OutputInvalidError("The model declined to produce this output.", ["refusal"]);
  if (message.stop_reason === "max_tokens") throw new OutputInvalidError("The output was cut off at the length limit.", ["max_tokens"]);
  let data: unknown;
  try {
    data = JSON.parse(textOf(message));
  } catch {
    throw new OutputInvalidError("The output was not valid JSON.", ["invalid_json"]);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new OutputInvalidError(`The output did not match the schema: ${issues.slice(0, 5).join("; ")}`, issues);
  }
  return parsed.data;
}
