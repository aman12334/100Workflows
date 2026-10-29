import { beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "@/lib/catalog/catalog";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { PackageError, executionOrder, expandSelection, pinStatus, removeMember, summarizeRequirements } from "@/lib/packages/resolve";
import { entry } from "./fixtures";

let catalog: Workflow[];
beforeAll(async () => {
  catalog = (await loadCatalog()).workflows;
});

const ids = (members: Array<{ workflow: Workflow }>) => members.map((m) => m.workflow.id);

describe("expandSelection", () => {
  it("adds required dependencies transitively and marks them", () => {
    const members = expandSelection(catalog, ["outbound-sequence"]);
    expect(Object.fromEntries(members.map((m) => [m.workflow.id, m.addedAs]))).toEqual({
      "outbound-sequence": "selected",
      "icp-builder": "dependency",
    });
  });

  it("does not add optional dependencies", () => {
    expect(ids(expandSelection(catalog, ["icp-builder"]))).toEqual(["icp-builder"]);
  });

  it("upgrades a dependency to selected when the user picks it explicitly", () => {
    const first = expandSelection(catalog, ["outbound-sequence"]);
    const next = expandSelection(catalog, ["icp-builder"], first);
    expect(next.find((m) => m.workflow.id === "icp-builder")?.addedAs).toBe("selected");
  });

  it("refuses unknown workflow ids instead of dropping them", () => {
    expect(() => expandSelection(catalog, ["icp-builder", "made-up"])).toThrow(PackageError);
  });
});

describe("removeMember", () => {
  it("blocks removing a workflow that another member requires", () => {
    const members = expandSelection(catalog, ["outbound-sequence"]);
    expect(() => removeMember(members, "icp-builder")).toThrow(/Cold Outbound Sequence Writer needs it/);
  });

  it("prunes dependencies nothing needs any more, but keeps user-picked ones", () => {
    const members = expandSelection(catalog, ["outbound-sequence", "content-calendar"]);
    expect(ids(removeMember(members, "outbound-sequence")).sort()).toEqual(["content-calendar", "icp-builder"]);
    expect(ids(removeMember(removeMember(members, "outbound-sequence"), "content-calendar"))).toEqual([]);

    const picked = expandSelection(catalog, ["icp-builder", "outbound-sequence"]);
    expect(ids(removeMember(picked, "outbound-sequence"))).toEqual(["icp-builder"]);
  });
});

describe("executionOrder", () => {
  it("puts dependencies first, including optional ones that are in the package", () => {
    const order = ids(executionOrder(expandSelection(catalog, ["outbound-sequence", "market-research", "content-calendar"])));
    expect(order.indexOf("market-research")).toBeLessThan(order.indexOf("icp-builder"));
    expect(order.indexOf("icp-builder")).toBeLessThan(order.indexOf("outbound-sequence"));
    expect(order.indexOf("icp-builder")).toBeLessThan(order.indexOf("content-calendar"));
  });
});

describe("summarizeRequirements", () => {
  it("asks shared business context once and lists who uses it", () => {
    const req = summarizeRequirements(expandSelection(catalog, ["outbound-sequence", "competitor-teardown"]), catalog);
    const company = req.shared.find((s) => s.field.key === "company_name")!;
    expect(company.required).toBe(true);
    expect(company.usedBy.sort()).toEqual(["competitor-teardown", "icp-builder", "outbound-sequence"]);
    const perWorkflowKeys = req.perWorkflow.flatMap((p) => p.fields.map((f) => f.key));
    expect(perWorkflowKeys).not.toContain("company_name");
    expect(perWorkflowKeys).toContain("competitor_urls");
  });

  it("collects tools and suggests optional dependencies not yet included", () => {
    const req = summarizeRequirements(expandSelection(catalog, ["competitor-teardown"]), catalog);
    expect(req.tools).toEqual([{ id: "web-fetch", required: true, usedBy: ["competitor-teardown"] }]);
    expect(req.suggestions.map((s) => s.workflowId)).toEqual(["market-research"]);
  });

  it("reports conflicting input types instead of merging them", () => {
    const field = (type: string) => ({ key: "budget", label: "Budget", type, required: true, description: "d", shared: true });
    const { workflows } = buildCatalog([entry({ id: "a-flow", inputs: [field("number")] }), entry({ id: "b-flow", inputs: [field("text")] })]);
    const req = summarizeRequirements(expandSelection(workflows, ["a-flow", "b-flow"]), workflows);
    expect(req.conflicts[0]).toMatch(/budget/);
    expect(req.shared).toEqual([]);
    expect(req.perWorkflow).toHaveLength(2);
  });
});

describe("pinStatus", () => {
  const wf = { version: "0.1.0" } as Workflow;
  it("distinguishes current, new version, silent change and removal", () => {
    expect(pinStatus("h", "0.1.0", wf, () => "h")).toEqual({ kind: "current" });
    expect(pinStatus("h", "0.1.0", { version: "0.2.0" } as Workflow, () => "x")).toEqual({ kind: "update_available", latestVersion: "0.2.0" });
    expect(pinStatus("h", "0.1.0", wf, () => "x")).toEqual({ kind: "changed_same_version" });
    expect(pinStatus("h", "0.1.0", undefined, () => "h")).toEqual({ kind: "removed" });
  });
});
