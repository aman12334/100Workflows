import "server-only";
import { PROVIDERS, keyProblem, resolveProvider, type ProviderId } from "@/lib/providers";

type Env = Record<string, string | undefined>;

/** The model 100 Workflows is built and tested against with Anthropic. Override with WORKFLOWS_MODEL. */
export const DEFAULT_MODEL = PROVIDERS.anthropic.defaultModel;

export interface ModelConfig {
  /** True when a key is present and has the right shape. Says nothing about validity. */
  configured: boolean;
  provider: ProviderId;
  providerLabel: string;
  model: string;
  /** Environment variable that holds the key for this provider. */
  keyVar: string;
  /** Human-readable reason when not configured. Never contains the key. */
  problem?: string;
}

export class NotConfiguredError extends Error {}

export function getModelConfig(env: Env = process.env): ModelConfig {
  const provider = resolveProvider(env);
  const info = PROVIDERS[provider];
  const base = { provider, providerLabel: info.label, model: env.WORKFLOWS_MODEL?.trim() || info.defaultModel, keyVar: info.keyVar };

  const explicit = env.WORKFLOWS_PROVIDER?.trim();
  if (explicit && !["anthropic", "openai"].includes(explicit.toLowerCase())) {
    return { ...base, configured: false, problem: `WORKFLOWS_PROVIDER must be "anthropic" or "openai", not "${explicit}".` };
  }
  const problem = keyProblem(provider, env[info.keyVar]?.trim());
  return problem ? { ...base, configured: false, problem } : { ...base, configured: true };
}

/** Reads a provider's key at call time so it never ends up in module-level state that could be serialized. */
export function getApiKey(provider: ProviderId, env: Env = process.env): string | undefined {
  return env[PROVIDERS[provider].keyVar]?.trim() || undefined;
}
