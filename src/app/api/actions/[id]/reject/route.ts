import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionError, rejectAction } from "@/lib/server/action-service";
import { getDb } from "@/lib/server/db";
import { fail, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ reason: z.string().max(500).optional() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(request, Body);
  if ("response" in body) return body.response;
  try {
    return NextResponse.json({ action: rejectAction(getDb(), id, process.env, body.data.reason ?? "") });
  } catch (err) {
    if (err instanceof ActionError) return fail(err.status, err.status === 404 ? "not_found" : "conflict", err.message);
    throw err;
  }
}
