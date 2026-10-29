import { z } from "zod";
import type { Workflow } from "../schema";
import { searchCatalog } from "../search";

export const SearchCasesSchema = z.object({
  about: z.string().optional(),
  limit: z.number().int().min(1).max(20),
  cases: z.array(z.object({ query: z.string().min(1), expect: z.array(z.string()).min(1) }).strict()),
});
export type SearchCases = z.infer<typeof SearchCasesSchema>;

export interface CaseResult {
  query: string;
  missing: string[];
  got: string[];
}

/** Runs every case; a case fails when an expected workflow isn't in the top `limit` results. */
export function runSearchCases(workflows: Workflow[], cases: SearchCases): CaseResult[] {
  return cases.cases.map((c) => {
    const got = searchCatalog(workflows, c.query, { limit: cases.limit }).map((h) => h.workflow.id);
    return { query: c.query, got, missing: c.expect.filter((id) => !got.includes(id)) };
  });
}
