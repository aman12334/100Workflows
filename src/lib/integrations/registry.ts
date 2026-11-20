import { NEEDS_APPROVAL, type ActionDefinition, type ProviderDefinition } from "./core";
import { ACTION_LIST, PROVIDER_LIST } from "./providers";

/**
 * The allowlist of integration providers and their versioned actions.
 * Definitions reference actions as "<provider>.<action>@<version>". Credentials
 * are read from the environment at call time and never stored, logged or shown.
 */

type Env = Record<string, string | undefined>;

export const PROVIDERS: Readonly<Record<string, ProviderDefinition>> = Object.freeze(Object.fromEntries(PROVIDER_LIST.map((p) => [p.id, p])));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ACTIONS: Readonly<Record<string, ActionDefinition<any, any>>> = Object.freeze(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ACTION_LIST.reduce<Record<string, ActionDefinition<any, any>>>((acc, a) => {
    const ref = `${a.id}@${a.version}`;
    if (acc[ref]) throw new Error(`action ${ref} is registered twice`);
    if (!PROVIDER_LIST.some((p) => p.id === a.provider)) throw new Error(`action ${ref} names unknown provider ${a.provider}`);
    acc[ref] = a;
    return acc;
  }, {}),
);

export function lookupAction(ref: string) {
  return Object.hasOwn(ACTIONS, ref) ? ACTIONS[ref] : null;
}

export const needsApproval = (ref: string) => {
  const a = lookupAction(ref);
  return !a || NEEDS_APPROVAL.has(a.sideEffect);
};

export interface ConnectionStatus {
  id: string;
  name: string;
  configured: boolean;
  /** Names of missing settings (never values). */
  missing: string[];
  authKind: ProviderDefinition["auth"]["kind"];
  scopes: string[];
  setup: string;
  docs: string[];
  actions: Array<{ ref: string; title: string; sideEffect: string; approval: boolean }>;
}

/** Whether each provider has its settings. "Configured" means present, not tested: the first real call proves the credentials. */
export function connectionStatus(env: Env): ConnectionStatus[] {
  return Object.values(PROVIDERS).map((p) => {
    const missing = p.auth.env.filter((k) => !env[k]?.trim());
    return {
      id: p.id,
      name: p.name,
      configured: missing.length === 0,
      missing,
      authKind: p.auth.kind,
      scopes: p.scopes,
      setup: p.setup,
      docs: p.docs,
      actions: Object.entries(ACTIONS)
        .filter(([, a]) => a.provider === p.id)
        .map(([ref, a]) => ({ ref, title: a.title, sideEffect: a.sideEffect, approval: NEEDS_APPROVAL.has(a.sideEffect) })),
    };
  });
}

/** Whether real external actions are allowed. Off (dry run) unless WORKFLOWS_ACTIONS=live. */
export const actionsLive = (env: Env) => env.WORKFLOWS_ACTIONS?.trim().toLowerCase() === "live";
