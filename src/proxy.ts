import { NextResponse, type NextRequest } from "next/server";
import { checkLocalRequest } from "@/lib/request-guard";

export function proxy(request: NextRequest) {
  const result = checkLocalRequest({
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    contentType: request.headers.get("content-type"),
    extraAllowedHosts: process.env.WORKFLOWS_ALLOWED_HOSTS?.split(","),
  });
  if (!result.ok) {
    return NextResponse.json({ error: { code: "forbidden", message: result.reason } }, { status: result.status });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
