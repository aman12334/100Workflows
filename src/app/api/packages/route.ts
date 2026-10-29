import { NextResponse } from "next/server";
import { PackageError } from "@/lib/packages/resolve";
import { getDb } from "@/lib/server/db";
import { getConversation } from "@/lib/server/db/conversations";
import { fail, readJson } from "@/lib/server/http";
import { CreatePackageSchema, createFromSelection, packageErrorStatus } from "@/lib/server/package-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJson(request, CreatePackageSchema);
  if ("response" in body) return body.response;
  const db = getDb();
  if (body.data.conversationId && !getConversation(db, body.data.conversationId)) {
    return fail(404, "not_found", "Conversation not found.");
  }
  try {
    const id = await createFromSelection(db, body.data);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    if (err instanceof PackageError) return fail(packageErrorStatus(err), err.code, err.message);
    throw err;
  }
}
