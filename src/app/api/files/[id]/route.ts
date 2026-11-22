import { NextResponse } from "next/server";
import { operatorName } from "@/lib/server/action-service";
import { getDb } from "@/lib/server/db";
import { audit } from "@/lib/server/db/audit";
import { deleteFile, getFileText } from "@/lib/server/db/files";
import { fail } from "@/lib/server/http";
import { currentWorkspace } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const f = getFileText(getDb(), currentWorkspace(), id);
  if (!f) return fail(404, "not_found", "File not found.");
  return NextResponse.json(f, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const ws = currentWorkspace();
  const f = getFileText(db, ws, id);
  if (!f || !deleteFile(db, ws, id)) return fail(404, "not_found", "File not found.");
  audit(db, ws, "file.deleted", operatorName(process.env), f.file.name);
  return NextResponse.json({ ok: true });
}
