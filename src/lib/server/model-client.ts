import "server-only";
import { UnsupportedFeatureError } from "@/lib/runtime/openai-translate";
import type { CreateMessage } from "@/lib/runtime/model";
import * as anthropic from "./claude";
import type { MappedError } from "./claude";
import { NotConfiguredError, getModelConfig } from "./config";
import * as openai from "./openai";

/** Sends each request to the provider the environment selects (see src/lib/providers.ts). */
export const createMessage: CreateMessage = (params, options) =>
  getModelConfig().provider === "openai" ? openai.createMessage(params, options) : anthropic.createMessage(params, options);

/** Confirms the configured provider accepts the key and can see the model, using a free endpoint. */
export function checkConnection(model: string) {
  return getModelConfig().provider === "openai" ? openai.checkConnection(model) : anthropic.checkConnection(model);
}

/** Turns any provider's error into a message a user can act on, without echoing request details. */
export function mapModelError(err: unknown): MappedError {
  if (err instanceof NotConfiguredError) return { status: 503, code: "not_configured", message: err.message };
  if (err instanceof UnsupportedFeatureError) return { status: 400, code: "unsupported", message: err.message };
  return (
    anthropic.mapAnthropicError(err) ??
    openai.mapOpenAIError(err) ?? { status: 500, code: "internal", message: "Something went wrong on the local server. Check the terminal log." }
  );
}
