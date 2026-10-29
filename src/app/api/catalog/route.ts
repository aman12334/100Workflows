import { NextResponse } from "next/server";
import { loadCatalog } from "@/lib/catalog/load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const catalog = await loadCatalog();
  return NextResponse.json({ workflows: catalog.workflows, errors: catalog.errors });
}
