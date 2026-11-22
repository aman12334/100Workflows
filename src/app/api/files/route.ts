import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { FILE_LIMITS, FileError, extractText } from "@/lib/files/extract";
import { operatorName } from "@/lib/server/action-service";
import { getDb } from "@/lib/server/db";
import { audit } from "@/lib/server/db/audit";
import { insertFile, listFiles } from "@/lib/server/db/files";
import { fail, readJson } from "@/lib/server/http";
import { currentWorkspace } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    name: z.string().min(1).max(200).refine((n) => !/[/\\\0]/.test(n), "must be a file name, not a path"),
    contentBase64: z.string().min(1).max(Math.ceil((FILE_LIMITS.maxBytes * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64"),
  })
  .strict();

export async function GET() {
  return NextResponse.json({ files: listFiles(getDb(), currentWorkspace()), limits: { maxBytes: FILE_LIMITS.maxBytes, maxTextChars: FILE_LIMITS.maxTextChars } }, { headers: { "cache-control": "no-store" } });
}

/** Uploads a file as base64 JSON. Only its extracted text is stored; the file is never executed or kept. */
export async function POST(request: Request) {
  const body = await readJson(request, Body, Math.ceil((FILE_LIMITS.maxBytes * 4) / 3) + 2_000);
  if ("response" in body) return body.response;
  const bytes = Buffer.from(body.data.contentBase64, "base64");
  const db = getDb();
  const ws = currentWorkspace();
  try {
    const x = extractText(body.data.name, bytes);
    const { file, duplicate } = insertFile(db, ws, {
      name: body.data.name,
      kind: x.kind,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: x.text,
      truncated: x.truncated,
      notes: x.notes.join(" ") || null,
    });
    if (!duplicate) audit(db, ws, "file.uploaded", operatorName(process.env), `${file.name} (${x.kind}, ${bytes.length} bytes)`);
    return NextResponse.json({ file, duplicate }, { status: duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof FileError) return fail(422, "unreadable_file", err.message);
    throw err;
  }
}
