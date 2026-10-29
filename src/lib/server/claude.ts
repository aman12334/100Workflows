import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, getModelConfig } from "./config";
import type { CreateMessage } from "@/lib/runtime/model";

/**
 * The single place that talks to Anthropic. Swapping providers means replacing
 * this file and the `CreateMessage` shape the chat engine consumes.
 */
function client(): Anthropic {
  const apiKey = getApiKey();
  if (!apiKey) throw new NotConfiguredError(getModelConfig().problem ?? "Model is not configured.");
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
}

export class NotConfiguredError extends Error {}

export const createMessage: CreateMessage = (params, options) => client().beta.messages.create(params, options);

/**
 * Confirms the key works and can see the configured model. GET /v1/models/{id}
 * is not billed, so this check costs no credits.
 */
export async function checkConnection(model: string) {
  const info = await client().models.retrieve(model);
  return { id: info.id, displayName: info.display_name };
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
}

/** Turns SDK errors into messages a user can act on, without echoing request details. */
export function mapModelError(err: unknown): MappedError {
  if (err instanceof NotConfiguredError) return { status: 503, code: "not_configured", message: err.message };
  if (err instanceof Anthropic.AuthenticationError)
    return { status: 401, code: "invalid_key", message: "Anthropic rejected the API key. Run `npm run setup` to replace it, then restart." };
  if (err instanceof Anthropic.PermissionDeniedError)
    return { status: 403, code: "permission_denied", message: "This API key doesn't have access to the configured model." };
  if (err instanceof Anthropic.NotFoundError)
    return { status: 404, code: "model_not_found", message: "The configured model was not found. Check WORKFLOWS_MODEL." };
  if (err instanceof Anthropic.RateLimitError)
    return { status: 429, code: "rate_limited", message: "Anthropic rate limit reached. Wait a moment and try again." };
  if (err instanceof Anthropic.BadRequestError)
    // Anthropic's own message is safe to show and usually says what to change (e.g. web search disabled for the organization).
    return { status: 400, code: "bad_request", message: `Anthropic rejected the request: ${apiMessage(err)}` };
  if (err instanceof Anthropic.APIUserAbortError) return { status: 499, code: "cancelled", message: "The request was cancelled." };
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return { status: 504, code: "timeout", message: "Anthropic didn't respond before the time limit." };
  if (err instanceof Anthropic.APIConnectionError)
    return { status: 502, code: "unreachable", message: "Couldn't reach Anthropic. Check your internet connection." };
  if (err instanceof Anthropic.APIError)
    return { status: 502, code: "provider_error", message: `Anthropic returned an error (${err.status ?? "unknown"}). Try again shortly.` };
  return { status: 500, code: "internal", message: "Something went wrong on the local server. Check the terminal log." };
}

function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: string } } | undefined;
  return (body?.error?.message ?? err.message).slice(0, 300);
}
