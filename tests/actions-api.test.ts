import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ActionRecord } from "@/lib/server/db/actions";
import { json as reply, routedModel } from "./runtime-helpers";

// Route handlers use the app-wide database; point it at memory before they load.
process.env.WORKFLOWS_DB_PATH = ":memory:";
delete process.env.WORKFLOWS_ACTIONS;

/** API routes for proposed actions and integration status. Mocked provider; nothing leaves the machine. */

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let listActions: (req: Request) => Promise<Response>;
let integrations: () => Promise<Response>;
let approve: Handler;
let reject: Handler;
let revise: Handler;
let runId: string;

const post = (body: unknown) => new Request("http://localhost/api", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const SECRET = "xoxb-test-SECRET-slack";

beforeAll(async () => {
  ({ GET: listActions } = await import("@/app/api/actions/route"));
  ({ GET: integrations } = await import("@/app/api/integrations/route"));
  ({ POST: approve } = (await import("@/app/api/actions/[id]/approve/route")) as unknown as { POST: Handler });
  ({ POST: reject } = (await import("@/app/api/actions/[id]/reject/route")) as unknown as { POST: Handler });
  ({ POST: revise } = (await import("@/app/api/actions/[id]/revise/route")) as unknown as { POST: Handler });

  const { getDb } = await import("@/lib/server/db");
  const { loadCatalog } = await import("@/lib/catalog/load");
  const { expandSelection } = await import("@/lib/packages/resolve");
  const { createPackage, getPackage, saveInputs } = await import("@/lib/server/db/packages");
  const { getRun } = await import("@/lib/server/db/runs");
  const { buildView } = await import("@/lib/server/package-service");
  const { startRun } = await import("@/lib/server/run-service");
  const catalog = (await loadCatalog()).workflows;
  const f = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/phase4/slack-communication-agent.json"), "utf8"));
  const db = getDb();
  const pkg = createPackage(db, { name: "P", goal: "", conversationId: null, members: expandSelection(catalog, ["slack-communication-agent"]) });
  saveInputs(db, pkg, { "slack-communication-agent.message_goal": f.inputs.message_goal, "slack-communication-agent.channel": f.inputs.channel }, []);
  const transport = async (req: { url: string }) => ({ status: 200, headers: {}, body: JSON.stringify(req.url.includes("conversations.list") ? f.http["GET https://slack.com/api/conversations.list"].body : { ok: true, channel: "C0LAUNCH", ts: "1" }) });
  runId = startRun(db, buildView(getPackage(db, pkg)!, catalog), { createMessage: routedModel({ write: [reply(f.good)] }).createMessage, env: { ANTHROPIC_API_KEY: "sk-ant-test", SLACK_BOT_TOKEN: SECRET }, integrationTransport: transport });
  const start = Date.now();
  while (getRun(db, runId)!.status === "running" && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 5));
});

const actions = async (q = `runId=${runId}`) => ((await (await listActions(new Request(`http://localhost/api/actions?${q}`))).json()) as { actions: ActionRecord[] }).actions;

describe("actions API", () => {
  it("lists a run's pending proposals with the payload and its hash", async () => {
    const [a] = await actions();
    expect(a).toMatchObject({ status: "pending_approval", action: "slack.post_message", payload: { channel_id: "C0LAUNCH" } });
    expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await listActions(new Request("http://localhost/api/actions?status=bogus"))).status).toBe(400);
  });

  it("validates approval bodies and refuses a hash that isn't the current payload's", async () => {
    const [a] = await actions();
    expect((await approve(post("not json"), ctx(a.id))).status).toBe(400);
    expect((await approve(post({}), ctx(a.id))).status).toBe(400);
    expect((await approve(post({ payloadHash: "f".repeat(64) }), ctx(a.id))).status).toBe(409);
    expect((await approve(post({ payloadHash: a.payloadHash }), ctx("missing"))).status).toBe(404);
  });

  it("revise supersedes; approve runs as a dry run by default and can't be replayed; reject only works while pending", async () => {
    const [a] = await actions();
    const res = await revise(post({ input: { channel_id: "C0LAUNCH", text: "Edited." } }), ctx(a.id));
    expect(res.status).toBe(200);
    const b = ((await res.json()) as { action: ActionRecord }).action;
    expect((await revise(post({ input: { channel_id: "" } }), ctx(b.id))).status).toBe(400);
    const ok = await approve(post({ payloadHash: b.payloadHash }), ctx(b.id));
    expect(((await ok.json()) as { action: ActionRecord }).action.status).toBe("dry_run");
    expect((await approve(post({ payloadHash: b.payloadHash }), ctx(b.id))).status).toBe(409);
    expect((await reject(post({}), ctx(b.id))).status).toBe(409);
  });

  it("reports integration status by setting name, never by value", async () => {
    process.env.SLACK_BOT_TOKEN = SECRET;
    try {
      const body = await (await integrations()).text();
      const parsed = JSON.parse(body) as { live: boolean; providers: Array<{ id: string; configured: boolean; missing: string[] }> };
      expect(parsed.live).toBe(false);
      expect(parsed.providers.find((p) => p.id === "slack")).toMatchObject({ configured: true, missing: [] });
      expect(parsed.providers.find((p) => p.id === "hubspot")).toMatchObject({ configured: false, missing: ["HUBSPOT_ACCESS_TOKEN"] });
      expect(body).not.toContain(SECRET);
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });
});
