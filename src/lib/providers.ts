/**
 * Model providers 100 Workflows can use. Which one runs is decided by the
 * environment, never by the browser: WORKFLOWS_PROVIDER when set, otherwise
 * whichever provider has a key (Anthropic first).
 */

export type ProviderId = "anthropic" | "openai";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  keyVar: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
  defaultModel: string;
  keysUrl: string;
  /** Whether the runtime can offer web search with this provider. */
  webSearch: boolean;
  /**
   * Whether search results come with passages quoted from the pages themselves.
   * Anthropic's tool returns cited page text; OpenAI's citations point into the model's own
   * answer, so with OpenAI workflows must read the pages (web-fetch) to have evidence.
   */
  webSearchPassages: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-opus-5-5",
    keysUrl: "https://console.anthropic.com/settings/keys",
    webSearch: true,
    webSearchPassages: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyVar: "OPENAI_API_KEY",
    defaultModel: "gpt-6.1-sol",
    keysUrl: "https://platform.openai.com/api-keys",
    webSearch: true,
    webSearchPassages: false,
  },
};

type Env = Record<string, string | undefined>;

export function resolveProvider(env: Env): ProviderId {
  const explicit = env.WORKFLOWS_PROVIDER?.trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "openai") return explicit;
  if (env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  return "anthropic";
}

/** Checks the key's shape without sending it anywhere. Returns a problem, or null. */
export function keyProblem(provider: ProviderId, key: string | undefined): string | null {
  const info = PROVIDERS[provider];
  if (!key) return `${info.keyVar} is not set. Add it to .env.local, then restart the server.`;
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
    return "ANTHROPIC_API_KEY does not look like an Anthropic key (expected it to start with sk-ant-).";
  }
  if (provider === "openai") {
    if (key.startsWith("sk-ant-")) return "OPENAI_API_KEY holds an Anthropic key. Put it in ANTHROPIC_API_KEY instead.";
    if (!key.startsWith("sk-")) return "OPENAI_API_KEY does not look like an OpenAI key (expected it to start with sk-).";
  }
  return null;
}
