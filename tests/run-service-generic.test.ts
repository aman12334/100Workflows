import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { expandSelection } from "@/lib/packages/resolve";
import { VERIFIED_PRICES } from "@/lib/runtime/pricing";
import { openDatabase, type DB } from "@/lib/server/db";
import { migrate, readMigrations } from "@/lib/server/db/migrate";
import { createPackage, getPackage, repinMember, saveInputs } from "@/lib/server/db/packages";
import { createRun, getRun } from "@/lib/server/db/runs";
import { buildView } from "@/lib/server/package-service";
import { executeRun, preflight, startRun } from "@/lib/server/run-service";
import { buildFixture } from "./fixtures/generic";
import { json, review, routedModel } from "./runtime-helpers";

/**
 * The three schema-v2 pilots run end to end through the real run orchestration
 * (preflight, startRun / executeRun, executor resolution, the engine, the database).
 * Every model response is scripted: no network, no API key, no real model call.
 * The fake model reports 100 input and 50 output tokens per call.
 */

const ANTHROPIC = { ANTHROPIC_API_KEY: "sk-ant-test" };
const OPENAI = { OPENAI_API_KEY: "sk-test" };
// claude-opus-5-5 at $4 / $20 per million tokens: 100 in + 50 out.
const PER_CALL_USD = (100 * 4 + 50 * 20) / 1_000_000;

const question = (text: string) => ({ text, format: "scale", options: ["1", "2", "3", "4", "5"], rationale: "Answers the research question.", analysis: "Compare means by segment." });
const goodSurvey = {
  questions: [question("How often do you use the product each week?"), question("How easy was it to set up your first project?"), question("How likely are you to keep using it after the trial?")],
  analysis_plan: "Compare answers between active and inactive trial users.",
};
const longSurvey = { ...goodSurvey, questions: Array.from({ length: 8 }, (_, i) => question(`Question number ${i + 1} about the trial?`)) };

const goodSop = {
  purpose: "Close the books every month.",
  scope: "Month-end only.",
  roles: ["Finance lead"],
  steps: [
    { action: "Export invoices from the billing tool", owner: "Finance lead", check: "Invoice count matches the billing tool" },
    { action: "Reconcile invoices with contracts", owner: "Account manager", check: "No unmatched invoices remain" },
  ],
  failure_modes: [{ failure: "Late exports", prevention: "Calendar reminder" }],
  assumptions: ["The account manager owns reconciliation."],
};
const ownerlessSop = { ...goodSop, steps: [{ action: "Export invoices", owner: "", check: "Count matches" }] };

const NOTES = "Booked after reading our post on month-end close; mentioned spreadsheets.";
const goodBrief = {
  prospect_summary: "Dana Lee is COO at Brightline Agency.",
  facts: [{ statement: "They use spreadsheets today.", evidence: "mentioned spreadsheets" }],
  hypotheses: [
    { id: "H1", statement: "Month-end close takes too long.", basis: "They read the month-end post." },
    { id: "H2", statement: "Agencies like them dislike manual reconciliation.", basis: "ICP pains." },
  ],
  questions: [
    { text: "Walk me through your last month-end close.", tests: ["H1"] },
    { text: "What happens when invoices don't match?", tests: ["H2"] },
  ],
  qualification_criteria: [{ criterion: "Owns the close process", listen_for: "Dana makes the call" }],
  next_steps: ["Agree a follow-up with the finance lead."],
};
const inventedFact = { ...goodBrief, facts: [{ statement: "They have 3 accountants.", evidence: "We have three accountants on staff" }] };

const ICP = {
  summary: "s",
  segments: [{ name: "Agencies", rationale: "r" }],
  firmographics: { industries: ["Agencies"], company_size: "10-50", geography: "US", revenue_range: "$1M-$10M" },
  buying_triggers: ["t"],
  pains: ["Manual reconciliation eats the first week of every month"],
  disqualifiers: ["a", "b"],
  personas: [
    { role: "Founder", type: "economic_buyer", goals: ["g"], objections: ["o"] },
    { role: "Ops", type: "champion", goals: ["g"], objections: ["o"] },
  ],
  evidence: [{ statement: "Agencies reconcile by hand", source_ids: ["input"] }],
};

const INPUTS = {
  company_name: "Acme",
  product_description: "AI bookkeeping for agencies",
  target_market: "US agencies",
  research_question: "Why do trial users churn?",
  "survey-designer.audience": "Trial users",
  "survey-designer.max_questions": 5,
  "sop-writer.process_description": "Every month-end, Priya exports invoices from the billing tool and checks them against the contracts sheet.",
  "discovery-call-prep.prospect": "Dana Lee, COO at Brightline Agency (35 people)",
  "discovery-call-prep.prospect_notes": NOTES,
};

let db: DB;
let catalog: Workflow[];
beforeAll(async () => {
  catalog = (await loadCatalog()).workflows;
});
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});

function makePackage(ids: string[], inputs: Record<string, unknown> = INPUTS, from: Workflow[] = catalog) {
  const id = createPackage(db, { name: "P", goal: "", conversationId: null, members: expandSelection(from, ids) });
  saveInputs(db, id, inputs, []);
  return buildView(getPackage(db, id)!, catalog);
}

async function runPackage(ids: string[], routes: Parameters<typeof routedModel>[0], env: Record<string, string> = ANTHROPIC) {
  const view = makePackage(ids);
  const model = routedModel(routes);
  const runId = startRun(db, view, { createMessage: model.createMessage, env });
  await waitFor(() => getRun(db, runId)!.status !== "running");
  return { run: getRun(db, runId)!, model, view };
}

const writes = (model: ReturnType<typeof routedModel>) => model.calls.filter((c) => c.route === "write");

describe("pilot workflows are runnable on the generic executor", () => {
  it("preflight marks all three ready, with no hand-written executor involved", () => {
    const p = preflight(makePackage(["survey-designer", "sop-writer", "discovery-call-prep"]), ANTHROPIC);
    expect(p.canRun).toBe(true);
    // Independent workflows run in a stable (alphabetical) order.
    expect(p.items.map((i) => [i.workflowId, i.version, i.state])).toEqual([
      ["discovery-call-prep", "0.2.0", "ready"],
      ["sop-writer", "0.2.0", "ready"],
      ["survey-designer", "0.2.0", "ready"],
    ]);
  });
});

describe("Survey Designer through run-service", () => {
  it("succeeds: draft, bias review, then checks; every rule passes", async () => {
    const { run, model } = await runPackage(["survey-designer"], { write: [json(goodSurvey)] });
    expect(run.status).toBe("completed");
    const wr = run.workflows[0];
    expect([wr.status, wr.attempts, wr.qualityScore]).toEqual(["succeeded", 1, 1]);
    expect(wr.steps.map((s) => [s.stepId, s.kind, s.status])).toEqual([
      ["draft", "agent", "done"],
      ["bias_review", "agent", "done"],
      ["check_survey", "check", "done"],
    ]);
    expect(wr.evaluations[0].criteria.map((c) => [c.id, c.passed])).toEqual([
      ["schema_valid", true],
      ["within_limit", true],
      ["analysis_mapped", true],
      ["no_repeats", true],
      ["short_questions", true],
    ]);
    expect(wr.markdown).toContain("## Questions");
    expect(wr.markdown).toContain("How often do you use the product each week?");
    // The revise step sees the draft; both requests carry the definition's system prompt and guardrails.
    expect(writes(model)).toHaveLength(2);
    expect(JSON.stringify(writes(model)[1].params.messages)).toContain("<draft>");
    expect(String(writes(model)[0].params.system)).toContain("survey methodologist");
  });

  it("retries after the user's question limit is exceeded, with the failure fed back", async () => {
    const { run, model } = await runPackage(["survey-designer"], { write: [json(longSurvey), json(longSurvey), json(goodSurvey)] });
    const wr = run.workflows[0];
    expect([wr.status, wr.attempts]).toEqual(["succeeded", 2]);
    expect(wr.evaluations.map((e) => e.decision)).toEqual(["retry", "accept"]);
    expect(wr.evaluations[0].criticalFailures).toEqual(["within_limit"]);
    expect(wr.evaluations[0].criteria.find((c) => c.id === "within_limit")?.detail).toMatch(/at most 5 \(your max_questions setting\)/);
    const retryPrompt = JSON.stringify(writes(model)[2].params.messages);
    expect(retryPrompt).toContain("previous_attempt_feedback");
    expect(retryPrompt).toContain("8 items in questions; must be at most 5 (your max_questions setting)");
  });

  it("needs review when every attempt breaks a critical rule", async () => {
    const { run } = await runPackage(["survey-designer"], { write: [json(longSurvey)] });
    const wr = run.workflows[0];
    expect([wr.status, wr.attempts]).toEqual(["needs_review", 2]);
    expect(run.status).toBe("completed");
    expect(wr.usage?.modelCalls).toBe(4);
  });
});

describe("SOP Writer through run-service", () => {
  it("succeeds with a model review of the assumptions", async () => {
    const { run, model } = await runPackage(["sop-writer"], { write: [json(goodSop)], review: [review(5)] });
    const wr = run.workflows[0];
    expect([wr.status, wr.attempts]).toEqual(["succeeded", 1]);
    expect(model.calls.map((c) => c.route)).toEqual(["write", "review"]);
    expect(wr.evaluations[0].criteria.find((c) => c.id === "assumptions_listed")).toMatchObject({ passed: true });
    expect(wr.markdown).toContain("## Procedure");
    expect(writes(model)[0].params.max_tokens).toBe(6000);
  });

  it("skips the paid model review when a critical rule already failed, and ends as needs review", async () => {
    const { run, model } = await runPackage(["sop-writer"], { write: [json(ownerlessSop)], review: [review(5)] });
    const wr = run.workflows[0];
    expect(wr.status).toBe("needs_review");
    expect(model.calls.filter((c) => c.route === "review")).toHaveLength(0);
    expect(wr.evaluations.every((e) => e.criticalFailures.includes("owners_assigned"))).toBe(true);
  });
});

describe("Discovery Call Prep through run-service", () => {
  it("runs after ICP Builder and receives its accepted output as upstream data", async () => {
    const { run, model } = await runPackage(["icp-builder", "discovery-call-prep"], { write: [json(ICP), json(goodBrief)], review: [review(4)] });
    expect(run.workflows.map((w) => [w.workflowId, w.status])).toEqual([
      ["icp-builder", "succeeded"],
      ["discovery-call-prep", "succeeded"],
    ]);
    const prompt = JSON.stringify(writes(model).at(-1)!.params.messages);
    expect(prompt).toContain("<upstream");
    expect(prompt).toContain("Manual reconciliation eats the first week of every month");
    expect(prompt).toContain("Dana Lee, COO at Brightline Agency");
    const criteria = run.workflows[1].evaluations[0].criteria;
    expect(criteria.map((c) => [c.id, c.passed])).toEqual([
      ["schema_valid", true],
      ["hypotheses_labelled", true],
      ["questions_mapped", true],
      ["distinct_hypotheses", true],
    ]);
  });

  it("runs without the optional ICP, and never accepts a 'fact' that isn't in the notes", async () => {
    const { run, model } = await runPackage(["discovery-call-prep"], { write: [json(inventedFact)] });
    const wr = run.workflows[0];
    expect(run.workflows).toHaveLength(1);
    expect(JSON.stringify(writes(model)[0].params.messages)).not.toContain("<upstream");
    expect(wr.status).toBe("needs_review");
    expect(wr.evaluations[0].criteria.find((c) => c.id === "hypotheses_labelled")?.detail).toMatch(/not in your prospect or prospect_notes/);
  });
});

describe("pinned versions", () => {
  const snapshot = (file: string) => JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "v1-snapshots", file), "utf8"));

  it("keeps a package pinned to the old v1 definition as definition-only until the user updates it", async () => {
    const old = await buildFixture(snapshot("survey-designer.json"));
    expect([old.version, old.status]).toEqual(["0.1.1", "planned"]);
    const view = makePackage(["survey-designer"], INPUTS, [...catalog.filter((w) => w.id !== old.id), old]);
    expect(view.steps[0].member.workflow.version).toBe("0.1.1");
    expect(preflight(view, ANTHROPIC).items[0]).toMatchObject({ state: "skip", reason: "Definition only. This workflow can't be executed yet." });

    repinMember(db, view.pkg.id, catalog.find((w) => w.id === "survey-designer")!);
    const updated = buildView(getPackage(db, view.pkg.id)!, catalog);
    expect(updated.steps[0].member.workflow.version).toBe("0.2.0");
    expect(preflight(updated, ANTHROPIC).items[0].state).toBe("ready");
  });

  it("runs a pinned v2 snapshot with the configuration it was pinned with, not the catalog's", async () => {
    const current = catalog.find((w) => w.id === "survey-designer")!;
    const pinned: Workflow = { ...current, version: "0.2.1", execution: { ...current.execution!, system: "Pinned system prompt for this package." } };
    const id = createPackage(db, { name: "P", goal: "", conversationId: null, members: [{ workflow: pinned, addedAs: "selected" }] });
    saveInputs(db, id, INPUTS, []);
    const model = routedModel({ write: [json(goodSurvey)] });
    const runId = startRun(db, buildView(getPackage(db, id)!, catalog), { createMessage: model.createMessage, env: ANTHROPIC });
    await waitFor(() => getRun(db, runId)!.status !== "running");
    expect(getRun(db, runId)!.workflows[0]).toMatchObject({ version: "0.2.1", status: "succeeded" });
    expect(String(writes(model)[0].params.system)).toContain("Pinned system prompt for this package.");
  });

  it("explains, instead of crashing, when a pinned snapshot relies on a rule this runtime doesn't have", () => {
    const current = catalog.find((w) => w.id === "survey-designer")!;
    const criteria = current.evaluation.criteria.map((c) => (c.id === "no_repeats" ? { ...c, rule: { id: "retired_rule", params: {} } } : c));
    const pinned: Workflow = { ...current, evaluation: { ...current.evaluation, criteria } };
    const id = createPackage(db, { name: "P", goal: "", conversationId: null, members: [{ workflow: pinned, addedAs: "selected" }] });
    saveInputs(db, id, INPUTS, []);
    const item = preflight(buildView(getPackage(db, id)!, catalog), ANTHROPIC).items[0];
    expect(item.state).toBe("skip");
    expect(item.reason).toMatch(/^This pinned definition can no longer run: criterion "no_repeats": unknown rule "retired_rule".*Update the workflow to run it\.$/);
  });
});

describe("cancellation", () => {
  it("stops after the current call, keeps finished work, and never starts the next workflow", async () => {
    const view = makePackage(["survey-designer", "sop-writer"]); // runs sop-writer first
    const { runId, workflowRunIds } = createRun(
      db,
      view.pkg.id,
      view.steps.map((s) => ({ workflowId: s.member.workflow.id, version: s.member.workflow.version, status: "pending" as const })),
    );
    const controller = new AbortController();
    const scripted = routedModel({ write: [json(goodSop)] });
    const createMessage: typeof scripted.createMessage = async (params, options) => {
      const reply = await scripted.createMessage(params, options);
      controller.abort(); // the user presses Cancel while the first call is in flight
      return reply;
    };
    await executeRun(db, view, runId, workflowRunIds, controller.signal, createMessage, "claude-opus-5-5");
    const result = getRun(db, runId)!;
    expect(result.status).toBe("cancelled");
    expect(result.workflows.map((w) => [w.workflowId, w.status])).toEqual([
      ["sop-writer", "cancelled"],
      ["survey-designer", "cancelled"],
    ]);
    // The call that was in flight finishes and is recorded; nothing after it starts.
    expect(result.workflows[0].steps[0]).toMatchObject({ stepId: "draft", status: "done" });
    expect(result.workflows[0].usage?.modelCalls).toBe(1);
    expect(result.workflows[0].markdown).toBeNull();
    expect(result.workflows[1].statusReason).toBe("The run was cancelled before this workflow started.");
    expect(scripted.calls).toHaveLength(1);
  });
});

describe("observability", () => {
  it("records step durations, token usage and a verified cost estimate for an Anthropic run", async () => {
    const { run } = await runPackage(["survey-designer", "sop-writer"], { write: [json(goodSop), json(goodSurvey)], review: [review(5)] });
    expect([run.provider, run.model]).toEqual(["anthropic", "claude-opus-5-5"]);
    expect(run.pricing).toEqual(VERIFIED_PRICES["claude-opus-5-5"]);

    for (const wr of run.workflows) {
      expect(wr.durationMs).toBeGreaterThanOrEqual(0);
      for (const s of wr.steps) expect(s.durationMs, s.stepId).toBeGreaterThanOrEqual(0);
    }
    const [sop, survey] = run.workflows;
    expect([sop.workflowId, sop.status, survey.workflowId, survey.status]).toEqual(["sop-writer", "succeeded", "survey-designer", "succeeded"]);
    expect(survey.steps.map((s) => [s.stepId, s.usage?.modelCalls ?? 0, s.costUsd])).toEqual([
      ["draft", 1, PER_CALL_USD],
      ["bias_review", 1, PER_CALL_USD],
      ["check_survey", 0, survey.steps[2].usage ? 0 : null],
    ]);
    expect(survey.costUsd).toBeCloseTo(2 * PER_CALL_USD, 10);
    expect(sop.costUsd).toBeCloseTo(2 * PER_CALL_USD, 10);

    expect(run.summary.usage).toEqual({ inputTokens: 400, outputTokens: 200, modelCalls: 4, webSearches: 0 });
    expect(run.summary.costUsd).toBeCloseTo(4 * PER_CALL_USD, 10);
    expect(run.summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.summary.costNote).toMatch(/^Estimate from token counts at list price\. Excludes web search charges/);
  });

  it("tracks usage but does not estimate cost for a model without a verified price (OpenAI)", async () => {
    const { run } = await runPackage(["survey-designer"], { write: [json(goodSurvey)] }, OPENAI);
    expect([run.provider, run.model, run.pricing]).toEqual(["openai", "gpt-6.1-sol", null]);
    expect(run.summary.usage.modelCalls).toBe(2);
    expect(run.summary.costUsd).toBeNull();
    expect(run.summary.costNote).toBe("Cost not estimated: no verified price for gpt-6.1-sol.");
    expect(run.workflows[0].costUsd).toBeNull();
    expect(run.workflows[0].steps.every((s) => s.costUsd === null)).toBe(true);
  });

  it("reads runs recorded before migration 004 without inventing provider, model or cost", () => {
    const old = openDatabase(":memory:");
    const migrations = readMigrations();
    migrate(old, migrations.filter((m) => m.id < "004"));
    old.prepare("INSERT INTO packages (id, name, goal, created_at, updated_at) VALUES ('p', 'P', '', 'x', 'x')").run();
    old.prepare("INSERT INTO runs (id, package_id, status, created_at, started_at, finished_at) VALUES ('r', 'p', 'completed', 't', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z')").run();
    old.prepare("INSERT INTO workflow_runs (id, run_id, workflow_id, version, position, status, usage_json) VALUES ('w', 'r', 'icp-builder', '0.2.0', 1, 'succeeded', ?)").run(
      JSON.stringify({ inputTokens: 10, outputTokens: 5, modelCalls: 1, webSearches: 0 }),
    );
    expect(migrate(old)).toEqual(migrations.filter((m) => m.id >= "004").map((m) => m.id));

    const r = getRun(old, "r")!;
    expect([r.provider, r.model, r.pricing]).toEqual([null, null, null]);
    expect(r.summary).toEqual({
      usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1, webSearches: 0 },
      durationMs: 2000,
      costUsd: null,
      costNote: "Cost not estimated: this run was recorded before cost tracking.",
    });
  });
});

async function waitFor(cond: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
