import { NextResponse } from "next/server";
import { loadAppCatalog } from "@/lib/catalog/load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const catalog = await loadAppCatalog();
  return NextResponse.json({ workflows: catalog.workflows, errors: catalog.errors });
}
