import { NextResponse } from "next/server";
import { operatorName } from "@/lib/server/action-service";
import { deleteCustomWorkflow } from "@/lib/server/builder-service";
import { getDb } from "@/lib/server/db";
import { audit } from "@/lib/server/db/audit";
import { fail } from "@/lib/server/http";
import { currentWorkspace } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deletes a builder workflow's file. Packages that already pinned it keep their snapshot. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await deleteCustomWorkflow(id))) return fail(404, "not_found", "No custom workflow with that id.");
  audit(getDb(), currentWorkspace(), "builder.deleted", operatorName(process.env), id);
  return NextResponse.json({ ok: true });
}
