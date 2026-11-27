import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { executeWorkflow } from "@/lib/runtime/engine";
import { createGenericExecutor } from "@/lib/runtime/executors/generic";
import { openAICreateMessage, type ResponsesClient } from "@/lib/runtime/openai-translate";
import type { ToolCallRecord } from "@/lib/runtime/tools/runner";
import { FetchFailed, type PageTransport } from "@/lib/runtime/tools/http-fetch";
import { goodReport, memoryRecorder } from "./runtime-helpers";
import { resolveExecutor } from "@/lib/runtime/executors";

/**
 * Research workflows on OpenAI, end to end through the real translation layer, with a FAKE OpenAI
 * client and canned pages (no network, no key). Search returns links only; the pages are read
 * locally and every claim is checked against their text.
 */

const ENV = { OPENAI_API_KEY: "sk-test", WORKFLOWS_PROVIDER: "openai", WORKFLOWS_WEB_SEARCH: "on", WORKFLOWS_WEB_FETCH: "on" };
const IDS = ["company-research-brief", "industry-news-digest", "fact-checker"];

interface Fixture {
  inputs: Record<string, unknown>;
  search: { results: Array<{ url: string; title: string }>; cited: Array<{ url: string; text: string }> };
  pages: Record<string, string>;
  good: unknown;
}

let catalog: Workflow[];
beforeAll(async () => {
  catalog = (await loadCatalog()).workflows;
});

function fakeOpenAI(f: Fixture) {
  const bodies: Array<Record<string, unknown>> = [];
  const cited = [...new Set(f.search.cited.map((c) => c.url))];
  const client: ResponsesClient = {
    responses: {
      async create(body) {
        bodies.push(body as unknown as Record<string, unknown>);
        const searching = (body.tools ?? []).some((t) => t.type === "web_search");
        const output = searching
          ? [
              { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", queries: ["q"], sources: f.search.results.map((r) => ({ type: "url", url: r.url })) } },
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Research notes with citations.", annotations: cited.map((url) => ({ type: "url_citation", url, title: f.search.results.find((r) => r.url === url)?.title ?? url, start_index: 0, end_index: 5 })) }],
              },
            ]
          : [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(f.good), annotations: [] }] }];
        return { id: "resp", model: String(body.model), output, usage: { input_tokens: 100, output_tokens: 50 } } as never;
      },
    },
  };
  return { client, bodies };
}

describe.each(IDS)("%s on OpenAI (fake client, canned pages)", (id) => {
  it("searches with OpenAI's web_search tool, reads the cited pages locally and is accepted", async () => {
    const wf = catalog.find((w) => w.id === id)!;
    const f = JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "phase2", `${id}.json`), "utf8")) as Fixture;
    const { client, bodies } = fakeOpenAI(f);
    const requested: string[] = [];
    const transport: PageTransport = async (url) => {
      requested.push(url);
      const body = f.pages[url];
      if (body === undefined) throw new FetchFailed("the server answered 404", false);
      return { url, finalUrl: url, status: 200, contentType: "text/html; charset=utf-8", body, bytes: body.length, redirects: 0 };
    };
    const { recorder } = memoryRecorder();
    const tools: ToolCallRecord[] = [];
    const r = await executeWorkflow({
      workflow: wf,
      executor: createGenericExecutor(wf),
      inputs: f.inputs,
      upstream: {},
      createMessage: openAICreateMessage(() => client),
      model: "gpt-6.1-sol",
      recorder: { ...recorder, tool: (c) => tools.push(c) },
      env: { ...ENV, WORKFLOWS_MODEL_REVIEW: "off" },
      toolOverrides: { transport },
    });
    expect([r.status, r.reason]).toEqual(["succeeded", undefined]);
    const search = bodies.find((b) => (b.tools as Array<{ type: string }> | undefined)?.some((t) => t.type === "web_search"))!;
    expect(search.max_tool_calls).toBeGreaterThan(0);
    expect(search.include).toContain("web_search_call.action.sources");
    expect(requested.length).toBeGreaterThan(0);
    const out = r.result!.json as { retrieved_sources: Array<{ via: string }> };
    expect(out.retrieved_sources.some((s) => s.via === "page")).toBe(true);
    expect(r.usage.webSearches).toBe(1);
    expect(tools.filter((t) => t.toolId === "web-search")).toMatchObject([{ status: "ok" }]);
  });
});

describe("Market Research on OpenAI (fake client, canned pages)", () => {
  const OBJECTIVE = "How large is the market for AI bookkeeping tools for US agencies, and who leads it?";
  const PAGES: Record<string, string> = {
    "https://a.example.com/market": "<html><head><title>Agency bookkeeping market 2026</title></head><body><main><p>Navigation and other boilerplate text that is long enough to be a paragraph but says nothing useful.</p><p>The market for AI bookkeeping tools used by US agencies reached an estimated $1.2B in 2026, growing about 18% a year as agencies automate reconciliation.</p></main></body></html>",
    "https://b.example.com/leaders": "<html><head><title>Who leads AI bookkeeping</title></head><body><main><p>Leaders in AI bookkeeping for agencies include three vendors that together hold most of the market, according to an industry survey of 400 agencies.</p></main></body></html>",
  };
  const inputs = { research_objective: OBJECTIVE, company_name: "Acme", product_description: "AI bookkeeping for agencies", target_market: "US marketing agencies" };

  function client(urls: string[]) {
    const fake: ResponsesClient = {
      responses: {
        async create(body) {
          const searching = (body.tools ?? []).some((t) => t.type === "web_search");
          const reviewing = String(body.instructions ?? "").includes("strict reviewer");
          const text = searching ? "Notes citing the pages." : JSON.stringify(reviewing ? { rating: "4", rationale: "ok" } : goodReport);
          const output = [
            ...(searching ? [{ type: "web_search_call", id: "ws", status: "completed", action: { type: "search", queries: ["q"], sources: urls.map((url) => ({ type: "url", url })) } }] : []),
            { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
          ];
          return { id: "r", model: "gpt-6.1-sol", output, usage: { input_tokens: 100, output_tokens: 50 } } as never;
        },
      },
    };
    return fake;
  }
  const pages = (map: Record<string, string>): PageTransport => async (url) => {
    const body = map[url];
    if (body === undefined) throw new FetchFailed("the server answered 404", false);
    return { url, finalUrl: url, status: 200, contentType: "text/html; charset=utf-8", body, bytes: body.length, redirects: 0 };
  };
  async function runMR(wf: Workflow, urls: string[], map: Record<string, string>) {
    const { recorder } = memoryRecorder();
    return executeWorkflow({
      workflow: wf, executor: resolveExecutor(wf)!, inputs, upstream: {}, createMessage: openAICreateMessage(() => client(urls)), model: "gpt-6.1-sol",
      recorder, env: ENV, toolOverrides: { transport: pages(map) },
    });
  }

  it("reads the top pages here and quotes passages word for word from them", async () => {
    const wf = catalog.find((w) => w.id === "market-research")!;
    expect(wf.version).toBe("0.3.0");
    const r = await runMR(wf, [...Object.keys(PAGES), "https://c.example.com/missing"], PAGES);
    expect([r.status, r.reason]).toEqual(["succeeded", undefined]);
    const out = r.result!.json as { sources: Array<{ url: string; excerpts: string[] }> };
    const quoted = out.sources.filter((s) => s.excerpts.length);
    expect(quoted.map((s) => s.url).sort()).toEqual(Object.keys(PAGES).sort());
    for (const s of quoted) for (const e of s.excerpts) expect(PAGES[s.url].replace(/<[^>]+>/g, "\n")).toContain(e);
    expect(JSON.stringify(out.sources)).not.toContain("boilerplate");
  });

  it("writes nothing when none of the pages can be read", async () => {
    const wf = catalog.find((w) => w.id === "market-research")!;
    const r = await runMR(wf, ["https://x.example.com/a", "https://x.example.com/b"], {});
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/none of the top pages could be read.*No report was written/);
  });

  it("a package pinned to 0.2.2 can't read pages, so it stops and points to the update", async () => {
    const old = JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "v1-snapshots", "market-research.json"), "utf8"));
    const wf = { ...catalog.find((w) => w.id === "market-research")!, ...old } as Workflow;
    expect(wf.version).toBe("0.2.2");
    const r = await runMR(wf, Object.keys(PAGES), PAGES);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/Update to the latest Market Research version/);
  });
});
