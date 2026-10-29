import "server-only";
import OpenAI from "openai";
import { openAICreateMessage } from "@/lib/runtime/openai-translate";
import { NotConfiguredError, getApiKey, getModelConfig } from "./config";
import type { MappedError } from "./claude";

/** The single place that talks to OpenAI. */
function client(): OpenAI {
  const apiKey = getApiKey("openai");
  if (!apiKey) throw new NotConfiguredError(getModelConfig().problem ?? "OpenAI is not configured.");
  return new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });
}

export const createMessage = openAICreateMessage(client);

/** Confirms the key works and can see the model. Listing a model is not billed. */
export async function checkConnection(model: string) {
  const info = await client().models.retrieve(model);
  return { id: info.id, displayName: info.id };
}

/** Maps OpenAI SDK errors to messages a user can act on. Returns null for errors that aren't OpenAI's. */
export function mapOpenAIError(err: unknown): MappedError | null {
  if (err instanceof OpenAI.AuthenticationError)
    return { status: 401, code: "invalid_key", message: "OpenAI rejected the API key. Check OPENAI_API_KEY in .env.local, then restart." };
  if (err instanceof OpenAI.PermissionDeniedError)
    return { status: 403, code: "permission_denied", message: "This OpenAI key doesn't have access to the configured model." };
  if (err instanceof OpenAI.NotFoundError)
    return { status: 404, code: "model_not_found", message: "OpenAI couldn't find the configured model. Check WORKFLOWS_MODEL." };
  if (err instanceof OpenAI.RateLimitError)
    return { status: 429, code: "rate_limited", message: "OpenAI rate limit or quota reached. Check your OpenAI billing, or wait and try again." };
  if (err instanceof OpenAI.BadRequestError) {
    const body = err.error as { message?: string } | undefined;
    return { status: 400, code: "bad_request", message: `OpenAI rejected the request: ${(body?.message ?? err.message).slice(0, 300)}` };
  }
  if (err instanceof OpenAI.APIUserAbortError) return { status: 499, code: "cancelled", message: "The request was cancelled." };
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { status: 504, code: "timeout", message: "OpenAI didn't respond before the time limit." };
  if (err instanceof OpenAI.APIConnectionError) return { status: 502, code: "unreachable", message: "Couldn't reach OpenAI. Check your internet connection." };
  if (err instanceof OpenAI.APIError)
    return { status: 502, code: "provider_error", message: `OpenAI returned an error (${err.status ?? "unknown"}). Try again shortly.` };
  return null;
}
