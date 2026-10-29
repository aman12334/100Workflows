import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { formFields, inputsFor, missingRequired, validateValues } from "@/lib/packages/inputs";
import { expandSelection, summarizeRequirements } from "@/lib/packages/resolve";

let catalog: Workflow[];
beforeAll(async () => {
  catalog = (await loadCatalog()).workflows;
});

const fieldsFor = (ids: string[]) => formFields(summarizeRequirements(expandSelection(catalog, ids), catalog));

describe("setup fields", () => {
  it("asks shared context once and namespaces workflow-specific fields", () => {
    const keys = fieldsFor(["market-research", "icp-builder", "outbound-sequence"]).map((f) => f.storageKey);
    expect(keys.filter((k) => k === "company_name")).toHaveLength(1);
    expect(keys).toContain("market-research.research_objective");
    expect(keys).toContain("outbound-sequence.tone");
  });

  it("validates by type, rejects unknown keys, and treats blanks as cleared", () => {
    const fields = fieldsFor(["outbound-sequence", "competitor-teardown"]);
    const r = validateValues(fields, {
      company_name: "  Acme  ",
      "outbound-sequence.tone": "Shouty",
      "competitor-teardown.competitor_urls": ["https://a.example", " ", "https://b.example"],
      product_description: "",
      "evil.key": "x",
    });
    expect(r.set).toEqual({ company_name: "Acme", "competitor-teardown.competitor_urls": ["https://a.example", "https://b.example"] });
    expect(r.errors["outbound-sequence.tone"]).toMatch(/Direct, Friendly, Formal/);
    expect(r.errors["evil.key"]).toBe("unknown field");
    expect(r.cleared).toEqual(["product_description"]);
  });

  it("coerces numbers and rejects junk", () => {
    const fields = fieldsFor(["runway-forecast"]);
    expect(validateValues(fields, { "runway-forecast.cash_on_hand": "250000" }).set).toEqual({ "runway-forecast.cash_on_hand": 250000 });
    expect(validateValues(fields, { "runway-forecast.cash_on_hand": "lots" }).errors["runway-forecast.cash_on_hand"]).toBeDefined();
  });

  it("detects missing required inputs per workflow", () => {
    const fields = fieldsFor(["market-research", "icp-builder"]);
    const missing = missingRequired(fields, { company_name: "Acme", target_market: "US agencies" });
    expect(missing.map((m) => m.storageKey).sort()).toEqual(["market-research.research_objective", "product_description"]);
    expect(missingRequired(fields, { company_name: "Acme", target_market: "x" }, new Set(["market-research"])).map((m) => m.storageKey)).toEqual([
      "market-research.research_objective",
    ]);
  });

  it("hands each workflow its own keys, falling back to shared answers", () => {
    const mr = catalog.find((w) => w.id === "market-research")!;
    expect(inputsFor(mr, { target_market: "US", "market-research.research_objective": "Q?", "icp-builder.existing_customers": "x" })).toEqual({
      target_market: "US",
      research_objective: "Q?",
    });
  });
});
