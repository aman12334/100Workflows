import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { CRITERIA, DIMENSIONS } from "@/lib/quality/criteria";
import { GoldenSchema, checkExpectations } from "@/lib/quality/golden";
import { cannedProvider } from "@/lib/quality/mocks";
import type { WorkflowProfile } from "@/lib/quality/profile";
import { computeScorecard, staleReason } from "@/lib/quality/scorecard";
import type { Evidence, EvidenceMode, Fingerprint } from "@/lib/quality/types";
import { openDatabase, type DB } from "@/lib/server/db";
import { migrate } from "@/lib/server/db/migrate";
import { codeHash, platformFingerprint, workflowFingerprint } from "@/lib/server/quality/fingerprint";
import { runHarness } from "@/lib/server/quality/harness";
import { liveProblems } from "@/lib/server/quality/live";
import { catalogReadiness, loadGoldens, profileOf, recordHumanReview, recordLiveExecution, releaseReport, runbookEvidence, staticEvidence, verifyAutomated } from "@/lib/server/quality/service";
import { listEvidence, startQualityRun, storeOutput } from "@/lib/server/quality/store";

/**
 * Tests of the readiness system itself. Everything is mocked; where a test needs "live" or
 * "human" evidence it records it directly to exercise the rules, and says so. None of this
 * proves any workflow is production-ready.
 */

let catalog: Workflow[];
beforeAll(async () => {
  catalog = (await loadCatalog()).workflows;
});
const byId = (id: string) => catalog.find((w) => w.id === id)!;

// ---------------------------------------------------------------- pure scorecard rules

const FP: Fingerprint = { definition: "def-1", code: "code-1", components: ["golden@1"] };
const PLATFORM: Fingerprint = { definition: "*", code: "plat-1", components: [] };
const profile = (over: Partial<WorkflowProfile> = {}): WorkflowProfile => ({
  id: "wf", name: "WF", category: "product", version: "0.1.0", executable: true, handWritten: false, executionType: "model", agentSteps: 1, hasModelReview: false,
  tools: [], usesWebSearch: false, usesWebFetch: false, calculation: null, integrations: [], actions: [], reads: [], credentials: [],
  inputs: [{ key: "brief", type: "long_text", required: true }], outputs: ["summary"], dependencies: [], limits: { maxModelCalls: 2, maxRetries: 1, timeoutSeconds: 180, maxOutputTokens: null }, ...over,
});
let seq = 0;
const ev = (criterion: string, mode: EvidenceMode, status: "passed" | "failed" = "passed", over: Partial<Evidence> = {}): Evidence => ({
  id: `e${++seq}`, qualityRunId: null, workflowId: "wf", workflowVersion: "0.1.0", criterion, mode, status, detail: `${criterion} ${status}`, fingerprint: FP, data: null, source: "test",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), ...over,
});
const passAll = (p: WorkflowProfile, levels: number[], modeFor: (c: (typeof CRITERIA)[number]) => EvidenceMode = (c) => c.accepts[0]) =>
  CRITERIA.filter((c) => levels.includes(c.level) && c.appliesTo(p)).map((c) => ev(c.id, modeFor(c), "passed", c.platform ? { workflowId: "*", fingerprint: PLATFORM } : {}));
const card = (p: WorkflowProfile, e: Evidence[]) => computeScorecard(p, e, { workflow: FP, platform: PLATFORM });

describe("scorecard", () => {
  it("has the requested dimension weights", () => {
    expect(Object.fromEntries(Object.entries(DIMENSIONS).map(([k, d]) => [k, d.weight]))).toEqual({ functional: 20, output_quality: 20, reliability: 15, security: 15, integration: 10, performance: 5, user_experience: 5, operational: 10 });
    expect(Object.values(DIMENSIONS).reduce((s, d) => s + d.weight, 0)).toBe(100);
  });

  it("starts at level 0 with no evidence and no score, and never auto-passes anything", () => {
    const s = card(profile(), []);
    expect([s.level, s.score, s.release]).toEqual([0, null, "not_certified"]);
    expect(s.criteria.filter((c) => c.status === "passed")).toEqual([]);
  });

  it("moves through levels 1, 2 and 3 only as the required evidence arrives", () => {
    const p = profile();
    const l1 = passAll(p, [1]);
    expect(card(p, l1).level).toBe(1);
    const l2 = [...l1, ...passAll(p, [2])];
    expect(card(p, l2).level).toBe(2);
    const l3 = [...l2, ...passAll(p, [3])];
    const s = card(p, l3);
    expect([s.level, s.release, s.score]).toEqual([3, "certified", 100]);
    expect(s.nextLevel).toBeNull();
  });

  it("never lets mocked evidence satisfy live or human criteria", () => {
    const p = profile();
    const mockedEverything = passAll(p, [1, 2, 3], () => "mocked");
    const s = card(p, mockedEverything);
    for (const id of ["live_execution", "golden_assertions_live", "human_review", "live_reliability", "live_latency_cost"]) expect(s.criteria.find((c) => c.id === id)!.status, id).toBe("missing");
    expect(s.level).toBeLessThan(2);
    expect(s.awaitingLive).toBe(true);
    expect(s.awaitingHumanReview).toBe(true);
  });

  it("a failed blocker blocks release whatever the score, and caps the level", () => {
    const p = profile();
    const everything = [...passAll(p, [1, 2, 3]), ev("no_credential_leak", "mocked", "failed")];
    const s = card(p, everything);
    expect(s.score!).toBeGreaterThan(90);
    expect([s.release, s.level]).toEqual(["blocked", 1]);
    expect(s.blockers.map((b) => b.id)).toEqual(["no_credential_leak"]);
    expect(s.issues[0]).toMatchObject({ criterion: "no_credential_leak", severity: "critical" });
  });

  it("a human review flagging a critical issue blocks release", () => {
    const p = profile();
    const s = card(p, [...passAll(p, [1, 2, 3]), ev("human_review", "human", "failed", { data: { severity: "critical", verdict: "reject" } })]);
    expect([s.release, s.level]).toEqual(["blocked", 2]);
  });

  it("uses only the newest evidence per criterion and keeps history", () => {
    const p = profile();
    const base = passAll(p, [1]);
    const older = ev("happy_path", "mocked", "failed", { createdAt: "2025-01-01T00:00:00.000Z" });
    expect(card(p, [older, ...base]).level).toBe(1);
    const newer = ev("happy_path", "mocked", "failed", { createdAt: "2027-01-01T00:00:00.000Z" });
    const s = card(p, [...base, newer]);
    expect(s.criteria.find((c) => c.id === "happy_path")).toMatchObject({ status: "failed", evidence: { id: newer.id } });
    expect(s.level).toBe(0);
  });

  it("marks evidence stale when the definition, code or a component version changes", () => {
    const p = profile();
    const e = passAll(p, [1]);
    expect(card(p, e).level).toBe(1);
    for (const [changed, why] of [
      [{ ...FP, definition: "def-2" }, /definition changed/],
      [{ ...FP, code: "code-2" }, /runtime code/],
      [{ ...FP, components: ["golden@2"] }, /component versions changed \(golden@2\)/],
    ] as Array<[Fingerprint, RegExp]>) {
      const s = computeScorecard(p, e, { workflow: changed, platform: PLATFORM });
      const happy = s.criteria.find((c) => c.id === "happy_path")!;
      expect(happy.status).toBe("stale");
      expect(happy.staleReason).toMatch(why);
      expect(s.level).toBe(0);
    }
    expect(staleReason(FP, FP)).toBeNull();
  });

  it("applies criteria by workflow type and re-normalises weights over applicable dimensions", () => {
    const model = card(profile(), []);
    const na = (s: typeof model) => s.criteria.filter((c) => c.status === "not_applicable").map((c) => c.id);
    expect(na(model)).toEqual(expect.arrayContaining(["calculation_exact", "ssrf_blocked", "approval_enforced", "provider_live", "tools_live", "tool_calls_traced", "actionable_errors"]));
    const integ = card(profile({ executionType: "integration", integrations: ["slack"], reads: ["slack.list_channels@1"], credentials: ["SLACK_BOT_TOKEN"] }), []);
    expect(na(integ)).not.toContain("approval_enforced");
    expect(na(integ)).not.toContain("provider_live");
    expect(na(integ)).toContain("calculation_exact");
    // A model-only workflow with everything passed scores 100: N/A criteria don't count against it.
    expect(card(profile(), passAll(profile(), [1, 2, 3])).score).toBe(100);
  });

  it("only platform evidence (workflow '*') satisfies platform criteria", () => {
    const p = profile();
    const own = ev("monitoring", "mocked");
    expect(card(p, [own]).criteria.find((c) => c.id === "monitoring")!.status).toBe("missing");
    expect(card(p, [ev("monitoring", "mocked", "passed", { workflowId: "*", fingerprint: PLATFORM })]).criteria.find((c) => c.id === "monitoring")!.status).toBe("passed");
  });
});

// ---------------------------------------------------------------- golden datasets

describe("golden datasets", () => {
  it("every executable workflow has a valid, versioned dataset with a typical scenario and a rubric", () => {
    const { goldens, errors } = loadGoldens();
    expect(errors).toEqual([]);
    const exec = catalog.filter((w) => w.status === "available");
    expect(exec).toHaveLength(93);
    for (const w of exec) {
      const g = goldens[w.id];
      expect(g, w.id).toBeDefined();
      expect(GoldenSchema.safeParse(g).success).toBe(true);
      expect(g.scenarios.some((s) => s.kind === "typical")).toBe(true);
      expect(g.rubric.length).toBeGreaterThan(2);
    }
    expect(Object.values(goldens).filter((g) => g.scenarios.some((s) => s.kind === "known_bad")).length).toBeGreaterThanOrEqual(90);
  });

  it("checks expectations deterministically", () => {
    const expect_ = { status: "succeeded" as const, requiredFields: ["a", "b.c"], requiredText: ["Brightline"], forbiddenText: ["sk-ant-"], values: { "n.x": 4 } };
    expect(checkExpectations(expect_, { status: "succeeded", output: { a: [], b: { c: "Brightline" }, n: { x: 4 } } })).toEqual([]);
    const p = checkExpectations(expect_, { status: "succeeded", output: { a: null, b: {}, n: { x: 5 }, key: "sk-ant-123" } });
    expect(p.join(" | ")).toMatch(/"a" is missing.*"b.c" is missing.*Brightline.*n\.x is 5, expected 4.*sk-ant-/);
    expect(checkExpectations({ status: "needs_review", criticalFailures: ["x"], requiredFields: [], requiredText: [], forbiddenText: [] }, { status: "needs_review", output: {}, criticalFailures: ["y"] })).toEqual(['critical check "x" did not fail']);
  });
});

// ---------------------------------------------------------------- fingerprints

describe("fingerprints", () => {
  it("separate code by execution type, and change with the definition", () => {
    expect(codeHash("research")).not.toBe(codeHash("calculation"));
    expect(codeHash("model")).toBe(codeHash("model"));
    const wf = byId("prd-writer");
    const p = profileOf(wf);
    const a = workflowFingerprint(wf, p, 1);
    const b = workflowFingerprint({ ...wf, execution: { ...wf.execution!, system: `${wf.execution!.system} Changed.` } }, p, 1);
    expect(a.definition).not.toBe(b.definition);
    expect(a.code).toBe(b.code);
    expect(workflowFingerprint(wf, p, 2).components).toContain("golden@2");
    const calc = byId("unit-economics-calculator");
    expect(workflowFingerprint(calc, profileOf(calc), 1).components.some((c) => c.startsWith("calc:unit_economics@"))).toBe(true);
    expect(platformFingerprint().definition).toBe("*");
  });
});

// ---------------------------------------------------------------- harness on real workflows

describe("automated harness (mocked)", () => {
  const ONE_PER_TYPE = ["prd-writer", "source-synthesis", "company-research-brief", "unit-economics-calculator", "crm-contact-manager", "meeting-follow-up-agent", "survey-designer"];

  it.each(ONE_PER_TYPE)("%s passes every applicable automated check", async (id) => {
    const wf = byId(id);
    const results = await runHarness(wf, profileOf(wf), loadGoldens().goldens[id], catalog);
    expect(results.filter((r) => r.status === "failed").map((r) => `${r.criterion}: ${r.detail}`)).toEqual([]);
    const ran = new Set(results.map((r) => r.criterion));
    for (const c of ["happy_path", "golden_scenarios", "model_failure_handled", "cancellation", "no_credential_leak", "end_to_end", "trace_recorded"]) expect(ran.has(c), c).toBe(true);
  }, 30_000);

  it("runs only the cases that apply to the workflow type", async () => {
    const research = byId("source-synthesis");
    const r = new Set((await runHarness(research, profileOf(research), loadGoldens().goldens[research.id], catalog)).map((x) => x.criterion));
    expect([r.has("ssrf_blocked"), r.has("tool_failure_handled"), r.has("approval_enforced"), r.has("calculation_exact")]).toEqual([true, true, false, false]);
    const integ = byId("slack-communication-agent");
    const i = new Set((await runHarness(integ, profileOf(integ), loadGoldens().goldens[integ.id], catalog)).map((x) => x.criterion));
    expect([i.has("approval_enforced"), i.has("provider_errors_handled"), i.has("actionable_errors"), i.has("ssrf_blocked")]).toEqual([true, true, true, false]);
  }, 30_000);

  it("detects a regression: a definition whose critical checks were removed fails the blocker", async () => {
    const wf = byId("prd-writer");
    const weakened: Workflow = { ...wf, evaluation: { ...wf.evaluation, criteria: wf.evaluation.criteria.map((c) => ({ ...c, critical: c.method === "schema" })) } };
    const results = await runHarness(weakened, profileOf(weakened), loadGoldens().goldens[wf.id], catalog);
    expect(results.find((r) => r.criterion === "rejects_bad_output")).toMatchObject({ status: "failed" });
  }, 30_000);

  it("catches a calculation that disagrees with the independently expected values", async () => {
    const wf = byId("unit-economics-calculator");
    const golden = structuredClone(loadGoldens().goldens[wf.id]);
    const typical = golden.scenarios.find((s) => s.kind === "typical")!;
    const [k, v] = Object.entries(typical.expect.values!)[0];
    typical.expect.values![k] = typeof v === "number" ? v + 1 : "wrong";
    const results = await runHarness(wf, profileOf(wf), golden, catalog);
    expect(results.find((r) => r.criterion === "calculation_exact")).toMatchObject({ status: "failed" });
  }, 30_000);
});

// ---------------------------------------------------------------- service, evidence and release gates

describe("evidence, readiness and release gates", () => {
  let db: DB;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
  });

  it("records mocked evidence that the scorecard traces back to, and reaches level 1 but not 2", async () => {
    const r = await verifyAutomated(db, { ids: ["prd-writer", "unit-economics-calculator"] });
    expect([r.workflows, r.failed]).toEqual([2, 0]);
    const readiness = await catalogReadiness(db, { ids: ["prd-writer", "unit-economics-calculator"] });
    const stored = new Set(listEvidence(db).map((e) => e.id));
    for (const w of readiness.workflows) {
      expect(w.scorecard.level, w.workflow.id).toBe(1);
      for (const c of w.scorecard.criteria.filter((x) => x.evidence && x.evidence.mode !== "static")) expect(stored.has(c.evidence!.id), `${c.id} evidence is a stored record`).toBe(true);
      expect(w.scorecard.criteria.find((c) => c.id === "live_execution")!.status).toBe("missing");
    }
    const report = releaseReport(readiness, 2);
    expect(report.ok).toBe(false);
    expect(report.failing.every((f) => f.missing.includes("live_execution"))).toBe(true);
    expect(releaseReport(readiness, 1).ok).toBe(true);
  }, 60_000);

  it("simulated live and human evidence (recorded directly, not real) move a workflow to level 3; a definition change makes it stale", async () => {
    const id = "prd-writer";
    await verifyAutomated(db, { ids: [id] });
    const wf = byId(id);
    const profile = profileOf(wf);
    const golden = loadGoldens().goldens[id];
    const fingerprint = workflowFingerprint(wf, profile, golden.datasetVersion);
    const typical = golden.scenarios.find((s) => s.kind === "typical")!;
    // Platform evidence and the runbook are required for level 3.
    const { recordPlatformSuite } = await import("@/lib/server/quality/service");
    const runId = startQualityRun(db, "platform");
    for (const c of ["platform_security", "monitoring"] as const) recordPlatformSuite(db, runId, c, { files: ["x"], passed: 3, failed: 0, failures: [] });
    expect(runbookEvidence().status).toBe("passed");
    for (let i = 0; i < 3; i++) {
      const outputId = storeOutput(db, { qualityRunId: null, workflowId: id, workflowVersion: wf.version, scenario: "typical", status: "succeeded", output: typical.mock!.replies[0], markdown: "x", fingerprint });
      recordLiveExecution(db, startQualityRun(db, "live"), { wf, profile, fingerprint, golden }, "typical", {
        status: "succeeded", reason: null, output: typical.mock!.replies[0], markdown: "x", criticalFailures: [], proposals: 0, sources: 0, durationMs: 20_000,
        usage: { inputTokens: 3000, outputTokens: 1500, modelCalls: 1, webSearches: 0 }, provider: "anthropic", model: "claude-opus-5-5", costUsd: 0.05, toolVersions: [], outputId,
      });
      if (i === 2) recordHumanReview(db, { workflowId: id, workflowVersion: wf.version, outputId, fingerprint, scores: Object.fromEntries(golden.rubric.map((r) => [r.id, 4])), verdict: "accept", severity: "none", notes: "", reviewer: "tester" });
    }
    let w = (await catalogReadiness(db, { ids: [id] })).workflows[0];
    expect(w.scorecard.criteria.filter((c) => c.status !== "passed" && c.status !== "not_applicable").map((c) => `${c.id}:${c.status}`)).toEqual([]);
    expect([w.scorecard.level, w.scorecard.release]).toEqual([3, "certified"]);

    // Same evidence, changed prompt: everything recorded is stale and the workflow drops back.
    const changed = { ...wf, execution: { ...wf.execution!, system: `${wf.execution!.system} New rule.` } };
    const p2 = profileOf(changed);
    const { computeScorecard: compute } = await import("@/lib/quality/scorecard");
    const fp2 = workflowFingerprint(changed, p2, golden.datasetVersion);
    const s = compute(p2, [...listEvidence(db, [id]), ...staticEvidence(changed, p2, fp2, []), runbookEvidence()], { workflow: fp2, platform: platformFingerprint() });
    expect(s.level).toBe(0);
    expect(s.criteria.find((c) => c.id === "human_review")!.status).toBe("stale");
    const report = releaseReport({ workflows: [{ ...w, scorecard: s }], goldenErrors: [], generatedAt: "" }, 3);
    expect(report.regressions.some((r) => r.criterion === "human_review" && /definition changed/.test(r.reason))).toBe(true);
    w = (await catalogReadiness(db, { ids: [id] })).workflows[0];
    expect(w.scorecard.level).toBe(3); // the unchanged catalog definition is still certified
  }, 60_000);

  it("a failing live run never counts, and live reliability needs the last 3 runs to succeed", async () => {
    const id = "prd-writer";
    const wf = byId(id);
    const profile = profileOf(wf);
    const golden = loadGoldens().goldens[id];
    const fingerprint = workflowFingerprint(wf, profile, golden.datasetVersion);
    const outcome = (status: string) => ({ status, reason: status === "failed" ? "model error" : null, output: null, markdown: null, criticalFailures: [], proposals: 0, sources: 0, durationMs: 1000, usage: { inputTokens: 1, outputTokens: 1, modelCalls: 1, webSearches: 0 }, provider: "openai", model: "gpt-6.1-sol", costUsd: null, toolVersions: [], outputId: "o" });
    for (const st of ["succeeded", "succeeded", "failed"]) recordLiveExecution(db, startQualityRun(db, "live"), { wf, profile, fingerprint, golden }, "typical", outcome(st));
    const s = (await catalogReadiness(db, { ids: [id] })).workflows[0].scorecard;
    expect(s.criteria.find((c) => c.id === "live_execution")!.status).toBe("failed");
    expect(s.criteria.find((c) => c.id === "live_reliability")!.status).toBe("failed");
    // No verified price: the cost check falls back to the token budget, and says so.
    expect(s.criteria.find((c) => c.id === "live_latency_cost")!.evidence!.detail).toMatch(/no verified price/);
  });

  it("never records provider verification for actions run through a substituted (mocked) transport", async () => {
    const { approveAndExecute } = await import("@/lib/server/action-service");
    const { insertProposals } = await import("@/lib/server/db/actions");
    const { createRun } = await import("@/lib/server/db/runs");
    const { createPackage } = await import("@/lib/server/db/packages");
    const { expandSelection } = await import("@/lib/packages/resolve");
    const { proposalsFrom } = await import("@/lib/runtime/executors/integration");
    const wf = byId("slack-communication-agent");
    const golden = loadGoldens().goldens[wf.id];
    const pkg = createPackage(db, { name: "P", goal: "", conversationId: null, members: expandSelection(catalog, [wf.id]) });
    const { workflowRunIds } = createRun(db, pkg, [{ workflowId: wf.id, version: wf.version, status: "succeeded" }]);
    const [actionId] = insertProposals(db, workflowRunIds[0], proposalsFrom(wf, golden.scenarios[0].mock!.replies[0]));
    const a = (await import("@/lib/server/db/actions")).getAction(db, actionId)!;
    const provider = cannedProvider(golden.scenarios[0].mock!.http!);
    const done = await approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: { SLACK_BOT_TOKEN: "xoxb-test", WORKFLOWS_ACTIONS: "live" }, transport: provider.transport });
    expect(done.status).toBe("succeeded");
    await new Promise((r) => setTimeout(r, 50));
    expect(listEvidence(db, [wf.id]).filter((e) => e.criterion === "provider_live")).toEqual([]);
  });

  it("refuses live runs that aren't safe or can't run, before spending anything", () => {
    const wf = byId("crm-contact-manager");
    const golden = loadGoldens().goldens[wf.id];
    const t = { wf, profile: profileOf(wf), golden, fingerprint: workflowFingerprint(wf, profileOf(wf), golden.datasetVersion) };
    expect(liveProblems(t, "known-bad", { ANTHROPIC_API_KEY: "sk-ant-x" }).join(" ")).toMatch(/not marked safe for live runs/);
    expect(liveProblems(t, "typical", {}).join(" ")).toMatch(/no model key/);
    expect(liveProblems(t, "typical", { ANTHROPIC_API_KEY: "sk-ant-x" }).join(" ")).toMatch(/HUBSPOT_ACCESS_TOKEN/);
  });

  it("reports the full catalog honestly: nothing is production-ready without live and human evidence", async () => {
    const readiness = await catalogReadiness(db);
    expect(readiness.workflows).toHaveLength(100);
    const levels = readiness.workflows.map((w) => w.scorecard.level);
    expect(levels.filter((l) => l >= 2)).toEqual([]);
    expect(readiness.workflows.filter((w) => !w.profile.executable).every((w) => w.scorecard.level === 0)).toBe(true);
    const report = releaseReport(readiness, 3);
    expect([report.ok, report.checked, report.passing.length]).toEqual([false, 93, 0]);
  }, 60_000);
});
