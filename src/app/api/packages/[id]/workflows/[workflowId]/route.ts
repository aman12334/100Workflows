import { NextResponse } from "next/server";
import { PackageError } from "@/lib/packages/resolve";
import { getDb } from "@/lib/server/db";
import { fail } from "@/lib/server/http";
import { packageErrorStatus, removeWorkflow } from "@/lib/server/package-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; workflowId: string }> }) {
  const { id, workflowId } = await params;
  try {
    if (!removeWorkflow(getDb(), id, workflowId)) return fail(404, "not_found", "Package not found.");
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PackageError) return fail(packageErrorStatus(err), err.code, err.message);
    throw err;
  }
}
