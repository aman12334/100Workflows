import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCatalog, validateGenericDefinition, expandManifest, type Catalog, type Registry } from "@/lib/catalog/catalog";
import { loadCatalog, loadRegistry } from "@/lib/catalog/load";
import { stem } from "@/lib/catalog/search";
import { renderCatalogDocs } from "@/lib/catalog/tooling/docs";
import { GENERATED_SCHEMAS, renderSchema } from "@/lib/catalog/tooling/json-schemas";
import { lintCatalog } from "@/lib/catalog/tooling/lint";
import { definitionTemplate, validateScaffold } from "@/lib/catalog/tooling/scaffold";
import { SearchCasesSchema, runSearchCases } from "@/lib/catalog/tooling/search-cases";
import { EXECUTORS, implementsVersion } from "@/lib/runtime/executors";
import { entry, workflowData } from "./fixtures";

let catalog: Catalog;
let registry: Registry;
const cases = SearchCasesSchema.parse(JSON.parse(readFileSync(path.join(process.cwd(), "catalog", "search-cases.json"), "utf8")));

beforeAll(async () => {
  catalog = await loadCatalog();
  registry = (await loadRegistry()).registry;
});

describe("shared inputs", () => {
  it("expands { use } references with the shared definition and the workflow's required flag", () => {
    const { data, errors } = expandManifest(workflowData({ $schema: "x", inputs: [{ use: "company_name", required: false }] }), registry);
    expect(errors).toEqual([]);
    expect((data as { inputs: unknown[]; $schema?: string }).inputs[0]).toMatchObject({ key: "company_name", label: "Company name", required: false, shared: true });
    expect((data as { $schema?: string }).$schema).toBeUndefined();
  });

  it("rejects unknown references, inline redefinitions and ad-hoc shared fields", () => {
    const bad = (inputs: unknown[]) => buildCatalog([entry({ inputs })], registry).errors.map((e) => e.message).join("\n");
    expect(bad([{ use: "favourite_colour", required: true }])).toMatch(/not defined in catalog\/shared-inputs.json/);
    expect(bad([{ key: "company_name", label: "Co", type: "text", required: true, description: "d" }])).toMatch(/write \{ "use": "company_name"/);
    expect(bad([{ key: "budget", label: "Budget", type: "number", required: true, description: "d", shared: true }])).toMatch(/isn't in catalog\/shared-inputs.json/);
    expect(bad([{ use: "company_name", required: true, label: "extra" }])).toMatch(/Unrecognized key/);
  });

  it("every shipped workflow asks for shared context through the vocabulary", () => {
    const keys = new Set(registry.sharedInputs.map((s) => s.key));
    for (const wf of catalog.workflows) for (const i of wf.inputs) expect(i.shared, `${wf.id}.${i.key}`).toBe(keys.has(i.key));
  });
});

describe("catalog layout and registry", () => {
  it("requires the folder to match the category, and known tools", () => {
    const wrongFolder = buildCatalog([{ file: "finance/demo-flow.json", data: workflowData() }], registry);
    expect(wrongFolder.errors[0].message).toMatch(/move it to gtm\/demo-flow.json/);
    const unknownTool = buildCatalog(
      [{ file: "gtm/demo-flow.json", data: workflowData({ tools: [{ id: "crystal-ball", purpose: "p", required: true }] }) }],
      registry,
    );
    expect(unknownTool.errors[0].message).toMatch(/unknown tool\(s\) crystal-ball/);
  });

  it("rejects definitions outside a category folder and reports broken registry files", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workflows-catalog-"));
    mkdirSync(path.join(root, "workflows", "gtm"), { recursive: true });
    writeFileSync(path.join(root, "workflows", "loose.json"), JSON.stringify(workflowData({ id: "loose" })));
    writeFileSync(path.join(root, "workflows", "gtm", "demo-flow.json"), JSON.stringify(workflowData()));
    writeFileSync(path.join(root, "shared-inputs.json"), "{ not json");
    writeFileSync(path.join(root, "tools.json"), JSON.stringify({ tools: [] }));
    const loaded = await loadCatalog(path.join(root, "workflows"));
    expect(loaded.workflows.map((w) => w.id)).toEqual(["demo-flow"]);
    expect(loaded.sources).toEqual({ "demo-flow": "gtm/demo-flow.json" });
    const messages = loaded.errors.map((e) => `${e.file}: ${e.message}`).join("\n");
    expect(messages).toMatch(/shared-inputs.json: cannot read/);
    expect(messages).toMatch(/loose.json: definitions live in a category folder/);
  });

  it("covers every category with at least one workflow", () => {
    expect(new Set(catalog.workflows.map((w) => w.category)).size).toBe(7);
  });
});

describe("quality tooling", () => {
  it("passes every search case", () => {
    const failures = runSearchCases(catalog.workflows, cases).filter((r) => r.missing.length);
    expect(failures).toEqual([]);
  });

  it("has no lint warnings in the shipped catalog", () => {
    expect(lintCatalog(catalog, cases)).toEqual([]);
  });

  it("flags scaffolded TODOs and missing search coverage", () => {
    const draft = definitionTemplate({ id: "churn-review", name: "Churn Review", category: "operations" });
    const built = buildCatalog([{ file: "operations/churn-review.json", data: draft }], registry);
    expect(built.errors).toEqual([]);
    const messages = lintCatalog(built, cases).map((w) => w.message);
    expect(messages.some((m) => /placeholder/.test(m))).toBe(true);
    expect(messages.some((m) => /no search case/.test(m))).toBe(true);
  });

  it("scaffolds a schema-v2 generic definition that becomes runnable once finished", async () => {
    const { resolveExecutor, runnability } = await import("@/lib/runtime/executors");
    const draft = definitionTemplate({ id: "churn-review", name: "Churn Review", category: "operations" });
    expect(draft).toMatchObject({ schemaVersion: 2, version: "0.1.0", status: "planned", execution: { engine: "generic" } });
    const built = buildCatalog([{ file: "operations/churn-review.json", data: draft }], registry);
    expect(built.errors).toEqual([]);
    const wf = built.workflows[0];
    expect(validateGenericDefinition(wf)).toEqual([]);
    expect(runnability(wf, { ANTHROPIC_API_KEY: "sk-ant-test" })).toEqual({ runnable: false, reason: "Definition only. This workflow can't be executed yet." });
    // Publishing it is a data change: no executor code is needed.
    const finished = { ...wf, status: "available" as const };
    expect(resolveExecutor(finished)?.workflowId).toBe("churn-review");
    expect(runnability(finished, { ANTHROPIC_API_KEY: "sk-ant-test" })).toEqual({ runnable: true });
  });

  it("keeps the v1 template for workflows that need a hand-written executor", () => {
    const draft = definitionTemplate({ id: "churn-review", name: "Churn Review", category: "operations", executable: true });
    expect(Object.hasOwn(draft, "schemaVersion")).toBe(false);
    expect(Object.hasOwn(draft, "execution")).toBe(false);
    expect(buildCatalog([{ file: "operations/churn-review.json", data: draft }], registry).errors).toEqual([]);
  });

  it("validates scaffold options", () => {
    expect(validateScaffold({ id: "Bad Id", name: "", category: "astrology" as never }, new Set())).toHaveLength(3);
    expect(validateScaffold({ id: "market-research", name: "x", category: "gtm" }, new Set(["market-research"]))[0]).toMatch(/already exists/);
  });

  it("keeps generated files in sync with the source", () => {
    for (const name of Object.keys(GENERATED_SCHEMAS) as Array<keyof typeof GENERATED_SCHEMAS>) {
      expect(readFileSync(path.join(process.cwd(), "catalog", name), "utf8"), `${name}: run npm run catalog:schema`).toBe(renderSchema(name));
    }
    expect(readFileSync(path.join(process.cwd(), "docs", "catalog.md"), "utf8"), "run npm run catalog:docs").toBe(renderCatalogDocs(catalog));
  });
});

describe("search and versions", () => {
  it("stems plurals and verb forms conservatively", () => {
    expect(["customers", "companies", "pricing", "founders", "team"].map(stem)).toEqual(["customer", "company", "pric", "founder", "team"]);
  });

  it("runs patch releases on the same executor, but not other minor lines", () => {
    const mr = EXECUTORS["market-research"];
    expect(implementsVersion(mr, "0.2.0")).toBe(true);
    expect(implementsVersion(mr, "0.2.7")).toBe(true);
    expect(implementsVersion(mr, "0.3.0")).toBe(true);
    expect(implementsVersion(mr, "0.4.0")).toBe(false);
    expect(implementsVersion(mr, "0.20.0")).toBe(false);
  });
});
