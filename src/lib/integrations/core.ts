import type { z } from "zod";

/**
 * Shared integration core: provider and action definitions, a guarded HTTP
 * layer, and normalised errors. Provider adapters (./providers/*) build on it;
 * workflow definitions only name registered actions and never hold credentials.
 */

type Env = Record<string, string | undefined>;

/** How much an action can change the outside world. Anything above "draft" needs human approval. */
export type SideEffect = "read_only" | "draft" | "reversible_write" | "external_side_effect" | "irreversible";
export const NEEDS_APPROVAL: ReadonlySet<SideEffect> = new Set(["reversible_write", "external_side_effect", "irreversible"]);

export interface ProviderDefinition {
  id: string;
  name: string;
  /** How credentials are supplied. Values live in the environment only. */
  auth: { kind: "api_key" | "bearer_token" | "oauth_refresh_token"; env: string[]; optionalEnv?: string[] };
  /** Minimum permissions to configure at the provider. */
  scopes: string[];
  setup: string;
  docs: string[];
  /** Minimum gap between requests to this provider from this process (client-side rate limit). */
  minIntervalMs: number;
}

export type IntegrationErrorKind =
  | "not_configured"
  | "auth_invalid"
  | "auth_expired"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "duplicate"
  | "validation"
  | "rate_limited"
  | "provider_error"
  | "network"
  | "timeout"
  | "cancelled"
  | "unconfirmed";

export class IntegrationError extends Error {
  constructor(
    readonly kind: IntegrationErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Errors worth retrying automatically, and only for calls that are safe to repeat. */
export const RETRYABLE: ReadonlySet<IntegrationErrorKind> = new Set(["rate_limited", "provider_error", "network", "timeout"]);

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HttpRequest {
  method: "GET" | "POST" | "PATCH";
  url: string;
  headers: Record<string, string>;
  body?: string;
}
/** The only way adapters reach the network. Tests replace it; nothing else can make provider calls. */
export type HttpTransport = (req: HttpRequest, opts: { signal: AbortSignal }) => Promise<HttpResponse>;

const MAX_RESPONSE_BYTES = 5_000_000;

export const fetchTransport: HttpTransport = async (req, { signal }) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal, redirect: "error" });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new IntegrationError("provider_error", "the provider's response was too large");
      }
      chunks.push(value);
    }
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, body: Buffer.concat(chunks).toString("utf8") };
};

export interface ActionContext {
  env: Env;
  transport: HttpTransport;
  signal: AbortSignal;
  /** Stable key for this exact approved action; adapters pass it to providers that support idempotency. */
  idempotencyKey: string;
  now: () => Date;
  /** External ids of actions already executed in the same batch, by their proposal key (for dependencies). */
  resolved: Record<string, string>;
}

export interface ActionDefinition<I = unknown, O = unknown> {
  /** "<provider>.<action>" */
  id: string;
  version: string;
  provider: string;
  title: string;
  sideEffect: SideEffect;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /** How repeats are prevented: a provider idempotency header, a client-chosen id, a duplicate check before writing, or the local ledger only. */
  idempotency: "provider_header" | "client_id" | "precheck" | "ledger" | "not_applicable";
  timeoutMs: number;
  /** One line for the approval screen: what will happen and to what. */
  describe(input: I): { target: string; summary: string };
  /** Deterministic checks against data read earlier in the run (e.g. the channel is one the bot is in). Returns problems. */
  validate?(input: I, data: Record<string, unknown>, now: Date): string[];
  execute(input: I, ctx: ActionContext): Promise<O>;
  /** The provider's identifier for what was created or changed, for the audit record. */
  externalId?(output: O): string | null;
}

// ------------------------------------------------------------------ helpers

const lastCall = new Map<string, number>();
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new IntegrationError("cancelled", "cancelled"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new IntegrationError("cancelled", "cancelled"))), { once: true });
  });

function retryAfter(headers: Record<string, string>): number | undefined {
  const v = headers["retry-after"];
  if (!v) return undefined;
  const s = Number(v);
  return Number.isFinite(s) ? s * 1000 : undefined;
}

/** Maps an HTTP status to a normalised error. Messages never include request headers or credentials. */
export function errorFor(status: number, headers: Record<string, string>, detail: string): IntegrationError {
  const d = detail.replace(/(Bearer\s+)?[A-Za-z0-9_\-.]{24,}/g, "[redacted]").slice(0, 300);
  if (status === 401) return new IntegrationError(/expired/i.test(d) ? "auth_expired" : "auth_invalid", `the provider rejected the credentials (401)${d ? `: ${d}` : ""}`);
  if (status === 403) return new IntegrationError("permission_denied", `the credentials lack permission for this (403)${d ? `: ${d}` : ""}`);
  if (status === 404) return new IntegrationError("not_found", `not found (404)${d ? `: ${d}` : ""}`);
  if (status === 409) return new IntegrationError("conflict", `conflict (409)${d ? `: ${d}` : ""}`);
  if (status === 429) return new IntegrationError("rate_limited", `rate limited by the provider (429)`, retryAfter(headers));
  if (status === 400 || status === 422) return new IntegrationError("validation", `the provider rejected the request (${status})${d ? `: ${d}` : ""}`);
  if (status >= 500) return new IntegrationError("provider_error", `the provider had an error (${status})`);
  return new IntegrationError("provider_error", `unexpected response (${status})`);
}

/** Extracts a short, credential-free error description from a JSON error body. */
export function errorDetail(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const e = (j.error ?? j) as Record<string, unknown> | string;
    if (typeof e === "string") return e;
    return String(e.message ?? e.error ?? j.message ?? e.code ?? "");
  } catch {
    return "";
  }
}

/**
 * One provider request with timeout, cancellation, a client-side rate limit and
 * bounded retries. Only requests marked safe (reads, or writes protected by an
 * idempotency key) are retried; a write that might have reached the provider is
 * never silently repeated.
 */
export async function request(
  provider: ProviderDefinition,
  req: HttpRequest,
  ctx: Pick<ActionContext, "transport" | "signal">,
  opts: { safeToRetry: boolean; timeoutMs: number; attempts?: number },
): Promise<HttpResponse> {
  const attempts = opts.safeToRetry ? (opts.attempts ?? 3) : 1;
  let last: IntegrationError | null = null;
  for (let i = 0; i < attempts; i++) {
    const wait = (lastCall.get(provider.id) ?? 0) + provider.minIntervalMs - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 5000), ctx.signal);
    lastCall.set(provider.id, Date.now());
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    let res: HttpResponse;
    try {
      res = await ctx.transport(req, { signal });
    } catch (err) {
      if (ctx.signal.aborted) throw new IntegrationError("cancelled", "the run was cancelled");
      if (err instanceof IntegrationError) throw err;
      last = timeout.aborted ? new IntegrationError(opts.safeToRetry ? "timeout" : "unconfirmed", opts.safeToRetry ? "the provider did not answer in time" : "the provider did not answer in time; the action may or may not have happened") : new IntegrationError(opts.safeToRetry ? "network" : "unconfirmed", opts.safeToRetry ? "could not reach the provider" : "the connection failed during the request; the action may or may not have happened");
      if (!opts.safeToRetry) throw last;
      continue;
    }
    if (res.status >= 200 && res.status < 300) return res;
    last = errorFor(res.status, res.headers, errorDetail(res.body));
    // A server error during a write that isn't idempotent may have happened anyway: say so, never "failed".
    if (!opts.safeToRetry && res.status >= 500) throw new IntegrationError("unconfirmed", `the provider had an error (${res.status}); the action may or may not have happened`);
    if (!RETRYABLE.has(last.kind) || i === attempts - 1) throw last;
    await sleep(Math.min(last.retryAfterMs ?? 500 * 2 ** i, 10_000), ctx.signal);
  }
  throw last ?? new IntegrationError("provider_error", "request failed");
}

export function requireEnv(provider: ProviderDefinition, env: Env): Record<string, string> {
  const missing = provider.auth.env.filter((k) => !env[k]?.trim());
  if (missing.length) throw new IntegrationError("not_configured", `${provider.name} is not connected: set ${missing.join(", ")} in .env.local`);
  return Object.fromEntries([...provider.auth.env, ...(provider.auth.optionalEnv ?? [])].map((k) => [k, env[k]?.trim() ?? ""]));
}

export const parseJsonBody = <T>(res: HttpResponse): T => {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new IntegrationError("provider_error", "the provider returned invalid JSON");
  }
};

/** Deterministic, key-sorted JSON so the same payload always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
