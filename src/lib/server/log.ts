import "server-only";

// Anthropic (sk-ant-...) and OpenAI (sk-..., sk-proj-...) keys.
const SECRET_PATTERNS = [/sk-[A-Za-z0-9_\-]{16,}/g, /(x-api-key|authorization)["']?\s*[:=]\s*["']?[^\s"',}]+/gi];
const SECRET_KEYS = /^(api[-_]?key|authorization|x-api-key|password|token|secret)$/i;

/** Removes anything that looks like a credential from strings and nested objects. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    return SECRET_PATTERNS.reduce((s, re) => s.replace(re, (m) => (m.startsWith("sk-") ? "sk-[redacted]" : `${m.split(/[:=]/)[0]}: [redacted]`)), value);
  }
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  return value;
}

type Level = "info" | "warn" | "error";

function write(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...(redact(fields) as object) });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};
