import type { ApiError } from "@/lib/chat-types";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError["error"]; body: Record<string, unknown> };

/**
 * Calls the local API. Always sends JSON, which the request guard requires for
 * state-changing requests.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json" },
      body: init.body === undefined ? "{}" : JSON.stringify(init.body),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = (body as Partial<ApiError>).error ?? { code: "http_error", message: `Request failed (${res.status}).` };
      return { ok: false, status: res.status, error, body };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, error: { code: "network", message: "Couldn't reach the local server. Is `npm run dev` still running?" }, body: {} };
  }
}
