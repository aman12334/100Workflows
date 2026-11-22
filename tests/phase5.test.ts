import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { definitionFromSpec, type BuilderSpec } from "@/lib/catalog/builder";
import { loadAppCatalog, loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { capabilityOf } from "@/lib/catalog/capability";
import { SESSION_COOKIE, isPublicPath, safeEqual, sessionValue } from "@/lib/auth";
import { FILE_LIMITS, FileError, ascii85, extractText, readZip } from "@/lib/files/extract";
import { storageKey } from "@/lib/packages/inputs";
import { expandSelection } from "@/lib/packages/resolve";
import { executeWorkflow } from "@/lib/runtime/engine";
import { createGenericExecutor } from "@/lib/runtime/executors/generic";
import type { CreateMessage } from "@/lib/runtime/model";
import { openDatabase, type DB } from "@/lib/server/db";
import { deleteContext, getContext, listContext, saveContext } from "@/lib/server/db/context";
import { deleteFile, getFileText, insertFile, listFiles } from "@/lib/server/db/files";
import { migrate } from "@/lib/server/db/migrate";
import { createPackage, getPackage, saveInputs } from "@/lib/server/db/packages";
import { getRun, listRuns, workflowStats } from "@/lib/server/db/runs";
import { buildView } from "@/lib/server/package-service";
import { startRun } from "@/lib/server/run-service";
import { json, memoryRecorder } from "./runtime-helpers";

/** Phase 5: files, workspace memory, builder, retry orchestration, history, sign-in and health. All local; no network. */

const FILES = path.join(process.cwd(), "tests", "fixtures", "files");
const read = (f: string) => readFileSync(path.join(FILES, f));
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test" };

/** A minimal zip writer for hostile-input tests (CRCs are not checked by the reader). */
function zip(entries: Record<string, string>, opts: { lieSize?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(body));
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(Buffer.byteLength(body), 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(opts.lieSize ?? Buffer.byteLength(body), 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("file text extraction (real files made with Word/TextEdit, openpyxl and reportlab)", () => {
  it("reads DOCX paragraphs, decoding XML entities", () => {
    const r = extractText("plan.docx", read("plan.docx"));
    expect(r.kind).toBe("docx");
    expect(r.text).toBe("Q4 plan\nLaunch bulk approvals on 3 December & train support.\nOwner: Priya, due 2026-12-05");
  });

  it("reads every XLSX sheet as CSV, quoting commas, and says what it can't keep", () => {
    const r = extractText("pipeline.xlsx", read("pipeline.xlsx"));
    expect(r.text).toContain("## Sheet: Pipeline\nAccount,Stage,Amount\nBrightline,Contract sent,14400\n\"Northpeak, Inc.\",Discovery,40000.5");
    expect(r.text).toContain("## Sheet: Notes\nRenewals due\n,TRUE");
    expect(r.notes.join(" ")).toMatch(/serial numbers/);
    expect(r.notes.join(" ")).toMatch(/formulas had no saved value/);
  });

  it("reads text from a PDF with ASCII85 + Flate streams, across pages, with escaped parentheses", () => {
    const r = extractText("memo.pdf", read("memo.pdf"));
    expect(r.text).toBe("Board memo: runway is 18 months.\nHiring plan (Q1): 2 engineers\n\nPage two: churn fell to 2.1%");
    expect(r.notes.join(" ")).toMatch(/basic/);
  });

  it("reads CSV and text as is (BOM removed)", () => {
    expect(extractText("people.csv", read("people.csv")).text).toBe("name,email\nDana Lee,dana@brightline.example");
    expect(extractText("a.txt", Buffer.from("﻿hello\r\nworld")).text).toBe("hello\nworld");
  });

  it("refuses files whose content doesn't match their type, unsupported types, empty and oversized files", () => {
    expect(() => extractText("memo.docx", read("memo.pdf"))).toThrow(/doesn't look like a real Word/);
    expect(() => extractText("plan.pdf", read("plan.docx"))).toThrow(/doesn't look like a real PDF/);
    expect(() => extractText("plan.txt", read("plan.docx"))).toThrow(/binary/);
    expect(() => extractText("old.doc", Buffer.from("x"))).toThrow(/Unsupported file type/);
    expect(() => extractText("a.txt", Buffer.alloc(0))).toThrow(/empty/);
    expect(() => extractText("a.txt", Buffer.alloc(FILE_LIMITS.maxBytes + 1, 97))).toThrow(/larger than/);
    expect(() => extractText("u16.txt", Buffer.from("h\0i\0"))).toThrow(/binary data/);
  });

  it("refuses zip bombs, damaged zips and encrypted PDFs instead of guessing", () => {
    expect(() => readZip(zip({ "word/document.xml": "x" }, { lieSize: FILE_LIMITS.maxEntryBytes + 1 }))).toThrow(/too large/);
    expect(() => extractText("x.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]))).toThrow(FileError);
    expect(() => extractText("x.docx", zip({ "other.xml": "<x/>" }))).toThrow(/no document body/);
    expect(() => extractText("x.pdf", Buffer.from("%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >> endobj"))).toThrow(/Encrypted/);
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`f${i}`, "a".repeat(1_000_000)]));
    expect(() => readZip(zip(many))).toThrow(/expands to too much/);
  });

  it("truncates very long text and says so; reports PDFs with no text honestly", () => {
    const r = extractText("long.txt", Buffer.from("word ".repeat(60_000)));
    expect([r.truncated, r.text.length]).toEqual([true, FILE_LIMITS.maxTextChars]);
    const empty = extractText("scan.pdf", Buffer.from("%PDF-1.4\n1 0 obj << /Length 4 >> stream\nq Q\nendstream endobj"));
    expect(empty.text).toBe("");
    expect(empty.notes.join(" ")).toMatch(/Scanned PDFs/);
  });

  it("decodes ASCII85 and rejects malformed input", () => {
    expect(ascii85(Buffer.from("87cURD]i,\"Ebo80~>"))!.toString()).toBe("Hello World!");
    expect(ascii85(Buffer.from("z~>"))).toEqual(Buffer.alloc(4));
    expect(ascii85(Buffer.from("abcÿ~>"))).toBeNull();
  });
});

describe("workspace-scoped context and files", () => {
  let db: DB;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
  });

  it("never returns, changes or deletes another workspace's items", () => {
    const item = saveContext(db, "local", { title: "Company profile", body: "We sell expense software." })!;
    expect(listContext(db, "other")).toEqual([]);
    expect(getContext(db, "other", item.id)).toBeNull();
    expect(saveContext(db, "other", { id: item.id, title: "x", body: "y" })).toBeNull();
    expect(deleteContext(db, "other", item.id)).toBe(false);
    expect(getContext(db, "local", item.id)!.body).toBe("We sell expense software.");

    const f = insertFile(db, "local", { name: "a.txt", kind: "txt", sizeBytes: 5, sha256: "h1", text: "hello", truncated: false, notes: null });
    expect(f.duplicate).toBe(false);
    expect(insertFile(db, "local", { name: "copy.txt", kind: "txt", sizeBytes: 5, sha256: "h1", text: "hello", truncated: false, notes: null })).toMatchObject({ duplicate: true, file: { id: f.file.id } });
    expect(listFiles(db, "other")).toEqual([]);
    expect(getFileText(db, "other", f.file.id)).toBeNull();
    expect(deleteFile(db, "other", f.file.id)).toBe(false);
    expect(getFileText(db, "local", f.file.id)!.text).toBe("hello");
    // The same content in another workspace is its own record.
    expect(insertFile(db, "other", { name: "a.txt", kind: "txt", sizeBytes: 5, sha256: "h1", text: "hello", truncated: false, notes: null }).duplicate).toBe(false);
  });
});

const SPEC: BuilderSpec = {
  id: "board-update-writer",
  name: "Board Update Writer",
  category: "finance",
  summary: "Turns your monthly numbers and notes into a short, honest board update.",
  whoFor: "founders writing monthly investor and board updates.",
  limitations: "uses only the numbers you give; it does not check them.",
  problems: ["Write my monthly board update", "Turn metrics into an investor update", "Summarise the month for the board"],
  tags: ["board", "investor-update"],
  inputs: [{ key: "notes", label: "Numbers and notes", type: "long_text", required: true, description: "This month's metrics, wins and problems." }],
  instructions: "You are a candid CFO. Report bad news plainly and never invent numbers.",
  task: "Write the update from the notes: headline, highlights, lowlights and asks.",
  sections: [
    { key: "headline", title: "Headline", kind: "text", maxWords: 30 },
    { key: "highlights", title: "Highlights", kind: "list", minItems: 1, maxItems: 5 },
  ],
};

describe("builder", () => {
  let dir: string;
  let builder: typeof import("@/lib/server/builder-service");
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wf-custom-"));
    process.env.WORKFLOWS_CUSTOM_DIR = dir;
    builder = await import("@/lib/server/builder-service");
  });
  afterAll(() => {
    process.env.WORKFLOWS_CUSTOM_DIR = "off";
    rmSync(dir, { recursive: true, force: true });
  });

  it("validates a spec into a model-only schema-v2 definition, and reports problems in plain words", async () => {
    const ok = await builder.validateBuilderSpec(SPEC);
    expect(ok.problems).toEqual([]);
    expect(ok.workflow).toMatchObject({ schemaVersion: 2, tools: [], integrations: [] });
    expect(capabilityOf(ok.workflow!)).toBe("model");
    expect((await builder.validateBuilderSpec({ ...SPEC, id: "market-research" })).problems).toContain('"market-research" is a catalog workflow id; choose another');
    const bad = await builder.validateBuilderSpec({ ...SPEC, problems: ["one"], inputs: [{ ...SPEC.inputs[0], type: "select" }] });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/problems/);
    expect(bad.problems.join(" ")).toMatch(/needs options/);
    expect((await builder.validateBuilderSpec({ ...SPEC, tools: [{ id: "web_search" }] })).ok).toBe(false);
  });

  it("saves to the custom directory, appears in the app catalog (not the official one), runs, and can be deleted", async () => {
    const saved = await builder.saveBuilderSpec(SPEC);
    expect(saved.ok).toBe(true);
    expect(readdirSync(path.join(dir, "finance"))).toEqual(["board-update-writer.json"]);
    expect((await builder.saveBuilderSpec(SPEC)).problems).toContain('a custom workflow "board-update-writer" already exists');
    expect((await builder.saveBuilderSpec({ ...SPEC, category: "operations" }, { allowReplaceCustom: true })).ok).toBe(true);
    expect(readdirSync(path.join(dir, "finance"))).toEqual([]);

    const app = await loadAppCatalog();
    expect(app.errors).toEqual([]);
    const wf = app.workflows.find((w) => w.id === "board-update-writer")!;
    expect(app.sources[wf.id]).toBe("custom/operations/board-update-writer.json");
    expect((await loadCatalog()).workflows.some((w) => w.id === wf.id)).toBe(false);

    const { recorder } = memoryRecorder();
    const createMessage: CreateMessage = async () => json({ headline: "Revenue up 12%; churn flat.", highlights: ["Closed Brightline"] });
    const r = await executeWorkflow({ workflow: wf, executor: createGenericExecutor(wf), inputs: { notes: "Revenue up 12%." }, upstream: {}, createMessage, model: "claude-opus-5-5", recorder, env: { ...ENV, WORKFLOWS_MODEL_REVIEW: "off" } });
    expect([r.status, r.reason]).toEqual(["succeeded", undefined]);

    expect(await builder.deleteCustomWorkflow("board-update-writer")).toBe(true);
    expect(await builder.deleteCustomWorkflow("../../etc")).toBe(false);
    expect((await loadAppCatalog()).workflows.some((w) => w.id === "board-update-writer")).toBe(false);
  });

  it("generates criteria that the generic executor accepts for every section option", () => {
    const def = definitionFromSpec({ ...SPEC, sections: [{ key: "only", title: "Only", kind: "text" }] }) as { steps: unknown[]; evaluation: { criteria: unknown[] } };
    expect(def.steps).toHaveLength(1);
    expect(def.evaluation.criteria).toHaveLength(1);
  });
});

describe("retry failed workflows and run history", () => {
  let db: DB;
  let catalog: Workflow[];
  const A = "user-story-splitter";
  const B = "release-notes-writer";
  const fx = (id: string) => JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "phase1", `${id}.json`), "utf8"));

  beforeAll(async () => {
    catalog = (await loadCatalog()).workflows;
  });
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
  });

  /** Replies by workflow (matched on its system prompt), so order doesn't matter. */
  function model(replies: Record<string, unknown>) {
    const calls: string[] = [];
    const createMessage: CreateMessage = async (params) => {
      const id = Object.keys(replies).find((k) => String(params.system ?? "").includes(catalog.find((w) => w.id === k)!.execution!.system!.slice(0, 60)))!;
      calls.push(id);
      return json(replies[id]);
    };
    return { createMessage, calls };
  }
  async function runPkg(pkg: string, replies: Record<string, unknown>, retryOf?: string) {
    const m = model(replies);
    const runId = startRun(db, buildView(getPackage(db, pkg)!, catalog), { createMessage: m.createMessage, env: { ...ENV, WORKFLOWS_MODEL_REVIEW: "off" }, retryOf });
    const start = Date.now();
    while (getRun(db, runId)!.status === "running" && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 5));
    return { run: getRun(db, runId)!, calls: m.calls };
  }

  it("re-runs only what didn't succeed, reusing identical accepted results; changed inputs run again", async () => {
    const [a, b] = [fx(A), fx(B)];
    const members = expandSelection(catalog, [A, B]);
    expect(members.map((m) => m.workflow.id).sort()).toEqual([B, A].sort());
    const pkg = createPackage(db, { name: "Release", goal: "", conversationId: null, members });
    const values: Record<string, unknown> = {};
    for (const [id, f] of [[A, a], [B, b]] as const) for (const input of catalog.find((w) => w.id === id)!.inputs) if (f.inputs[input.key] !== undefined) values[storageKey(input.shared ? null : id, input.key)] = f.inputs[input.key];
    saveInputs(db, pkg, values, []);

    const first = await runPkg(pkg, { [A]: a.good, [B]: b.bad });
    expect(first.run.workflows.map((w) => [w.workflowId, w.status]).sort()).toEqual([[A, "succeeded"], [B, "needs_review"]].sort());

    const second = await runPkg(pkg, { [A]: a.good, [B]: b.good }, first.run.id);
    expect(second.run.retryOf).toBe(first.run.id);
    const ra = second.run.workflows.find((w) => w.workflowId === A)!;
    const rb = second.run.workflows.find((w) => w.workflowId === B)!;
    expect([ra.status, rb.status]).toEqual(["succeeded", "succeeded"]);
    expect(ra.reusedFrom?.runId).toBe(first.run.id);
    expect(ra.output).toEqual(first.run.workflows.find((w) => w.workflowId === A)!.output);
    expect(ra.evaluations.length).toBeGreaterThan(0);
    expect(ra.usage).toBeNull();
    expect(second.calls).not.toContain(A);
    expect(second.calls).toContain(B);

    // Changing A's input means its earlier result no longer applies.
    const key = Object.keys(values).find((k) => k.startsWith(`${A}.`) || !k.includes("."))!;
    saveInputs(db, pkg, { ...values, [key]: `${String(values[key])} (edited)` }, []);
    const third = await runPkg(pkg, { [A]: a.good, [B]: b.good }, second.run.id);
    expect(third.run.workflows.find((w) => w.workflowId === A)!.reusedFrom).toBeNull();
    expect(third.calls).toContain(A);

    // History filters and per-workflow outcomes.
    expect(listRuns(db).map((r) => r.id)).toEqual([third.run.id, second.run.id, first.run.id]);
    expect(listRuns(db, { workflowId: B, status: "completed" })).toHaveLength(3);
    expect(listRuns(db, { q: "relea" })).toHaveLength(3);
    expect(listRuns(db, { q: "nothing%" })).toHaveLength(0);
    expect(listRuns(db, { since: "2999-01-01" })).toHaveLength(0);
    const stats = Object.fromEntries(workflowStats(db).map((s) => [s.workflowId, s]));
    expect(stats[B]).toMatchObject({ runs: 3, succeeded: 2, needsReview: 1 });
  });

  it("refuses to retry a run from another package", async () => {
    const pkgA = createPackage(db, { name: "A", goal: "", conversationId: null, members: expandSelection(catalog, [A]) });
    const pkgB = createPackage(db, { name: "B", goal: "", conversationId: null, members: expandSelection(catalog, [A]) });
    const f = fx(A);
    for (const p of [pkgA, pkgB]) saveInputs(db, p, Object.fromEntries(catalog.find((w) => w.id === A)!.inputs.filter((i) => f.inputs[i.key] !== undefined).map((i) => [storageKey(i.shared ? null : A, i.key), f.inputs[i.key]])), []);
    const { run } = await runPkg(pkgA, { [A]: f.good });
    expect(() => startRun(db, buildView(getPackage(db, pkgB)!, catalog), { createMessage: model({ [A]: f.good }).createMessage, env: ENV, retryOf: run.id })).toThrow(/isn't part of this package/);
  });
});

describe("optional sign-in", () => {
  let proxy: (r: NextRequest) => Promise<Response>;
  const TOKEN = "a-very-long-local-access-token-123";
  beforeAll(async () => {
    ({ proxy } = (await import("@/proxy")) as unknown as { proxy: typeof proxy });
  });
  afterAll(() => {
    delete process.env.WORKFLOWS_ACCESS_TOKEN;
  });
  const req = (url: string, init: { cookie?: string; method?: string } = {}) =>
    new NextRequest(url, { method: init.method ?? "GET", headers: { host: "localhost:3000", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.method === "POST" ? { origin: "http://localhost:3000", "content-type": "application/json" } : {}) } });

  it("is off by default, and when on requires the session cookie for pages and APIs", async () => {
    delete process.env.WORKFLOWS_ACCESS_TOKEN;
    expect((await proxy(req("http://localhost:3000/runs"))).status).toBe(200);
    process.env.WORKFLOWS_ACCESS_TOKEN = TOKEN;
    const page = await proxy(req("http://localhost:3000/runs"));
    expect([page.status, page.headers.get("location")]).toEqual([307, "http://localhost:3000/login"]);
    expect((await proxy(req("http://localhost:3000/api/actions"))).status).toBe(401);
    expect((await proxy(req("http://localhost:3000/api/health"))).status).toBe(200);
    expect((await proxy(req("http://localhost:3000/login"))).status).toBe(200);
    const cookie = `${SESSION_COOKIE}=${await sessionValue(TOKEN)}`;
    expect((await proxy(req("http://localhost:3000/api/actions", { cookie }))).status).toBe(200);
    expect((await proxy(req("http://localhost:3000/api/actions", { cookie: `${SESSION_COOKIE}=${await sessionValue("another-token-of-enough-length")}` }))).status).toBe(401);
    // The local request guard still applies to signed-in requests.
    expect((await proxy(new NextRequest("http://localhost:3000/api/runs/x/cancel", { method: "POST", headers: { host: "localhost:3000", cookie, origin: "https://evil.example" } }))).status).toBe(403);
  });

  it("locks everything when the token is too short", async () => {
    process.env.WORKFLOWS_ACCESS_TOKEN = "short";
    expect((await proxy(req("http://localhost:3000/runs"))).status).toBe(503);
  });

  it("compares in constant time and keeps the sign-in page public", async () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(await sessionValue(TOKEN)).not.toContain(TOKEN);
    expect(["/login", "/api/health", "/api/auth/login", "/_next/static/x.js"].every(isPublicPath)).toBe(true);
    expect(["/", "/api/actions", "/api/auth/other", "/settings"].some(isPublicPath)).toBe(false);
  });
});
