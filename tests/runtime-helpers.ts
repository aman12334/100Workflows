import type Anthropic from "@anthropic-ai/sdk";
import type { Recorder } from "@/lib/runtime/engine";
import type { Report } from "@/lib/runtime/executors/market-research";
import type { Evaluation } from "@/lib/runtime/evaluation";
import type { CreateMessage, CreateParams, Message } from "@/lib/runtime/model";

export function msg(content: unknown[], stop_reason: Message["stop_reason"] = "end_turn", usage: Record<string, unknown> = {}): Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "test",
    content,
    stop_reason,
    usage: { input_tokens: 100, output_tokens: 50, ...usage },
  } as unknown as Message;
}

export const json = (value: unknown) => msg([{ type: "text", text: JSON.stringify(value) }]);

/** A web search response: retrieved results plus notes that cite some of them. */
export function searchResponse(results: Array<{ url: string; title: string }>, cited: Array<{ url: string; text: string }> = []): Message {
  return msg(
    [
      { type: "server_tool_use", id: "st1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "st1", content: results.map((r) => ({ type: "web_search_result", url: r.url, title: r.title, page_age: null, encrypted_content: "x" })) },
      {
        type: "text",
        text: "Research notes.",
        citations: cited.map((c) => ({ type: "web_search_result_location", url: c.url, title: "t", cited_text: c.text, encrypted_index: "i" })),
      },
    ],
    "end_turn",
    { server_tool_use: { web_search_requests: 2 } },
  );
}

/**
 * A fake model routed by what the request looks like: web search requests,
 * review requests (rubric) and everything else (writer). Each route plays its
 * scripted responses in order and repeats the last one.
 */
export function routedModel(routes: { search?: Message[]; write?: Message[]; review?: Message[] }) {
  const calls: Array<{ route: string; params: CreateParams }> = [];
  const counters = { search: 0, write: 0, review: 0 };
  const createMessage: CreateMessage = async (params, options) => {
    if (options?.signal?.aborted) throw new Error("aborted");
    const route = params.tools?.some((t) => "type" in t && String(t.type).startsWith("web_search"))
      ? "search"
      : String(params.system ?? "").includes("strict reviewer")
        ? "review"
        : "write";
    calls.push({ route, params });
    const list = routes[route as keyof typeof routes] ?? [];
    if (!list.length) throw new Error(`no scripted response for ${route}`);
    return list[Math.min(counters[route as keyof typeof counters]++, list.length - 1)];
  };
  return { createMessage, calls };
}

export const review = (rating: number) => json({ rating: String(rating), rationale: `rated ${rating}` });

export function memoryRecorder() {
  const steps: Array<{ stepId: string; kind: string; attempt: number; status: string; detail?: string; error?: string }> = [];
  const evaluations: Evaluation[] = [];
  const recorder: Recorder = {
    step(stepId, kind, attempt) {
      const row: (typeof steps)[number] = { stepId, kind, attempt, status: "running" };
      steps.push(row);
      return {
        done: (detail) => Object.assign(row, { status: "done", detail }),
        fail: (error) => Object.assign(row, { status: "failed", error }),
      };
    },
    evaluation: (e) => evaluations.push(e),
  };
  return { recorder, steps, evaluations };
}

export type { Anthropic };

/** A report that passes every deterministic check against searchResponse(RESULTS, CITED) sources S1/S2. */
const long = "This is a sufficiently detailed paragraph that summarizes the market and what it means for the user.";
export const goodReport: Report = {
  executive_summary: long,
  market_overview: long,
  key_players: [{ name: "Vendor A", description: "Leader", source_ids: ["S1"] }],
  trends: [{ trend: "Automation", evidence: "Adoption rising", source_ids: ["S2"] }],
  findings: [
    { claim: "Market grew 20% in 2025", source_ids: ["S1"] },
    { claim: "Top three vendors hold 60%", source_ids: ["S1"] },
    { claim: "Agencies adopt automation", source_ids: ["S2"] },
  ],
  risks: ["Consolidation"],
  open_questions: ["Pricing data is thin"],
};
