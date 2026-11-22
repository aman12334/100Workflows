import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorName } from "@/lib/server/action-service";
import { saveBuilderSpec } from "@/lib/server/builder-service";
import { getDb } from "@/lib/server/db";
import { audit } from "@/lib/server/db/audit";
import { fail, readJson } from "@/lib/server/http";
import { currentWorkspace } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Saves a builder workflow to data/custom-workflows. It then appears in the library and can be added to packages. */
export async function POST(request: Request) {
  const body = await readJson(request, z.object({ spec: z.unknown(), replace: z.boolean().optional() }).strict());
  if ("response" in body) return body.response;
  const r = await saveBuilderSpec(body.data.spec, { allowReplaceCustom: body.data.replace });
  if (!r.ok) return fail(400, "invalid_workflow", r.problems.join("; "), { problems: r.problems });
  audit(getDb(), currentWorkspace(), "builder.saved", operatorName(process.env), `${r.workflow!.id} → ${r.file}`);
  return NextResponse.json({ id: r.workflow!.id, file: r.file }, { status: 201 });
}
