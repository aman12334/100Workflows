import type { Workflow } from "@/lib/catalog/schema";
import { WorkflowFailure, type ExecContext } from "../engine";
import type { FetchedPageResult, SearchOutput } from "../tools/registry";
import { MAX_SEARCH_CALLS } from "../tools/registry";
import { ToolError } from "../tools/runner";
import type { Source, UnavailableSource } from "../tools/sources";

/**
 * The "gather" step of a research workflow: run once before any writing, using
 * only the registered tools the definition declares. Order is deterministic so
 * source ids (S1, S2, ...) are stable:
 *   1. pages from URL inputs, in input order
 *   2. web search results (results with cited passages first)
 *   3. the top `fromSearch` search results are opened and read in full
 * Nothing is invented: if no source could be retrieved, the workflow fails with
 * the reasons instead of writing from model knowledge.
 */

type Step = Workflow["steps"][number];

export function gatherStep(workflow: Workflow): Step | undefined {
  return workflow.steps.find((s) => s.mode === "gather");
}

/** Model calls the gather step can make (web search runs inside model calls). */
export function gatherModelCalls(workflow: Workflow): number {
  return gatherStep(workflow)?.gather?.search ? MAX_SEARCH_CALLS : 0;
}

function urlsFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(urlsFrom);
  if (typeof value !== "string") return [];
  return value
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

const reasonOf = (err: unknown) => (err instanceof ToolError ? err.message : err instanceof Error ? err.message : String(err));

export interface Gathered {
  sources: Source[];
  unavailable: UnavailableSource[];
  searches: number;
}

export async function gather(ctx: ExecContext, step: Step, context: string, now: () => Date = () => new Date()): Promise<Gathered> {
  const config = step.gather!;
  return ctx.step(step.id, async () => {
    const pages: Array<Omit<Source, "id">> = [];
    const unavailable: UnavailableSource[] = [];
    const seen = new Set<string>();
    let searches = 0;

    const read = async (url: string, excerpts: string[] = [], fallback?: Omit<Source, "id">) => {
      try {
        const page = await ctx.tools.run<FetchedPageResult>(step.id, "web-fetch", { url });
        pages.push({
          url: page.finalUrl,
          title: page.title,
          publisher: page.publisher,
          published: page.published ?? fallback?.published ?? null,
          via: "page",
          excerpts,
          text: page.text,
          retrievedAt: now().toISOString(),
        });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err; // budgets, cancellation and time limits belong to the engine
        unavailable.push({ url, reason: reasonOf(err) });
        if (fallback) pages.push(fallback); // still known as a search result, but not read
      }
    };

    // 1. URLs the user supplied.
    for (const key of config.fetch?.urlInputs ?? []) {
      for (const url of urlsFrom(ctx.inputs[key])) {
        if (seen.has(url)) continue;
        seen.add(url);
        if (ctx.tools.remaining("web-fetch") <= 0) {
          unavailable.push({ url, reason: `not read: the page limit of ${config.fetch!.maxPages} was reached` });
          continue;
        }
        await read(url);
      }
    }

    // 2. Web search, then 3. read the top results.
    if (config.search) {
      let results: SearchOutput["results"] = [];
      try {
        const out = await ctx.tools.run<SearchOutput>(step.id, "web-search", { request: step.prompt ?? step.responsibility, context, maxSearches: config.search.maxSearches });
        results = out.results;
        searches = out.searches;
        for (const e of out.errors) unavailable.push({ url: "(web search)", reason: `search error: ${e}` });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        unavailable.push({ url: "(web search)", reason: reasonOf(err) });
      }
      let toRead = config.fetch?.fromSearch ?? 0;
      for (const r of results) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        const asResult: Omit<Source, "id"> = { url: r.url, title: r.title, publisher: null, published: r.pageAge, via: "search_result", excerpts: r.excerpts, text: "", retrievedAt: now().toISOString() };
        if (toRead > 0 && ctx.tools.remaining("web-fetch") > 0) {
          toRead--;
          await read(r.url, r.excerpts, asResult);
        } else {
          pages.push(asResult);
        }
      }
    }

    const sources: Source[] = pages.filter((p) => p.text || p.excerpts.length || p.via === "search_result").map((p, i) => ({ ...p, id: `S${i + 1}` }));
    const usable = sources.filter((s) => s.text || s.excerpts.length);
    if (!usable.length) {
      const why = unavailable.length ? ` ${unavailable.slice(0, 5).map((u) => `${u.url}: ${u.reason}`).join("; ")}.` : "";
      throw new WorkflowFailure(`No usable sources could be retrieved, so nothing was written (it would have had nothing to cite).${why}`);
    }
    const read_ = sources.filter((s) => s.via === "page").length;
    return {
      value: { sources, unavailable, searches },
      detail: `${read_} page${read_ === 1 ? "" : "s"} read, ${sources.length - read_} search result${sources.length - read_ === 1 ? "" : "s"} not read${unavailable.length ? `, ${unavailable.length} unavailable` : ""}`,
    };
  });
}
