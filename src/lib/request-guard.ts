/**
 * Local API routes spend the user's model credits, so only the local browser
 * session may call them. This blocks two common attacks on localhost servers:
 *  - DNS rebinding: a malicious site resolving its own hostname to 127.0.0.1
 *    (caught by the Host check).
 *  - Cross-site requests: another tab POSTing to localhost (caught by Origin
 *    and the JSON content-type requirement, which forces a CORS preflight).
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface GuardInput {
  method: string;
  host: string | null;
  origin: string | null;
  contentType: string | null;
  extraAllowedHosts?: string[];
}

export type GuardResult = { ok: true } | { ok: false; status: 403 | 415; reason: string };

function hostname(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

export function checkLocalRequest(input: GuardInput): GuardResult {
  const allowed = new Set([...LOCAL_HOSTS, ...(input.extraAllowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)]);

  if (!input.host || !allowed.has(hostname(input.host))) {
    return { ok: false, status: 403, reason: "Host not allowed. 100 Workflows only accepts requests addressed to localhost." };
  }

  const method = input.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return { ok: true };

  if (!input.origin) {
    return { ok: false, status: 403, reason: "Missing Origin header on a state-changing request." };
  }
  let originHost: string;
  try {
    originHost = new URL(input.origin).host;
  } catch {
    return { ok: false, status: 403, reason: "Malformed Origin header." };
  }
  if (originHost.toLowerCase() !== input.host.trim().toLowerCase()) {
    return { ok: false, status: 403, reason: "Cross-origin request blocked." };
  }
  if (!input.contentType?.toLowerCase().startsWith("application/json")) {
    return { ok: false, status: 415, reason: "Requests must be sent as application/json." };
  }
  return { ok: true };
}
