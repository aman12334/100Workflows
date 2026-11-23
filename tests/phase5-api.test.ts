import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Route handlers use the app-wide database; point it at memory before they load.
process.env.WORKFLOWS_DB_PATH = ":memory:";

/** Phase 5 API routes. Local only: no model or provider calls. */

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Plain = (req: Request) => Promise<Response>;
const post = (body: unknown, method = "POST") => new Request("http://localhost/api", { method, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let files: { GET: () => Promise<Response>; POST: Plain };
let file: { GET: Handler; DELETE: Handler };
let context: { GET: () => Promise<Response>; POST: Plain };
let contextItem: { PATCH: Handler; DELETE: Handler };
let health: { GET: () => Promise<Response> };
let validate: { POST: Plain };
let runs: { GET: Plain };
let retry: { POST: Handler };

beforeAll(async () => {
  files = (await import("@/app/api/files/route")) as never;
  file = (await import("@/app/api/files/[id]/route")) as never;
  context = (await import("@/app/api/context/route")) as never;
  contextItem = (await import("@/app/api/context/[id]/route")) as never;
  health = (await import("@/app/api/health/route")) as never;
  validate = (await import("@/app/api/builder/validate/route")) as never;
  runs = (await import("@/app/api/runs/route")) as never;
  retry = (await import("@/app/api/runs/[id]/retry/route")) as never;
});

describe("files API", () => {
  it("uploads a DOCX, keeps only its text, dedupes, and deletes", async () => {
    const contentBase64 = readFileSync(path.join(process.cwd(), "tests/fixtures/files/plan.docx")).toString("base64");
    const res = await files.POST(post({ name: "plan.docx", contentBase64 }));
    expect(res.status).toBe(201);
    const { file: f } = (await res.json()) as { file: { id: string; kind: string; chars: number } };
    expect(f).toMatchObject({ kind: "docx" });
    expect((await files.POST(post({ name: "again.docx", contentBase64 }))).status).toBe(200);
    const text = (await (await file.GET(new Request("http://localhost"), ctx(f.id))).json()) as { text: string };
    expect(text.text).toContain("Launch bulk approvals");
    const { getDb } = await import("@/lib/server/db");
    const { listAudit } = await import("@/lib/server/db/audit");
    expect(listAudit(getDb(), "local").map((e) => e.event)).toContain("file.uploaded");
    expect((await file.DELETE(new Request("http://localhost"), ctx(f.id))).status).toBe(200);
    expect((await file.GET(new Request("http://localhost"), ctx(f.id))).status).toBe(404);
  });

  it("rejects unreadable files, paths as names, bad base64 and oversized bodies", async () => {
    expect((await files.POST(post({ name: "a.exe", contentBase64: "aGVsbG8=" }))).status).toBe(422);
    expect((await files.POST(post({ name: "../etc/passwd.txt", contentBase64: "aGVsbG8=" }))).status).toBe(400);
    expect((await files.POST(post({ name: "a.txt", contentBase64: "not base64!" }))).status).toBe(400);
    const big = new Request("http://localhost/api", { method: "POST", headers: { "content-length": String(20 * 1024 * 1024) }, body: "{}" });
    expect((await files.POST(big)).status).toBe(413);
  });
});

describe("context API", () => {
  it("creates, updates, lists and deletes context items with validation", async () => {
    const res = await context.POST(post({ title: "Tone", body: "Warm, brief, no jargon." }));
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { id: string } };
    expect((await contextItem.PATCH(post({ title: "Tone of voice", body: "Warm." }, "PATCH"), ctx(item.id))).status).toBe(200);
    const list = (await (await context.GET()).json()) as { items: Array<{ title: string }> };
    expect(list.items.map((i) => i.title)).toEqual(["Tone of voice"]);
    expect((await context.POST(post({ title: "", body: "x" }))).status).toBe(400);
    expect((await contextItem.PATCH(post({ title: "x", body: "y" }, "PATCH"), ctx("missing"))).status).toBe(404);
    expect((await contextItem.DELETE(new Request("http://localhost"), ctx(item.id))).status).toBe(200);
  });
});

describe("health, history and builder APIs", () => {
  it("reports database, migrations and catalog without any settings or secrets", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-SECRET-health";
    try {
      const res = await health.GET();
      const text = await res.text();
      expect(res.status).toBe(200);
      const body = JSON.parse(text);
      expect(body).toMatchObject({ ok: true, database: "ok", migrations: { pending: 0 }, catalog: { workflows: 100, errors: 0 } });
      expect(body.migrations.applied).toBe(7);
      expect(text).not.toContain("SECRET");
      expect(text).not.toMatch(/anthropic|openai|\.env|\/Users\//i);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("lists runs with filters, and refuses to retry unknown runs", async () => {
    expect((await (await runs.GET(new Request("http://localhost/api/runs?q=x&status=completed&limit=9999"))).json()).runs).toEqual([]);
    expect((await retry.POST(post({}), ctx("missing"))).status).toBe(404);
  });

  it("validates builder specs without writing anything", async () => {
    const res = await validate.POST(post({ spec: { id: "x" } }));
    const body = (await res.json()) as { ok: boolean; problems: string[] };
    expect(body.ok).toBe(false);
    expect(body.problems.length).toBeGreaterThan(3);
  });
});
