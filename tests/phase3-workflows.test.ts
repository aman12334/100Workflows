import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validateGenericDefinition } from "@/lib/catalog/catalog";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { storageKey } from "@/lib/packages/inputs";
import { expandSelection } from "@/lib/packages/resolve";
import { lookupCalculation } from "@/lib/runtime/calc/runner";
import { executeWorkflow } from "@/lib/runtime/engine";
import { resolveExecutor, runnability } from "@/lib/runtime/executors";
import { createGenericExecutor } from "@/lib/runtime/executors/generic";
import type { CreateMessage } from "@/lib/runtime/model";
import type { ToolCallRecord } from "@/lib/runtime/tools/runner";
import { openDatabase, type DB } from "@/lib/server/db";
import { migrate } from "@/lib/server/db/migrate";
import { createPackage, getPackage, saveInputs } from "@/lib/server/db/packages";
import { getRun } from "@/lib/server/db/runs";
import { buildView } from "@/lib/server/package-service";
import { startRun } from "@/lib/server/run-service";
import { json, memoryRecorder, routedModel } from "./runtime-helpers";

/**
 * Phase 3: every calculation workflow, driven by tests/fixtures/phase3/<id>.json:
 *   inputs     what the user typed
 *   extracted  the scripted extract-step reply (workflows that read tables from text)
 *   expected   calculated values worked out independently (by hand / Python), by path
 *   good       an explanation that uses only calculated numbers
 *   bad        an explanation that invents a number (fails the critical rule bad_fails)
 * Model replies are scripted: no API key, no network.
 */

interface Fixture {
  inputs: Record<string, unknown>;
  extracted?: Record<string, unknown>;
  expected: Record<string, unknown>;
  good: Record<string, unknown>;
  bad: Record<string, unknown>;
  bad_fails: string;
}

const DIR = path.join(process.cwd(), "tests", "fixtures", "phase3");
const IDS = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
const fixture = (id: string): Fixture => JSON.parse(readFileSync(path.join(DIR, `${id}.json`), "utf8"));
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test" };

let catalog: Workflow[];
const byId = (id: string) => catalog.find((w) => w.id === id)!;
beforeAll(async () => {
  catalog = (await loadCatalog()).workflows;
});

const at = (obj: unknown, p: string) => p.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
const isExtract = (wf: Workflow) => wf.steps.some((s) => s.mode === "extract");
const calcRef = (wf: Workflow) => wf.steps.find((s) => s.calculate)!.calculate!.calculation;

async function run(wf: Workflow, inputs: Record<string, unknown>, createMessage: CreateMessage, signal?: AbortSignal) {
  const { recorder, evaluations, steps } = memoryRecorder();
  const tools: ToolCallRecord[] = [];
  const r = await executeWorkflow({ workflow: wf, executor: createGenericExecutor(wf), inputs, upstream: {}, createMessage, model: "claude-opus-5-5", recorder: { ...recorder, tool: (c) => tools.push(c) }, env: ENV, signal });
  return { r, evaluations, steps, tools };
}
const scripted = (f: Fixture, wf: Workflow, explanations: unknown[]) => routedModel({ write: [...(isExtract(wf) ? [f.extracted] : []), ...explanations].map(json) });

describe("Phase 3 catalog", () => {
  it("adds exactly 13 calculation workflows: 90 in total before later phases, with every earlier workflow still present", () => {
    expect(IDS).toHaveLength(13);
    const later = readdirSync(path.join(process.cwd(), "tests", "fixtures", "phase4")).map((f) => f.slice(0, -5));
    expect(catalog).toHaveLength(90 + later.length);
    const earlier = ["phase1", "phase2"].flatMap((d) => readdirSync(path.join(process.cwd(), "tests", "fixtures", d)).map((f) => f.slice(0, -5)));
    expect(earlier).toHaveLength(65);
    for (const id of [...IDS, ...earlier]) expect(byId(id), id).toBeDefined();
    expect(catalog.filter((w) => !IDS.includes(w.id) && !earlier.includes(w.id) && !later.includes(w.id))).toHaveLength(12);
  });
});

describe.each(IDS)("%s", (id) => {
  let wf: Workflow;
  let f: Fixture;
  beforeAll(() => {
    wf = byId(id);
    f = fixture(id);
  });

  it("is a schema-v2 definition that runs a registered calculation, with a critical numbers check, on either provider", () => {
    expect([wf.schemaVersion, wf.execution?.engine, wf.status]).toEqual([2, "generic", "available"]);
    expect(validateGenericDefinition(wf)).toEqual([]);
    expect(lookupCalculation(calcRef(wf))).not.toBeNull();
    expect(wf.tools).toEqual([]);
    expect(wf.evaluation.criteria.filter((c) => c.critical && c.rule?.id === "numbers_from_calculation").length).toBeGreaterThan(0);
    expect(resolveExecutor(wf)?.workflowId).toBe(id);
    expect(runnability(wf, ENV)).toEqual({ runnable: true });
    expect(runnability(wf, { OPENAI_API_KEY: "sk-x" })).toEqual({ runnable: true });
  });

  it("calculates the independently expected values, keeps them with formulas and units, and accepts a faithful explanation", async () => {
    const m = scripted(f, wf, [f.good]);
    const { r, tools } = await run(wf, f.inputs, m.createMessage);
    expect([r.status, r.attempts]).toEqual(["succeeded", 1]);
    const out = r.result!.json as { calculation: { id: string; output: unknown; formulas: string[]; units: object; rounding: string }; explanation: unknown };
    for (const [p, v] of Object.entries(f.expected)) expect(at(out.calculation.output, p), p).toEqual(v);
    expect(out.calculation.id).toBe(calcRef(wf).split("@")[0]);
    expect(out.calculation.formulas.length).toBeGreaterThan(0);
    expect(out.explanation).toEqual(f.good);
    expect(r.result!.markdown).toContain("## Calculated results");
    expect(r.result!.markdown).toContain("## How this was calculated");
    expect(tools.filter((t) => t.toolId.startsWith("calculation:"))).toMatchObject([{ status: "ok", toolVersion: calcRef(wf).split("@")[1] }]);
    expect(r.usage.modelCalls).toBe(isExtract(wf) ? 2 : 1);
    // The explanation request carries the calculated results and the guardrails.
    const explain = m.calls.at(-1)!.params;
    expect(String((explain.messages[0] as { content: string }).content)).toContain("<calculation_results");
    expect(String(explain.system)).toContain("do not recalculate");
  });

  it("needs review when the explanation invents a number, keeping the calculated results", async () => {
    const { r, evaluations } = await run(wf, f.inputs, scripted(f, wf, [f.bad]).createMessage);
    expect(r.status).toBe("needs_review");
    for (const e of evaluations) expect(e.criticalFailures).toContain(f.bad_fails);
    const out = r.result!.json as { calculation: { output: unknown } };
    for (const [p, v] of Object.entries(f.expected)) expect(at(out.calculation.output, p), p).toEqual(v);
  });

  it("keeps the calculated results when the explanation model fails", async () => {
    let calls = 0;
    const createMessage: CreateMessage = async (params, opts) => {
      calls++;
      if (isExtract(wf) && calls === 1) return scripted(f, wf, []).createMessage(params, opts);
      throw new Error("model unavailable");
    };
    const { r } = await run(wf, f.inputs, createMessage);
    expect(r.status).toBe("needs_review");
    expect(r.reason).toMatch(/model unavailable.*calculated results are kept/);
    const out = r.result!.json as { calculation: { output: unknown }; explanation: unknown; explanation_error: string };
    expect(out.explanation).toBeNull();
    expect(out.explanation_error).toMatch(/model unavailable/);
    for (const [p, v] of Object.entries(f.expected)) expect(at(out.calculation.output, p), p).toEqual(v);
    expect(r.result!.markdown).toContain("No explanation");
  });

  it("keeps the calculated results when every explanation attempt is invalid, without repeating the calculation", async () => {
    const { r, tools } = await run(wf, f.inputs, scripted(f, wf, [{}]).createMessage);
    expect([r.status, r.attempts]).toEqual(["needs_review", 2]);
    expect((r.result!.json as { calculation: unknown }).calculation).toBeTruthy();
    expect(tools.filter((t) => t.toolId.startsWith("calculation:"))).toHaveLength(1);
  });

  it("stops before calculating when the run is cancelled", async () => {
    const c = new AbortController();
    c.abort();
    const { r, tools } = await run(wf, f.inputs, scripted(f, wf, [f.good]).createMessage, c.signal);
    expect(r.status).toBe("cancelled");
    expect(tools).toHaveLength(0);
  });

  it("refuses inputs it can't read reliably instead of guessing", async () => {
    if (isExtract(wf)) {
      // An extraction that invents a number is rejected; a correct second reading is accepted.
      const invented = { ...f.extracted!, _note: undefined } as Record<string, unknown>;
      const withFake = JSON.parse(JSON.stringify(invented).replace(/(\d+)(?=[,}\]])/, "987654"));
      const recover = routedModel({ write: [json(withFake), json(f.extracted), json(f.good)] });
      const ok = await run(wf, f.inputs, recover.createMessage);
      expect(ok.r.status).toBe("succeeded");
      expect(ok.steps.filter((s) => s.stepId === "read_data").map((s) => s.detail)).toEqual([expect.stringMatching(/not in your input/), "read your data into the calculation's input"]);
      const never = await run(wf, f.inputs, routedModel({ write: [json(withFake)] }).createMessage);
      expect(never.r.status).toBe("failed");
      expect(never.r.reason).toMatch(/couldn't be read reliably.*987654/);
    } else {
      const numberField = wf.inputs.find((i) => i.type === "number" && i.required)!.key;
      const { r } = await run(wf, { ...f.inputs, [numberField]: "about a thousand" }, scripted(f, wf, [f.good]).createMessage);
      expect(r.status).toBe("failed");
      expect(r.reason).toMatch(/couldn't be read as numbers/);
    }
  });
});

describe("Phase 3 workflows through run-service", () => {
  let db: DB;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
  });

  it.each(IDS)("%s runs end to end and stores the calculation, its log and the explanation", async (id) => {
    const wf = byId(id);
    const f = fixture(id);
    const pkg = createPackage(db, { name: "P", goal: "", conversationId: null, members: expandSelection(catalog, [id]) });
    const values: Record<string, unknown> = {};
    for (const input of wf.inputs) if (f.inputs[input.key] !== undefined) values[storageKey(input.shared ? null : id, input.key)] = f.inputs[input.key];
    saveInputs(db, pkg, values, []);
    const runId = startRun(db, buildView(getPackage(db, pkg)!, catalog), { createMessage: scripted(f, wf, [f.good]).createMessage, env: ENV });
    const start = Date.now();
    while (getRun(db, runId)!.status === "running" && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 5));
    const result = getRun(db, runId)!;
    const mine = result.workflows.find((w) => w.workflowId === id)!;
    expect([result.status, mine.status]).toEqual(["completed", "succeeded"]);
    const out = mine.output as { calculation: { output: unknown } };
    for (const [p, v] of Object.entries(f.expected)) expect(at(out.calculation.output, p), p).toEqual(v);
    expect(mine.toolCalls.map((c) => [c.toolId, c.status])).toEqual([[`calculation:${calcRef(wf).split("@")[0]}`, "ok"]]);
    expect(mine.steps.map((s) => s.stepId)).toContain("calculate");
  });
});
