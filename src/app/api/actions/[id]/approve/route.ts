import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionError, approveAndExecute } from "@/lib/server/action-service";
import { getDb } from "@/lib/server/db";
import { fail, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ payloadHash: z.string().regex(/^[0-9a-f]{64}$/, "must be the payload hash shown with the action") }).strict();

/** Approves the exact payload (by hash) and executes it once; dry run unless WORKFLOWS_ACTIONS=live. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(request, Body);
  if ("response" in body) return body.response;
  try {
    const action = await approveAndExecute(getDb(), id, { payloadHash: body.data.payloadHash, signal: request.signal });
    return NextResponse.json({ action });
  } catch (err) {
    if (err instanceof ActionError) return fail(err.status, err.status === 404 ? "not_found" : "conflict", err.message);
    throw err;
  }
}
