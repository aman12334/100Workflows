import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type { ApiError } from "@/lib/chat-types";

const MAX_BODY_BYTES = 200_000;

export function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json<ApiError & Record<string, unknown>>({ error: { code, message }, ...extra }, { status });
}

/** Reads and validates a JSON body. Returns either the parsed data or a ready-made error response. */
export async function readJson<T extends z.ZodType>(request: Request, schema: T, maxBytes: number = MAX_BODY_BYTES): Promise<{ data: z.infer<T> } | { response: NextResponse }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { response: fail(413, "too_large", "Request body is too large.") };
  const raw = await request.text();
  if (raw.length > maxBytes) return { response: fail(413, "too_large", "Request body is too large.") };
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return { response: fail(400, "invalid_json", "Request body must be JSON.") };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { response: fail(400, "invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")) };
  }
  return { data: parsed.data };
}
