import { NextResponse } from "next/server";
import { actionsLive, connectionStatus } from "@/lib/integrations/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which providers have their settings (names of missing settings only; never values) and whether actions are live. */
export async function GET() {
  return NextResponse.json({ live: actionsLive(process.env), providers: connectionStatus(process.env) }, { headers: { "cache-control": "no-store" } });
}
