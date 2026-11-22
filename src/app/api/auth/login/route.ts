import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, accessToken, safeEqual, sessionValue, tokenTooShort } from "@/lib/auth";
import { getDb } from "@/lib/server/db";
import { audit } from "@/lib/server/db/audit";
import { fail, readJson } from "@/lib/server/http";
import { currentWorkspace } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Failed attempts in the last minute, per process. Enough to stop guessing from a browser tab.
const failures: number[] = [];
const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

export async function POST(request: Request) {
  const token = accessToken();
  if (!token) return fail(404, "not_enabled", "Sign-in is not enabled (WORKFLOWS_ACCESS_TOKEN is not set).");
  if (tokenTooShort()) return fail(503, "misconfigured", "WORKFLOWS_ACCESS_TOKEN is too short (24+ characters).");
  const now = Date.now();
  while (failures.length && failures[0] < now - WINDOW_MS) failures.shift();
  if (failures.length >= MAX_FAILURES) return fail(429, "rate_limited", "Too many attempts. Wait a minute and try again.");
  const body = await readJson(request, z.object({ token: z.string().max(500) }).strict());
  if ("response" in body) return body.response;
  const db = getDb();
  if (!safeEqual(await sessionValue(body.data.token), await sessionValue(token))) {
    failures.push(now);
    audit(db, currentWorkspace(), "auth.failed", "anonymous");
    return fail(401, "unauthorized", "That token isn't right.");
  }
  audit(db, currentWorkspace(), "auth.signed_in", "token holder");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await sessionValue(token), { httpOnly: true, sameSite: "strict", path: "/", secure: new URL(request.url).protocol === "https:", maxAge: 60 * 60 * 24 * 14 });
  return res;
}
