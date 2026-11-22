import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, accessToken, isPublicPath, safeEqual, sessionValue, tokenTooShort } from "@/lib/auth";
import { checkLocalRequest } from "@/lib/request-guard";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isApi = path.startsWith("/api/");
  if (isApi) {
    const result = checkLocalRequest({
      method: request.method,
      host: request.headers.get("host"),
      origin: request.headers.get("origin"),
      contentType: request.headers.get("content-type"),
      extraAllowedHosts: process.env.WORKFLOWS_ALLOWED_HOSTS?.split(","),
    });
    if (!result.ok) return NextResponse.json({ error: { code: "forbidden", message: result.reason } }, { status: result.status });
  }

  // Optional sign-in (WORKFLOWS_ACCESS_TOKEN). Off by default for single-user localhost use.
  const token = accessToken();
  if (token && !isPublicPath(path)) {
    if (tokenTooShort()) {
      return NextResponse.json({ error: { code: "misconfigured", message: "WORKFLOWS_ACCESS_TOKEN is too short (24+ characters). Everything is locked until it is fixed." } }, { status: 503 });
    }
    const cookie = request.cookies.get(SESSION_COOKIE)?.value ?? "";
    if (!safeEqual(cookie, await sessionValue(token))) {
      if (isApi) return NextResponse.json({ error: { code: "unauthorized", message: "Sign in first." } }, { status: 401 });
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
