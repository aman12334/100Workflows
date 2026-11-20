import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionError, reviseAction } from "@/lib/server/action-service";
import { getDb } from "@/lib/server/db";
import { fail, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ input: z.record(z.string(), z.unknown()) }).strict();

/** Replaces the payload: the old proposal is superseded and the new one needs its own approval. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(request, Body);
  if ("response" in body) return body.response;
  try {
    return NextResponse.json({ action: reviseAction(getDb(), id, body.data.input) });
  } catch (err) {
    if (err instanceof ActionError) return fail(err.status, err.status === 404 ? "not_found" : err.status === 400 ? "invalid_request" : "conflict", err.message);
    throw err;
  }
}
