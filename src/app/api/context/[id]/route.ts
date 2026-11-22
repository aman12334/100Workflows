import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { ContextBody, deleteContext, saveContext } from "@/lib/server/db/context";
import { fail, readJson } from "@/lib/server/http";
import { currentWorkspace } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(request, ContextBody, 100_000);
  if ("response" in body) return body.response;
  const item = saveContext(getDb(), currentWorkspace(), { id, ...body.data });
  return item ? NextResponse.json({ item }) : fail(404, "not_found", "Context item not found.");
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return deleteContext(getDb(), currentWorkspace(), id) ? NextResponse.json({ ok: true }) : fail(404, "not_found", "Context item not found.");
}
