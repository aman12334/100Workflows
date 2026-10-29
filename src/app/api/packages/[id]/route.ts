import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { deletePackage, updatePackageMeta } from "@/lib/server/db/packages";
import { fail, readJson } from "@/lib/server/http";
import { UpdatePackageSchema } from "@/lib/server/package-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson(request, UpdatePackageSchema);
  if ("response" in body) return body.response;
  if (!updatePackageMeta(getDb(), id, body.data)) return fail(404, "not_found", "Package not found.");
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!deletePackage(getDb(), id)) return fail(404, "not_found", "Package not found.");
  return NextResponse.json({ ok: true });
}
