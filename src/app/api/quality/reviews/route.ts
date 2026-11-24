import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorName } from "@/lib/server/action-service";
import { getDb } from "@/lib/server/db";
import { fail, readJson } from "@/lib/server/http";
import { loadGoldens, recordHumanReview } from "@/lib/server/quality/service";
import { getOutput } from "@/lib/server/quality/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    outputId: z.string().uuid(),
    scores: z.record(z.string(), z.number().int().min(1).max(5)),
    verdict: z.enum(["accept", "reject"]),
    severity: z.enum(["none", "minor", "major", "critical"]),
    notes: z.string().max(2000).default(""),
  })
  .strict();

/** Records a person's review of a stored live output against the workflow's golden rubric. */
export async function POST(request: Request) {
  const body = await readJson(request, Body);
  if ("response" in body) return body.response;
  const db = getDb();
  const output = getOutput(db, body.data.outputId);
  if (!output) return fail(404, "not_found", "Output not found.");
  const rubric = loadGoldens().goldens[output.workflowId]?.rubric ?? [];
  const missing = rubric.filter((r) => body.data.scores[r.id] === undefined).map((r) => r.id);
  if (missing.length) return fail(400, "invalid_request", `Score every rubric item: missing ${missing.join(", ")}.`);
  if (body.data.verdict === "accept" && (body.data.severity === "major" || body.data.severity === "critical")) return fail(400, "invalid_request", "An output with a major or critical issue can't be accepted.");
  const id = recordHumanReview(db, { workflowId: output.workflowId, workflowVersion: output.workflowVersion, outputId: body.data.outputId, fingerprint: output.fingerprint, scores: body.data.scores, verdict: body.data.verdict, severity: body.data.severity, notes: body.data.notes, reviewer: operatorName(process.env) });
  return NextResponse.json({ evidenceId: id }, { status: 201 });
}
