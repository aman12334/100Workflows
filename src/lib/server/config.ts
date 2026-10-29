import "server-only";

type Env = Record<string, string | undefined>;

/** The one model 100 Workflows is built and tested against. Override with WORKFLOWS_MODEL. */
export const DEFAULT_MODEL = "claude-opus-5-5";

export interface ModelConfig {
  /** True when a key is present and looks like an Anthropic key. Says nothing about validity. */
  configured: boolean;
  model: string;
  /** Human-readable reason when not configured. Never contains the key. */
  problem?: string;
}

export function getModelConfig(env: Env = process.env): ModelConfig {
  const model = env.WORKFLOWS_MODEL?.trim() || DEFAULT_MODEL;
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    return { configured: false, model, problem: "ANTHROPIC_API_KEY is not set. Run `npm run setup`, then restart the server." };
  }
  if (!key.startsWith("sk-ant-")) {
    return { configured: false, model, problem: "ANTHROPIC_API_KEY does not look like an Anthropic key (expected it to start with sk-ant-)." };
  }
  return { configured: true, model };
}

/** Reads the key at call time so it never ends up in module-level state that could be serialized. */
export function getApiKey(env: Env = process.env): string | undefined {
  return env.ANTHROPIC_API_KEY?.trim() || undefined;
}
