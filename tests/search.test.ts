import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { searchCatalog, tokenize } from "@/lib/catalog/search";

let workflows: Workflow[];
beforeAll(async () => {
  workflows = (await loadCatalog()).workflows;
});

describe("searchCatalog", () => {
  it("drops stopwords when tokenizing", () => {
    expect(tokenize("I want to get my first 100 B2B customers")).toEqual(["first", "100", "b2b", "customers"]);
  });

  it("finds acquisition workflows for a customer-acquisition goal", () => {
    const ids = searchCatalog(workflows, "acquire my first 100 B2B customers without a marketing team").map((h) => h.workflow.id);
    expect(ids).toContain("icp-builder");
    expect(ids).toContain("outbound-sequence");
  });

  it("ranks the obvious match first", () => {
    expect(searchCatalog(workflows, "runway burn cash")[0].workflow.id).toBe("runway-forecast");
    expect(searchCatalog(workflows, "interview notes synthesis")[0].workflow.id).toBe("interview-synthesis");
  });

  it("filters by category", () => {
    const hits = searchCatalog(workflows, "pricing", { category: "marketing" });
    expect(hits.every((h) => h.workflow.category === "marketing")).toBe(true);
  });

  it("returns nothing for unrelated queries rather than padding results", () => {
    expect(searchCatalog(workflows, "quantum chromodynamics lattice")).toEqual([]);
  });

  it("lists workflows when the query has no meaningful terms", () => {
    expect(searchCatalog(workflows, "the and of", { limit: 3 })).toHaveLength(3);
  });
});
