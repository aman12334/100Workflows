import { describe, expect, it } from "vitest";
import { keyProblem, resolveProvider } from "@/lib/providers";
import { REASONING_BLOCK, fromOpenAIResponse, openAICreateMessage, supportsReasoningEffort, toOpenAIRequest, UnsupportedFeatureError, type ResponsesClient } from "@/lib/runtime/openai-translate";
import type { CreateParams } from "@/lib/runtime/model";
import { getModelConfig } from "@/lib/server/config";
import { loadCatalog } from "@/lib/catalog/load";
import { runChatTurn } from "@/lib/server/chat";
import { marketResearch } from "@/lib/runtime/executors/market-research";
import { icpBuilder } from "@/lib/runtime/executors/icp-builder";
import { normalizeSearch } from "@/lib/runtime/tools/registry";

describe("provider selection", () => {
  it("prefers an explicit choice, then whichever key exists (Anthropic first)", () => {
    expect(resolveProvider({})).toBe("anthropic");
    expect(resolveProvider({ OPENAI_API_KEY: "sk-x" })).toBe("openai");
    expect(resolveProvider({ OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-ant-x" })).toBe("anthropic");
    expect(resolveProvider({ OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-ant-x", WORKFLOWS_PROVIDER: "OpenAI" })).toBe("openai");
  });

  it("uses OpenAI's default model and key variable without exposing the key", () => {
    const c = getModelConfig({ OPENAI_API_KEY: "sk-proj-secretsecret" });
    expect(c).toEqual({ configured: true, provider: "openai", providerLabel: "OpenAI", model: "gpt-6.1-sol", keyVar: "OPENAI_API_KEY" });
    expect(JSON.stringify(c)).not.toContain("secret");
  });

  it("explains empty, misplaced and invalid settings", () => {
    expect(getModelConfig({ WORKFLOWS_PROVIDER: "openai", OPENAI_API_KEY: "" }).problem).toMatch(/OPENAI_API_KEY is not set/);
    expect(keyProblem("openai", "sk-ant-abc")).toMatch(/Anthropic key/);
    expect(keyProblem("openai", "pk-123")).toMatch(/does not look like an OpenAI key/);
    expect(getModelConfig({ WORKFLOWS_PROVIDER: "gemini" }).problem).toMatch(/must be "anthropic" or "openai"/);
  });

  it("runs Market Research on OpenAI only with page reading on (search returns links only); ICP always runs", () => {
    expect(marketResearch.preflight({ OPENAI_API_KEY: "sk-x", WORKFLOWS_WEB_SEARCH: "on" })).toMatch(/needs page reading with OpenAI.*WORKFLOWS_WEB_FETCH=on/);
    expect(marketResearch.preflight({ OPENAI_API_KEY: "sk-x", WORKFLOWS_WEB_SEARCH: "on", WORKFLOWS_WEB_FETCH: "on" })).toBeNull();
    expect(marketResearch.preflight({ ANTHROPIC_API_KEY: "sk-ant-x", WORKFLOWS_WEB_SEARCH: "on" })).toBeNull();
    expect(icpBuilder.preflight({ OPENAI_API_KEY: "sk-x" })).toBeNull();
  });
});

const params = (overrides: Partial<CreateParams> = {}): CreateParams =>
  ({ model: "gpt-6.1-sol", max_tokens: 4000, system: "Be helpful.", messages: [{ role: "user", content: "hi" }], ...overrides }) as CreateParams;

describe("OpenAI request translation (Responses API)", () => {
  it("maps system, text, reasoning, tool calls and tool results in order", () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" };
    const req = toOpenAIRequest(
      params({
        messages: [
          { role: "user", content: "find workflows" },
          {
            role: "assistant",
            content: [{ type: REASONING_BLOCK, item: reasoning }, { type: "text", text: "Searching." }, { type: "tool_use", id: "t1", name: "search_catalog", input: { query: "sales" } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"results":[]}' }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "bad input", is_error: true }] },
        ] as unknown as CreateParams["messages"],
      }),
    );
    expect(req.instructions).toBe("Be helpful.");
    expect(req.input).toEqual([
      { role: "user", content: "find workflows" },
      reasoning,
      { role: "assistant", content: "Searching." },
      { type: "function_call", call_id: "t1", name: "search_catalog", arguments: '{"query":"sales"}' },
      { type: "function_call_output", call_id: "t1", output: '{"results":[]}' },
      { type: "function_call_output", call_id: "t2", output: "Error: bad input" },
    ]);
    expect(req.max_output_tokens).toBe(4000);
    expect(req.store).toBe(false);
    expect(req.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("keeps reasoning effort alongside function tools, which Chat Completions rejected", () => {
    const req = toOpenAIRequest(
      params({
        tools: [{ name: "search_catalog", description: "Search", input_schema: { type: "object", properties: {} } }],
        tool_choice: { type: "none" },
        output_config: { effort: "medium" },
      }),
    );
    expect(req.tools).toEqual([{ type: "function", name: "search_catalog", description: "Search", parameters: { type: "object", properties: {} }, strict: false }]);
    expect(req.tool_choice).toBe("none");
    expect(req.reasoning).toEqual({ effort: "medium" });
  });

  it("maps JSON output and clamps effort to what OpenAI accepts", () => {
    const req = toOpenAIRequest(params({ output_config: { effort: "max", format: { type: "json_schema", schema: { type: "object" } } } }));
    expect(req.text).toEqual({ format: { type: "json_schema", name: "output", schema: { type: "object" }, strict: false } });
    expect(req.reasoning).toEqual({ effort: "xhigh" });
    expect(supportsReasoningEffort("gpt-4.1")).toBe(false);
    const plain = toOpenAIRequest(params({ model: "gpt-4.1", output_config: { effort: "low" } }));
    expect(plain.reasoning).toBeUndefined();
    expect(plain.include).toBeUndefined();
  });

  it("refuses Anthropic server tools it can't map instead of silently dropping them", () => {
    expect(() => toOpenAIRequest(params({ tools: [{ type: "code_execution_20250825", name: "code_execution" }] as unknown as CreateParams["tools"] }))).toThrow(UnsupportedFeatureError);
  });

  it("maps web search to OpenAI's built-in web_search tool, capping searches with max_tool_calls", () => {
    const req = toOpenAIRequest(params({ tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }] as CreateParams["tools"] }));
    expect(req.tools).toEqual([{ type: "web_search" }]);
    expect(req.max_tool_calls).toBe(4);
    expect(req.include).toEqual(expect.arrayContaining(["web_search_call.action.sources", "reasoning.encrypted_content"]));
  });
});

describe("OpenAI web search results", () => {
  const res = (output: unknown[]) => ({ id: "r", model: "gpt-6.1-sol", output, usage: { input_tokens: 10, output_tokens: 5 } }) as never;
  const answer = (annotations: unknown[]) => ({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Acme raised $12M (source).", annotations }] });

  it("turns searches into results with URLs and titles only, cited pages first, and counts searches", () => {
    const m = fromOpenAIResponse(
      res([
        { type: "web_search_call", id: "ws1", status: "completed", action: { type: "search", queries: ["acme funding"], sources: [{ type: "url", url: "https://b.example.com" }, { type: "url", url: "https://a.example.com/news" }] } },
        { type: "web_search_call", id: "ws2", status: "completed", action: { type: "open_page", url: "https://c.example.com" } },
        answer([
          { type: "url_citation", url: "https://a.example.com/news", title: "Acme raises $12M", start_index: 0, end_index: 10 },
          { type: "url_citation", url: "https://d.example.com/extra", title: "Extra", start_index: 0, end_index: 5 },
        ]),
      ]),
    );
    const blocks = m.content as unknown as Array<Record<string, unknown>>;
    expect(blocks.filter((b) => b.type === "server_tool_use").map((b) => b.input)).toEqual([{ query: "acme funding" }, { query: "https://c.example.com" }]);
    const results = blocks.filter((b) => b.type === "web_search_tool_result").flatMap((b) => b.content as Array<{ url: string; title: string }>);
    expect(results.map((r) => r.url)).toEqual(["https://a.example.com/news", "https://b.example.com", "https://c.example.com", "https://d.example.com/extra"]);
    expect(results[0].title).toBe("Acme raises $12M");
    expect(m.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    // The model's own sentence is never passed off as text quoted from a page.
    expect(blocks.filter((b) => b.type === "text").every((b) => b.citations === null)).toBe(true);
    const { results: normalized } = normalizeSearch(m.content as never);
    expect(normalized.every((r) => r.excerpts.length === 0)).toBe(true);
  });

  it("reports failed searches as search errors", () => {
    const m = fromOpenAIResponse(res([{ type: "web_search_call", id: "ws1", status: "failed", action: { type: "search", queries: ["x"] } }, answer([])]));
    expect(normalizeSearch(m.content as never).errors).toEqual(["openai_failed"]);
  });
});

const response = (output: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id: "resp_1", model: "gpt-6.1-sol", output, incomplete_details: null, usage: { input_tokens: 12, output_tokens: 5 }, ...extra }) as never;
const say = (text: string, phase?: string) => ({ type: "message", id: "m", role: "assistant", status: "completed", ...(phase ? { phase } : {}), content: [{ type: "output_text", text, annotations: [] }] });
const call = (call_id: string, name: string, args: string) => ({ type: "function_call", call_id, name, arguments: args });

describe("OpenAI response translation", () => {
  it("returns text, tool calls, reasoning and usage in the Anthropic shape", () => {
    const m = fromOpenAIResponse(response([say("Here you go.")]));
    expect(m.content).toEqual([{ type: "text", text: "Here you go.", citations: null }]);
    expect(m.stop_reason).toBe("end_turn");
    expect(m.usage).toMatchObject({ input_tokens: 12, output_tokens: 5 });

    const t = fromOpenAIResponse(response([{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" }, call("x", "search_catalog", '{"query":"q"}')]));
    expect(t.stop_reason).toBe("tool_use");
    expect(t.content).toEqual([
      { type: REASONING_BLOCK, item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" } },
      { type: "tool_use", id: "x", name: "search_catalog", input: { query: "q" } },
    ]);
  });

  it("drops commentary when there is a final answer", () => {
    const m = fromOpenAIResponse(response([say("Let me look…", "commentary"), say("Final answer.", "final_answer")]));
    expect(m.content).toEqual([{ type: "text", text: "Final answer.", citations: null }]);
  });

  it("maps refusals, length limits and unparseable tool arguments", () => {
    const refusal = { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] };
    expect(fromOpenAIResponse(response([refusal])).stop_reason).toBe("refusal");
    expect(fromOpenAIResponse(response([say("cut")], { incomplete_details: { reason: "max_output_tokens" } })).stop_reason).toBe("max_tokens");
    const bad = fromOpenAIResponse(response([call("x", "n", "{oops")]));
    expect(bad.content[0]).toMatchObject({ input: { _unparsed: "{oops" } });
  });
});

describe("chat on OpenAI", () => {
  it("runs a full grounded chat turn and sends reasoning back with each tool result", async () => {
    const { workflows } = await loadCatalog();
    const replies = [
      response([{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" }, call("s", "search_catalog", '{"query":"cold email","category":null}')]),
      response([call("r", "recommend_workflows", '{"recommendations":[{"workflow_id":"outbound-sequence","reason":"Fits."}]}')]),
      response([say("Start with `outbound-sequence`.")]),
    ];
    const sent: Array<{ input: unknown[] }> = [];
    const fake: ResponsesClient = { responses: { create: async (body) => (sent.push(body as never), replies[sent.length - 1]) } };
    const reply = await runChatTurn({ createMessage: openAICreateMessage(() => fake), model: "gpt-6.1-sol", workflows, history: [{ role: "user", content: "My cold emails get no replies" }] });

    expect(reply.recommendations.map((r) => r.workflow.id)).toEqual(["outbound-sequence"]);
    expect(reply.usage).toEqual({ inputTokens: 36, outputTokens: 15, modelCalls: 3 });
    expect(sent[1].input).toContainEqual({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" });
    expect(sent[1].input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "s" }));
  });
});
