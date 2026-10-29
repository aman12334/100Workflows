import { NextResponse } from "next/server";
import { PackageError } from "@/lib/packages/resolve";
import { getDb } from "@/lib/server/db";
import { fail, readJson } from "@/lib/server/http";
import { AddWorkflowSchema, addWorkflow, packageErrorStatus } from "@/lib/server/package-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(request, AddWorkflowSchema);
  if ("response" in body) return body.response;
  try {
    if (!(await addWorkflow(getDb(), id, body.data.workflowId))) return fail(404, "not_found", "Package not found.");
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PackageError) return fail(packageErrorStatus(err), err.code, err.message);
    throw err;
  }
}
