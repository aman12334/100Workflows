import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@/lib/catalog/catalog";
import { loadCatalog } from "@/lib/catalog/load";
import { entry, workflowData } from "./fixtures";

describe("shipped catalog", () => {
  it("loads every definition in catalog/workflows without errors", async () => {
    const catalog = await loadCatalog(path.join(process.cwd(), "catalog", "workflows"));
    expect(catalog.errors).toEqual([]);
    expect(catalog.workflows.length).toBeGreaterThanOrEqual(8);
    const categories = new Set(catalog.workflows.map((w) => w.category));
    for (const c of ["gtm", "marketing", "finance", "user-research"]) expect(categories).toContain(c);
  });

  it("marks a workflow available only when the runtime has an executor for that exact version", async () => {
    // resolveExecutor covers both hand-written executors and schema-v2 generic definitions.
    const { resolveExecutor, implementsVersion } = await import("@/lib/runtime/executors");
    const catalog = await loadCatalog();
    for (const wf of catalog.workflows) {
      const executor = resolveExecutor(wf);
      const implemented = Boolean(executor && implementsVersion(executor, wf.version));
      expect(implemented, `${wf.id}@${wf.version} is ${wf.status}`).toBe(wf.status === "available");
    }
    const available = catalog.workflows.filter((w) => w.status === "available");
    // The two hand-written workflows and the three Phase 0 pilots, plus every Phase 1 schema-v2 workflow.
    expect(available.map((w) => w.id)).toEqual(expect.arrayContaining(["discovery-call-prep", "icp-builder", "market-research", "sop-writer", "survey-designer"]));
    for (const wf of available) if (!["icp-builder", "market-research"].includes(wf.id)) expect(wf.schemaVersion, wf.id).toBe(2);
  });

  it("executors only use steps and criteria their definitions declare", async () => {
    const { EXECUTORS } = await import("@/lib/runtime/executors");
    const catalog = await loadCatalog();
    for (const id of Object.keys(EXECUTORS)) {
      const wf = catalog.workflows.find((w) => w.id === id)!;
      expect(wf.evaluation.criteria.map((c) => c.id)).toContain("schema_valid");
    }
  });

  it("reports a missing catalog directory instead of throwing", async () => {
    const catalog = await loadCatalog("/definitely/not/here");
    expect(catalog.workflows).toEqual([]);
    expect(catalog.errors[0].message).toMatch(/cannot read catalog directory/);
  });
});

describe("workflow validation", () => {
  it("accepts a minimal valid definition and applies defaults", () => {
    const { workflows, errors } = buildCatalog([entry()]);
    expect(errors).toEqual([]);
    expect(workflows[0].dependencies).toEqual([]);
    expect(workflows[0].inputs[0].shared).toBe(false);
  });

  it.each([
    ["bad id", { id: "Demo Flow" }, /kebab-case/],
    ["bad version", { version: "1.0" }, /semver/],
    ["unknown category", { category: "astrology" }, /category/],
    ["no inputs", { inputs: [] }, /inputs/],
    ["unknown field (typo)", { dependancies: [] }, /dependancies|Unrecognized/i],
    ["retry limit too high", { limits: { maxRetries: 10, timeoutSeconds: 60, maxModelCalls: 3 } }, /maxRetries/],
    ["threshold above 1", { evaluation: { criteria: [{ id: "x", description: "x", method: "rule" }], threshold: 2 } }, /threshold/],
  ])("rejects %s", (_name, overrides, pattern) => {
    const { workflows, errors } = buildCatalog([entry(overrides)]);
    expect(workflows).toEqual([]);
    expect(errors.map((e) => e.message).join("\n")).toMatch(pattern);
  });

  it("rejects select inputs without options", () => {
    const { errors } = buildCatalog([
      entry({ inputs: [{ key: "tone", label: "Tone", type: "select", required: false, description: "Tone." }] }),
    ]);
    expect(errors[0].message).toMatch(/at least one option/);
  });

  it("rejects steps that use tools the workflow did not declare", () => {
    const { errors } = buildCatalog([
      entry({ steps: [{ id: "s", name: "S", kind: "agent", responsibility: "r", tools: ["shell-exec"] }] }),
    ]);
    expect(errors[0].message).toMatch(/not declared/);
  });

  it("rejects duplicate input keys", () => {
    const input = { key: "goal", label: "Goal", type: "text", required: true, description: "d" };
    const { errors } = buildCatalog([entry({ inputs: [input, input] })]);
    expect(errors[0].message).toMatch(/duplicate inputs/);
  });

  it("rejects files whose name does not match the id", () => {
    const { errors } = buildCatalog([{ file: "other.json", data: workflowData() }]);
    expect(errors[0].message).toMatch(/expected "demo-flow.json"/);
  });

  it("rejects duplicate workflow ids", () => {
    const { workflows, errors } = buildCatalog([entry(), entry()]);
    expect(workflows).toHaveLength(1);
    expect(errors[0].message).toMatch(/duplicate workflow id/);
  });

  it("rejects self-dependencies", () => {
    const { errors } = buildCatalog([entry({ dependencies: [{ workflowId: "demo-flow", required: true, reason: "r" }] })]);
    expect(errors[0].message).toMatch(/depend on itself/);
  });
});

describe("catalog-level checks", () => {
  const dep = (workflowId: string) => ({ workflowId, required: true, reason: "needs it" });

  it("drops workflows with unknown dependencies, and anything that depended on them", () => {
    const { workflows, errors } = buildCatalog([
      entry({ id: "a", dependencies: [dep("ghost")] }),
      entry({ id: "b", dependencies: [dep("a")] }),
      entry({ id: "c" }),
    ]);
    expect(workflows.map((w) => w.id)).toEqual(["c"]);
    expect(errors.map((e) => e.message)).toEqual([
      'dependency "ghost" is not in the catalog',
      'dependency "a" is not in the catalog',
    ]);
  });

  it("detects dependency cycles", () => {
    const { workflows, errors } = buildCatalog([
      entry({ id: "a", dependencies: [dep("b")] }),
      entry({ id: "b", dependencies: [dep("a")] }),
      entry({ id: "c", dependencies: [dep("a")] }),
    ]);
    expect(errors.some((e) => /cycle/.test(e.message))).toBe(true);
    expect(workflows.map((w) => w.id)).not.toContain("a");
    expect(workflows.map((w) => w.id)).not.toContain("b");
  });
});
