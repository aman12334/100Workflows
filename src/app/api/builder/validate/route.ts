import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/lib/server/http";
import { validateBuilderSpec } from "@/lib/server/builder-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Validates a builder spec and returns the definition it would produce. Writes nothing. */
export async function POST(request: Request) {
  const body = await readJson(request, z.object({ spec: z.unknown(), replace: z.boolean().optional() }).strict());
  if ("response" in body) return body.response;
  const { ok, problems, definition } = await validateBuilderSpec(body.data.spec, { allowReplaceCustom: body.data.replace });
  return NextResponse.json({ ok, problems, definition });
}
