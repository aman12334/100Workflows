import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { ContextBody, listContext, saveContext } from "@/lib/server/db/context";
import { fail, readJson } from "@/lib/server/http";
import { currentWorkspace } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ items: listContext(getDb(), currentWorkspace()) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const body = await readJson(request, ContextBody, 100_000);
  if ("response" in body) return body.response;
  try {
    return NextResponse.json({ item: saveContext(getDb(), currentWorkspace(), body.data) }, { status: 201 });
  } catch (err) {
    return fail(409, "limit", err instanceof Error ? err.message : String(err));
  }
}
