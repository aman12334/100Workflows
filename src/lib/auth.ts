/**
 * Optional sign-in for when the app is reachable by more than the person running it
 * (e.g. through WORKFLOWS_ALLOWED_HOSTS). Off unless WORKFLOWS_ACCESS_TOKEN is set.
 * The session cookie holds an HMAC of the token, never the token itself, so a copied
 * cookie stops working when the token is changed. There are no user accounts: anyone
 * with the token has full access (see docs/security.md).
 *
 * Uses Web Crypto only, so it runs in the request proxy and in route handlers alike.
 */

export const SESSION_COOKIE = "wf_session";
export const MIN_TOKEN_LENGTH = 24;

type Env = Record<string, string | undefined>;

export function accessToken(env: Env = process.env): string | null {
  const t = env.WORKFLOWS_ACCESS_TOKEN?.trim();
  return t ? t : null;
}

/** A configured token that is too short is treated as a configuration error: everything is refused. */
export const tokenTooShort = (env: Env = process.env) => {
  const t = accessToken(env);
  return t !== null && t.length < MIN_TOKEN_LENGTH;
};

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function sessionValue(token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("100-workflows session v1")));
}

/** Constant-time comparison of two strings (length is not secret). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Paths reachable without signing in: the sign-in page and its API, the health check, and static assets. */
export const PUBLIC_PATHS = [/^\/login$/, /^\/api\/auth\/(login|logout)$/, /^\/api\/health$/, /^\/_next\//, /^\/favicon\.ico$/, /^\/icon\.(svg|png)$/];
export const isPublicPath = (p: string) => PUBLIC_PATHS.some((r) => r.test(p));
