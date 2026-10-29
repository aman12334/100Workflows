import { beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { expandSelection } from "@/lib/packages/resolve";
import { openDatabase, type DB } from "@/lib/server/db";
import { migrate } from "@/lib/server/db/migrate";
import { createPackage, getPackage, saveInputs } from "@/lib/server/db/packages";
import { createRun, getRun, listRuns, markInterrupted } from "@/lib/server/db/runs";
import { buildView } from "@/lib/server/package-service";
import { executeRun, preflight, startRun } from "@/lib/server/run-service";
import { goodReport, json, review, routedModel, searchResponse } from "./runtime-helpers";

const ENV = { ANTHROPIC_API_KEY: "sk-ant-test", WORKFLOWS_WEB_SEARCH: "on" };
const RESULTS = [
  { url: "https://analyst.example.com/report", title: "Analyst report" },
  { url: "https://news.example.org/story", title: "News story" },
];
const CITED = [{ url: "https://analyst.example.com/report", text: "The market grew 20% in 2025." }];
const ICP = {
  summary: "s",
  segments: [{ name: "Agencies", rationale: "r" }],
  firmographics: { industries: ["Agencies"], company_size: "10-50", geography: "US", revenue_range: "$1M-$10M" },
  buying_triggers: ["t"],
  pains: ["p"],
  disqualifiers: ["a", "b"],
  personas: [
    { role: "Founder", type: "economic_buyer", goals: ["g"], objections: ["o"] },
    { role: "Ops", type: "champion", goals: ["g"], objections: ["o"] },
  ],
  evidence: [{ statement: "Market grew", source_ids: ["S1"] }],
};

let db: DB;
let catalog: Workflow[];
beforeEach(async () => {
  db = openDatabase(":memory:");
  migrate(db);
  catalog = (await loadCatalog()).workflows;
});

function makePackage(ids: string[], inputs: Record<string, unknown> = {}) {
  const id = createPackage(db, { name: "P", goal: "", conversationId: null, members: expandSelection(catalog, ids) });
  saveInputs(db, id, inputs, []);
  return buildView(getPackage(db, id)!, catalog);
}

const FILLED = {
  company_name: "Acme",
  product_description: "AI bookkeeping",
  target_market: "US agencies",
  "market-research.research_objective": "How big is the market?",
};

describe("preflight", () => {
  it("reports missing inputs and keeps the run button off", () => {
    const p = preflight(makePackage(["market-research", "icp-builder"]), ENV);
    expect(p.canRun).toBe(false);
    expect(p.summary).toMatch(/required input/);
    expect(p.items.map((i) => i.state)).toEqual(["needs_input", "needs_input"]);
  });

  it("skips definition-only workflows and blocks what requires them", () => {
    const p = preflight(makePackage(["outbound-sequence"], FILLED), ENV);
    expect(Object.fromEntries(p.items.map((i) => [i.workflowId, i.state]))).toEqual({ "icp-builder": "ready", "outbound-sequence": "skip" });
  });

  it("skips market research when web search is off, but still runs ICP", () => {
    const p = preflight(makePackage(["market-research", "icp-builder"], FILLED), { ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(p.items.find((i) => i.workflowId === "market-research")?.state).toBe("skip");
    expect(p.canRun).toBe(true);
  });

  it("won't run without a model key", () => {
    expect(preflight(makePackage(["icp-builder"], FILLED), {}).canRun).toBe(false);
  });
});

describe("package run", () => {
  it("runs workflows in dependency order and hands accepted research to ICP", async () => {
    const view = makePackage(["market-research", "icp-builder"], FILLED);
    const model = routedModel({ search: [searchResponse(RESULTS, CITED)], write: [json(goodReport), json(ICP)], review: [review(4)] });
    const runId = startRun(db, view, { createMessage: model.createMessage, env: ENV });

    expect(() => startRun(db, view, { createMessage: model.createMessage, env: ENV })).toThrow(/already running/);
    await waitFor(() => getRun(db, runId)!.status !== "running");

    const run = getRun(db, runId)!;
    expect(run.status).toBe("completed");
    expect(run.workflows.map((w) => [w.workflowId, w.status])).toEqual([
      ["market-research", "succeeded"],
      ["icp-builder", "succeeded"],
    ]);
    const icpPrompt = JSON.stringify(model.calls.filter((c) => c.route === "write")[1].params.messages);
    expect(icpPrompt).toContain("Market grew 20% in 2025");
    expect(run.workflows[0].steps.map((s) => s.stepId)).toEqual(["gather", "write_report", "verify_sources", "review"]);
    expect(run.workflows[0].evaluations).toHaveLength(1);
    expect(run.workflows[0].confidence?.basis.length).toBeGreaterThan(0);
    expect(listRuns(db)[0].counts).toEqual({ succeeded: 2 });
  });

  it("does not pass research that needs review to the next workflow", async () => {
    const view = makePackage(["market-research", "icp-builder"], FILLED);
    const bad = { ...goodReport, findings: [{ claim: "x", source_ids: ["S9"] }, ...goodReport.findings] };
    const model = routedModel({ search: [searchResponse(RESULTS, CITED)], write: [json(bad), json(bad), json(bad), json({ ...ICP, evidence: [{ statement: "s", source_ids: ["input"] }] })], review: [review(4)] });
    const { runId, workflowRunIds } = createRun(db, view.pkg.id, [
      { workflowId: "market-research", version: "0.2.0", status: "pending" },
      { workflowId: "icp-builder", version: "0.2.0", status: "pending" },
    ]);
    await executeRun(db, view, runId, workflowRunIds, new AbortController().signal, model.createMessage, "m");
    const run = getRun(db, runId)!;
    expect(run.workflows.map((w) => w.status)).toEqual(["needs_review", "succeeded"]);
    expect(JSON.stringify(model.calls.at(-2)?.params.messages)).toContain("No market research is available");
  });

  it("marks runs left running by a stopped server as interrupted", () => {
    const view = makePackage(["icp-builder"], FILLED);
    const { runId } = createRun(db, view.pkg.id, [{ workflowId: "icp-builder", version: "0.2.0", status: "pending" }]);
    expect(markInterrupted(db)).toBe(1);
    expect(getRun(db, runId)!.workflows[0].status).toBe("interrupted");
  });
});

async function waitFor(cond: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
