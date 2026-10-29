import { NextResponse } from "next/server";
import { checkConnection, mapModelError } from "@/lib/server/model-client";
import { getModelConfig } from "@/lib/server/config";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Verifies the key against the free Models endpoint. Never spends tokens. */
export async function POST() {
  const config = getModelConfig();
  if (!config.configured) {
    return NextResponse.json({ ok: false, code: "not_configured", message: config.problem }, { status: 200 });
  }
  try {
    const model = await checkConnection(config.model);
    return NextResponse.json({ ok: true, model: model.id, displayName: model.displayName });
  } catch (err) {
    const mapped = mapModelError(err);
    log.warn("config.check_failed", { code: mapped.code, error: err });
    return NextResponse.json({ ok: false, code: mapped.code, message: mapped.message }, { status: 200 });
  }
}
