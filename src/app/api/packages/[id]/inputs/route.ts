import { NextResponse } from "next/server";
import { z } from "zod";
import { formFields, validateValues } from "@/lib/packages/inputs";
import { getDb } from "@/lib/server/db";
import { saveInputs } from "@/lib/server/db/packages";
import { fail, readJson } from "@/lib/server/http";
import { loadPackageView } from "@/lib/server/package-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ values: z.record(z.string().max(200), z.unknown()) });

/** Saves setup answers. Partial saves are allowed; required fields are enforced when a run starts. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(request, Body);
  if ("response" in body) return body.response;
  const db = getDb();
  const view = await loadPackageView(db, id);
  if (!view) return fail(404, "not_found", "Package not found.");

  const result = validateValues(formFields(view.requirements), body.data.values);
  if (Object.keys(result.errors).length) {
    return fail(400, "invalid_inputs", "Some answers need fixing.", { fieldErrors: result.errors });
  }
  saveInputs(db, id, result.set, result.cleared);
  return NextResponse.json({ ok: true, saved: Object.keys(result.set).length, cleared: result.cleared.length });
}
