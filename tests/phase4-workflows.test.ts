import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validateGenericDefinition } from "@/lib/catalog/catalog";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import type { HttpRequest, HttpResponse, HttpTransport } from "@/lib/integrations/core";
import { resetProviderState } from "@/lib/integrations/providers";
import { lookupAction, needsApproval, PROVIDERS } from "@/lib/integrations/registry";
import { storageKey } from "@/lib/packages/inputs";
import { expandSelection } from "@/lib/packages/resolve";
import { executeWorkflow } from "@/lib/runtime/engine";
import { resolveExecutor, runnability } from "@/lib/runtime/executors";
import { createGenericExecutor } from "@/lib/runtime/executors/generic";
import { payloadHash, type ProposedAction } from "@/lib/runtime/executors/integration";
import type { CreateMessage } from "@/lib/runtime/model";
import type { ToolCallRecord } from "@/lib/runtime/tools/runner";
import { ActionError, approveAndExecute, rejectAction, reviseAction } from "@/lib/server/action-service";
import { openDatabase, type DB } from "@/lib/server/db";
import { expireStale, getAction, listActions } from "@/lib/server/db/actions";
import { migrate } from "@/lib/server/db/migrate";
import { createPackage, getPackage, saveInputs } from "@/lib/server/db/packages";
import { getRun } from "@/lib/server/db/runs";
import { buildView } from "@/lib/server/package-service";
import { startRun } from "@/lib/server/run-service";
import { json, memoryRecorder, routedModel } from "./runtime-helpers";

/**
 * Phase 4: every integration workflow, driven by tests/fixtures/phase4/<id>.json:
 *   inputs     what the user typed
 *   http       canned provider responses by "METHOD url" (query string ignored); "then" answers later calls
 *   good       a draft whose proposed actions are valid
 *   bad        a draft that proposes an invalid action (fails the critical rule bad_fails)
 *   approve    which proposal to approve and the provider id the mock returns for it
 *
 * Everything here is MOCKED: model replies are scripted and every provider call goes to an
 * in-memory transport. No request leaves the machine. These are not real provider tests.
 */

interface Canned {
  status: number;
  body: unknown;
  then?: Canned;
}
interface Fixture {
  inputs: Record<string, unknown>;
  http: Record<string, Canned>;
  good: Record<string, unknown>;
  bad: Record<string, unknown>;
  bad_fails: string;
  approve: { key: string; expect_external_id: string; expect_header?: string };
}

const DIR = path.join(process.cwd(), "tests", "fixtures", "phase4");
const IDS = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
const fixture = (id: string): Fixture => JSON.parse(readFileSync(path.join(DIR, `${id}.json`), "utf8"));

// Fake credentials: obviously not real, and checked below never to leak into prompts, outputs or logs.
const SECRETS = {
  RESEND_API_KEY: "re_test_SECRET_resend",
  RESEND_FROM: "Acme <hello@acme.example>",
  HUBSPOT_ACCESS_TOKEN: "pat-test-SECRET-hubspot",
  SLACK_BOT_TOKEN: "xoxb-test-SECRET-slack",
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-test-SECRET-google",
  GOOGLE_REFRESH_TOKEN: "1//test-SECRET-refresh",
  LINEAR_API_KEY: "lin_api_test_SECRET_linear",
  LINEAR_TEAM_ID: "team-123",
  STRIPE_API_KEY: "rk_test_SECRET_stripe",
  MASTODON_INSTANCE_URL: "https://social.example.org",
  MASTODON_ACCESS_TOKEN: "test-SECRET-mastodon",
};
const SECRET_VALUES = Object.values(SECRETS).filter((v) => v.includes("SECRET"));
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test", ...SECRETS };
const LIVE = { ...ENV, WORKFLOWS_ACTIONS: "live", WORKFLOWS_OPERATOR: "Test Approver" };

/** In-memory provider: answers from the fixture and records every request. */
function mockTransport(http: Record<string, Canned>, override?: (req: HttpRequest, n: number) => HttpResponse | undefined) {
  const calls: HttpRequest[] = [];
  const seen: Record<string, number> = {};
  const transport: HttpTransport = async (req) => {
    calls.push(req);
    const key = `${req.method} ${req.url.split("?")[0]}`;
    const n = (seen[key] = (seen[key] ?? 0) + 1);
    const o = override?.(req, n);
    if (o) return o;
    let c = http[key];
    if (!c) return { status: 404, headers: {}, body: JSON.stringify({ message: `no mock for ${key}` }) };
    for (let i = 1; i < n && c.then; i++) c = c.then;
    return { status: c.status, headers: { "content-type": "application/json" }, body: JSON.stringify(c.body) };
  };
  return { transport, calls, writes: () => calls.filter((c) => c.method !== "GET" && !isReadPost(c)) };
}
// Read-only POSTs (search endpoints, free/busy, token refresh, GraphQL lookups) aren't writes.
const isReadPost = (c: HttpRequest) => /\/search$|freeBusy$|oauth2\.googleapis\.com\/token$/.test(c.url) || (c.url.includes("api.linear.app") && !/Create\(/.test(c.body ?? ""));

let catalog: Workflow[];
const byId = (id: string) => catalog.find((w) => w.id === id)!;
beforeAll(async () => {
  catalog = (await loadCatalog()).workflows;
});
beforeEach(() => resetProviderState());

async function run(wf: Workflow, inputs: Record<string, unknown>, createMessage: CreateMessage, transport: HttpTransport, env: Record<string, string> = ENV) {
  const { recorder, evaluations, steps } = memoryRecorder();
  const tools: ToolCallRecord[] = [];
  const r = await executeWorkflow({ workflow: wf, executor: createGenericExecutor(wf), inputs, upstream: {}, createMessage, model: "claude-opus-5-5", recorder: { ...recorder, tool: (c) => tools.push(c) }, env, integrationTransport: transport });
  return { r, evaluations, steps, tools };
}
const scripted = (...outputs: unknown[]) => routedModel({ write: outputs.map(json) });

describe("Phase 4 catalog", () => {
  it("adds exactly 10 integration workflows: 100 in total, with every earlier workflow still present", () => {
    expect(IDS).toHaveLength(10);
    expect(catalog).toHaveLength(100);
    const earlier = ["phase1", "phase2", "phase3"].flatMap((d) => readdirSync(path.join(process.cwd(), "tests", "fixtures", d)).map((f) => f.slice(0, -5)));
    expect(earlier).toHaveLength(78);
    for (const id of [...IDS, ...earlier]) expect(byId(id), id).toBeDefined();
  });
});

describe.each(IDS)("%s", (id) => {
  let wf: Workflow;
  let f: Fixture;
  beforeAll(() => {
    wf = byId(id);
    f = fixture(id);
  });

  it("is a valid schema-v2 definition whose proposals all need approval, runnable only once its provider is connected", () => {
    expect([wf.schemaVersion, wf.execution?.engine, wf.status]).toEqual([2, "generic", "available"]);
    expect(validateGenericDefinition(wf)).toEqual([]);
    expect(resolveExecutor(wf)?.workflowId).toBe(id);
    for (const i of wf.integrations) expect(PROVIDERS[i.id], i.id).toBeDefined();
    const propose = wf.steps.find((s) => s.propose)!.propose!;
    for (const p of propose) expect(needsApproval(lookupAction(p.action)!.sideEffect)).toBe(true);
    for (const r of wf.steps.find((s) => s.reads)?.reads ?? []) expect(lookupAction(r.action)!.sideEffect).toBe("read_only");
    expect(runnability(wf, ENV)).toEqual({ runnable: true });
    const blocked = runnability(wf, { ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(blocked.runnable).toBe(false);
    expect(blocked.runnable ? "" : blocked.reason).toMatch(/^Connect .* first: set [A-Z_, ]+ in \.env\.local/);
  });

  it("reads, drafts and proposes actions without performing any write, keeping credentials out of the prompt and output", async () => {
    const http = mockTransport(f.http);
    const m = scripted(f.good);
    const { r, tools } = await run(wf, f.inputs, m.createMessage, http.transport);
    expect([r.status, r.attempts], r.reason).toEqual(["succeeded", 1]);
    expect(http.writes()).toEqual([]);
    const out = r.result!.json as { proposed_actions: ProposedAction[] };
    expect(out.proposed_actions.length).toBeGreaterThan(0);
    for (const p of out.proposed_actions) expect(p.payload_hash).toBe(payloadHash(p.action, p.version, p.input));
    expect(out.proposed_actions.map((p) => p.key)).toContain(f.approve.key);
    expect(r.result!.markdown).toContain("## Proposed actions (not executed)");
    const reads = wf.steps.find((s) => s.reads)?.reads ?? [];
    expect(tools.map((t) => [t.toolId, t.status])).toEqual(reads.map((x) => [`integration:${x.action.split("@")[0]}`, "ok"]));
    const prompt = JSON.stringify(m.calls.map((c) => c.params));
    if (reads.length) expect(prompt).toContain("<integration_data");
    expect(prompt).toContain("only propose actions");
    for (const s of SECRET_VALUES) expect(JSON.stringify([prompt, r, tools])).not.toContain(s);
    expect(r.usage.modelCalls).toBe(1);
  });

  it("needs review when a proposed action is invalid", async () => {
    const { r, evaluations } = await run(wf, f.inputs, scripted(f.bad).createMessage, mockTransport(f.http).transport);
    expect(r.status).toBe("needs_review");
    for (const e of evaluations) expect(e.criticalFailures).toContain(f.bad_fails);
  });

  it("fails honestly, without drafting, when the provider rejects the credentials", async () => {
    const reads = wf.steps.find((s) => s.reads)?.reads ?? [];
    if (!reads.length) return; // nothing is read before drafting; credential errors surface at approval (tested below)
    const http = mockTransport(f.http, (req) => (/oauth2\.googleapis\.com\/token$/.test(req.url) ? { status: 400, headers: {}, body: '{"error":"invalid_grant"}' } : { status: 401, headers: {}, body: '{"message":"unauthorized"}' }));
    const m = scripted(f.good);
    const { r } = await run(wf, f.inputs, m.createMessage, http.transport);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/Couldn't read from/);
    expect(m.calls).toHaveLength(0);
    for (const s of SECRET_VALUES) expect(JSON.stringify(r)).not.toContain(s);
  });
});

async function runThroughService(db: DB, id: string, transport: HttpTransport, output?: unknown) {
  const wf = byId(id);
  const f = fixture(id);
  const pkg = createPackage(db, { name: "P", goal: "", conversationId: null, members: expandSelection(catalog, [id]) });
  const values: Record<string, unknown> = {};
  for (const input of wf.inputs) if (f.inputs[input.key] !== undefined) values[storageKey(input.shared ? null : id, input.key)] = f.inputs[input.key];
  saveInputs(db, pkg, values, []);
  const runId = startRun(db, buildView(getPackage(db, pkg)!, catalog), { createMessage: scripted(output ?? f.good).createMessage, env: ENV, integrationTransport: transport });
  const start = Date.now();
  while (getRun(db, runId)!.status === "running" && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 5));
  return { runId, result: getRun(db, runId)! };
}

describe("Phase 4 workflows through run-service and approval (mocked providers)", () => {
  let db: DB;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
  });

  it.each(IDS)("%s stores pending proposals; dry-run by default, then executes once when live", async (id) => {
    const f = fixture(id);
    const http = mockTransport(f.http);
    const { runId, result } = await runThroughService(db, id, http.transport);
    const mine = result.workflows.find((w) => w.workflowId === id)!;
    expect([result.status, mine.status]).toEqual(["completed", "succeeded"]);
    const actions = listActions(db, { runId });
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.status === "pending_approval" && a.events[0].event === "proposed")).toBe(true);
    expect(http.writes()).toEqual([]);

    const target = actions.find((a) => a.proposalKey === f.approve.key)!;
    expect(target).toBeDefined();

    // Default: dry run. Nothing is sent and the approval is used up.
    const dry = await approveAndExecute(db, target.id, { payloadHash: target.payloadHash, env: ENV, transport: http.transport });
    expect(dry.status).toBe("dry_run");
    expect(dry.approvedBy).toBe("local user");
    expect(http.writes()).toEqual([]);
    await expect(approveAndExecute(db, target.id, { payloadHash: target.payloadHash, env: LIVE, transport: http.transport })).rejects.toThrow(/only once/);

    // A fresh run, approved with actions live: exactly one write, recorded with the provider's id.
    const live = mockTransport(f.http);
    const second = await runThroughService(db, id, live.transport);
    const next = listActions(db, { runId: second.runId }).find((a) => a.proposalKey === f.approve.key)!;
    const done = await approveAndExecute(db, next.id, { payloadHash: next.payloadHash, env: LIVE, transport: live.transport });
    expect([done.status, done.error], String(done.error)).toEqual(["succeeded", null]);
    expect(done.externalId).toBe(f.approve.expect_external_id);
    expect(done.approvedBy).toBe("Test Approver");
    expect(done.events.map((e) => e.event)).toEqual(["proposed", "approved", "executing", "succeeded"]);
    const writes = live.writes();
    expect(writes).toHaveLength(1);
    if (f.approve.expect_header) expect(writes[0].headers[f.approve.expect_header]).toBe(`act-${next.id}`);

    // Replay of the same approval is refused and audited; the provider is not called again.
    await expect(approveAndExecute(db, next.id, { payloadHash: next.payloadHash, env: LIVE, transport: live.transport })).rejects.toThrow(ActionError);
    expect(live.writes()).toHaveLength(1);
    expect(getAction(db, next.id)!.events.at(-1)!.event).toBe("replay_blocked");
    for (const s of SECRET_VALUES) expect(JSON.stringify([listActions(db), getRun(db, second.runId)])).not.toContain(s);
  });

  it("refuses an approval that quotes a different payload, or a stored payload that was tampered with", async () => {
    const http = mockTransport(fixture("slack-communication-agent").http);
    const { runId } = await runThroughService(db, "slack-communication-agent", http.transport);
    const [a] = listActions(db, { runId });
    await expect(approveAndExecute(db, a.id, { payloadHash: "0".repeat(64), env: LIVE, transport: http.transport })).rejects.toThrow(/not the current payload/);
    db.prepare("UPDATE action_requests SET payload_json = ? WHERE id = ?").run(JSON.stringify({ channel_id: "C0EXEC", text: "changed" }), a.id);
    await expect(approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: LIVE, transport: http.transport })).rejects.toThrow(/changed after it was proposed/);
    expect(getAction(db, a.id)!.status).toBe("pending_approval");
    expect(getAction(db, a.id)!.events.filter((e) => e.event === "hash_mismatch")).toHaveLength(2);
    expect(http.writes()).toEqual([]);
  });

  it("revising a payload supersedes the old approval request and needs a new approval of the new hash", async () => {
    const http = mockTransport(fixture("slack-communication-agent").http);
    const { runId } = await runThroughService(db, "slack-communication-agent", http.transport);
    const [a] = listActions(db, { runId });
    const revised = reviseAction(db, a.id, { channel_id: "C0LAUNCH", text: "Bulk approvals ship Friday." }, LIVE);
    expect(revised.payloadHash).not.toBe(a.payloadHash);
    expect(revised.supersedes).toBe(a.id);
    expect(getAction(db, a.id)!.status).toBe("superseded");
    await expect(approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: LIVE, transport: http.transport })).rejects.toThrow(/superseded/);
    await expect(approveAndExecute(db, revised.id, { payloadHash: a.payloadHash, env: LIVE, transport: http.transport })).rejects.toThrow(/not the current payload/);
    expect(() => reviseAction(db, revised.id, { channel_id: "", text: "" }, LIVE)).toThrow(/Invalid payload/);
    const done = await approveAndExecute(db, revised.id, { payloadHash: revised.payloadHash, env: LIVE, transport: http.transport });
    expect(done.status).toBe("succeeded");
    expect(JSON.parse(http.writes()[0].body!).text).toBe("Bulk approvals ship Friday.");
  });

  it("rejected and expired proposals can't be approved", async () => {
    const http = mockTransport(fixture("project-task-manager").http);
    const { runId } = await runThroughService(db, "project-task-manager", http.transport);
    const [a, b] = listActions(db, { runId });
    expect(rejectAction(db, a.id, LIVE, "not now").status).toBe("rejected");
    await expect(approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: LIVE, transport: http.transport })).rejects.toThrow(/rejected/);
    db.prepare("UPDATE action_requests SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), b.id);
    await expect(approveAndExecute(db, b.id, { payloadHash: b.payloadHash, env: LIVE, transport: http.transport })).rejects.toThrow(/expired/);
    expect(getAction(db, b.id)!.status).toBe("expired");
    expect(expireStale(db)).toBe(0);
    expect(http.writes()).toEqual([]);
  });

  it("two simultaneous approvals of one action execute it once", async () => {
    const http = mockTransport(fixture("slack-communication-agent").http);
    const { runId } = await runThroughService(db, "slack-communication-agent", http.transport);
    const [a] = listActions(db, { runId });
    const results = await Promise.allSettled([1, 2].map(() => approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: LIVE, transport: http.transport })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(http.writes()).toHaveLength(1);
  });

  it("a dependency whose issues weren't created fails honestly instead of guessing (partial approval)", async () => {
    const http = mockTransport(fixture("project-task-manager").http);
    const { runId } = await runThroughService(db, "project-task-manager", http.transport);
    const blocker = listActions(db, { runId }).find((a) => a.action === "linear.create_blocker")!;
    const r = await approveAndExecute(db, blocker.id, { payloadHash: blocker.payloadHash, env: LIVE, transport: http.transport });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/task_1|not been created|first/);
    expect(http.writes()).toEqual([]);
  });

  it("records provider failures by kind: invalid credentials, permission, rate limits and unknown outcomes", async () => {
    const f = fixture("slack-communication-agent");
    const cases: Array<[string, HttpResponse | "throw", string, string]> = [
      ["auth", { status: 200, headers: {}, body: '{"ok":false,"error":"invalid_auth"}' }, "failed", "auth_invalid"],
      ["channel", { status: 200, headers: {}, body: '{"ok":false,"error":"not_in_channel"}' }, "failed", "permission_denied"],
      ["rate", { status: 429, headers: { "retry-after": "0" }, body: "" }, "failed", "rate_limited"],
      ["server", { status: 503, headers: {}, body: "" }, "unconfirmed", "unconfirmed"],
      ["network", "throw", "unconfirmed", "unconfirmed"],
    ];
    for (const [name, response, status, kind] of cases) {
      const http = mockTransport(f.http, (req) => {
        if (!req.url.endsWith("chat.postMessage")) return undefined;
        if (response === "throw") throw new TypeError("fetch failed");
        return response;
      });
      const { runId } = await runThroughService(db, "slack-communication-agent", http.transport);
      const [a] = listActions(db, { runId });
      const r = await approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: LIVE, transport: http.transport });
      expect([name, r.status, r.errorKind]).toEqual([name, status, kind]);
      expect(r.externalId).toBeNull();
      // Slack posts aren't idempotent: an unclear outcome is never retried automatically.
      expect(http.calls.filter((c) => c.url.endsWith("chat.postMessage"))).toHaveLength(1);
    }
  }, 30_000);

  it("retries a rate-limited send when the provider makes retries safe, and succeeds once", async () => {
    const f = fixture("email-campaign-executor");
    const http = mockTransport(f.http, (req, n) => (req.url.endsWith("/emails") && n === 1 ? { status: 429, headers: { "retry-after": "0" }, body: "" } : undefined));
    const { runId } = await runThroughService(db, "email-campaign-executor", http.transport);
    const [a] = listActions(db, { runId }).filter((x) => x.proposalKey === "email_1");
    const r = await approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: LIVE, transport: http.transport });
    expect(r.status).toBe("succeeded");
    const sends = http.writes();
    expect(sends).toHaveLength(2);
    expect(new Set(sends.map((s) => s.headers["idempotency-key"])).size).toBe(1);
  });

  it("fails with the setting name, not its value, when a credential is missing at approval time", async () => {
    const http = mockTransport(fixture("meeting-follow-up-agent").http);
    const { runId } = await runThroughService(db, "meeting-follow-up-agent", http.transport);
    const [a] = listActions(db, { runId });
    const { LINEAR_API_KEY: _drop, ...env } = LIVE;
    const r = await approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env, transport: http.transport });
    expect([r.status, r.errorKind]).toEqual(["failed", "not_configured"]);
    expect(r.error).toContain("LINEAR_API_KEY");
    expect(http.calls).toHaveLength(0);
  });

  it("refuses a full Stripe secret key: only a restricted read-only key is accepted", async () => {
    const wf = byId("invoice-payment-follow-up");
    const http = mockTransport(fixture("invoice-payment-follow-up").http);
    const { r } = await run(wf, fixture("invoice-payment-follow-up").inputs, scripted(fixture("invoice-payment-follow-up").good).createMessage, http.transport, { ...ENV, STRIPE_API_KEY: "sk_test_full_access" });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/restricted key \(rk_/);
    expect(r.reason).not.toContain("sk_test_full_access");
    expect(http.calls).toHaveLength(0);
  });

  it("a workflow that needs review stores no proposals", async () => {
    const f = fixture("slack-communication-agent");
    const { runId, result } = await runThroughService(db, "slack-communication-agent", mockTransport(f.http).transport, f.bad);
    expect(result.workflows[0].status).toBe("needs_review");
    expect(listActions(db, { runId })).toEqual([]);
  });
});
