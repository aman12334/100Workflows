import { describe, expect, it } from "vitest";
import { keyProblem, resolveProvider } from "@/lib/providers";
import { fromOpenAIResponse, openAICreateMessage, supportsReasoningEffort, toOpenAIRequest, UnsupportedFeatureError, type ChatCompletionsClient } from "@/lib/runtime/openai-translate";
import type { CreateParams } from "@/lib/runtime/model";
import { getModelConfig } from "@/lib/server/config";
import { loadCatalog } from "@/lib/catalog/load";
import { runChatTurn } from "@/lib/server/chat";
import { marketResearch } from "@/lib/runtime/executors/market-research";
import { icpBuilder } from "@/lib/runtime/executors/icp-builder";

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

  it("skips Market Research on OpenAI because web search is Anthropic-only, but ICP still runs", () => {
    expect(marketResearch.preflight({ OPENAI_API_KEY: "sk-x", WORKFLOWS_WEB_SEARCH: "on" })).toMatch(/only through Anthropic/);
    expect(icpBuilder.preflight({ OPENAI_API_KEY: "sk-x" })).toBeNull();
  });
});

const params = (overrides: Partial<CreateParams> = {}): CreateParams =>
  ({ model: "gpt-6.1-sol", max_tokens: 4000, system: "Be helpful.", messages: [{ role: "user", content: "hi" }], ...overrides }) as CreateParams;

describe("OpenAI request translation", () => {
  it("maps system, text, tool calls and tool results", () => {
    const req = toOpenAIRequest(
      params({
        messages: [
          { role: "user", content: "find workflows" },
          { role: "assistant", content: [{ type: "text", text: "Searching." }, { type: "tool_use", id: "t1", name: "search_catalog", input: { query: "sales" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"results":[]}' }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "bad input", is_error: true }] },
        ] as CreateParams["messages"],
      }),
    );
    expect(req.messages).toEqual([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "find workflows" },
      { role: "assistant", content: "Searching.", tool_calls: [{ id: "t1", type: "function", function: { name: "search_catalog", arguments: '{"query":"sales"}' } }] },
      { role: "tool", tool_call_id: "t1", content: '{"results":[]}' },
      { role: "tool", tool_call_id: "t2", content: "Error: bad input" },
    ]);
    expect(req.max_completion_tokens).toBe(4000);
  });

  it("maps custom tools, tool_choice, JSON output and effort", () => {
    const req = toOpenAIRequest(
      params({
        tools: [{ name: "search_catalog", description: "Search", input_schema: { type: "object", properties: {} } }],
        tool_choice: { type: "none" },
        output_config: { effort: "medium" },
      }),
    );
    expect(req.tools).toEqual([{ type: "function", function: { name: "search_catalog", description: "Search", parameters: { type: "object", properties: {} } } }]);
    expect(req.tool_choice).toBe("none");
    // OpenAI rejects function tools with reasoning on Chat Completions for these models.
    expect(req.reasoning_effort).toBe("none");

    const structured = toOpenAIRequest(params({ output_config: { effort: "xhigh", format: { type: "json_schema", schema: { type: "object" } } } }));
    expect(structured.response_format).toEqual({ type: "json_schema", json_schema: { name: "output", schema: { type: "object" }, strict: false } });
    expect(structured.reasoning_effort).toBe("high");
    expect(supportsReasoningEffort("gpt-4.1")).toBe(false);
    expect(toOpenAIRequest(params({ model: "gpt-4.1", output_config: { effort: "low" } })).reasoning_effort).toBeUndefined();
  });

  it("refuses Anthropic server tools instead of silently dropping them", () => {
    expect(() => toOpenAIRequest(params({ tools: [{ type: "web_search_20260209", name: "web_search" }] as CreateParams["tools"] }))).toThrow(UnsupportedFeatureError);
  });
});

const completion = (message: Record<string, unknown>, finish_reason = "stop") =>
  ({ id: "c1", model: "gpt-6.1-sol", choices: [{ index: 0, finish_reason, message: { role: "assistant", content: null, refusal: null, ...message } }], usage: { prompt_tokens: 12, completion_tokens: 5 } }) as never;

describe("OpenAI response translation", () => {
  it("returns text, tool calls and usage in the Anthropic shape", () => {
    const m = fromOpenAIResponse(completion({ content: "Here you go." }));
    expect(m.content).toEqual([{ type: "text", text: "Here you go.", citations: null }]);
    expect(m.stop_reason).toBe("end_turn");
    expect(m.usage).toMatchObject({ input_tokens: 12, output_tokens: 5 });

    const t = fromOpenAIResponse(completion({ tool_calls: [{ id: "x", type: "function", function: { name: "search_catalog", arguments: '{"query":"q"}' } }] }, "tool_calls"));
    expect(t.stop_reason).toBe("tool_use");
    expect(t.content[0]).toMatchObject({ type: "tool_use", id: "x", name: "search_catalog", input: { query: "q" } });
  });

  it("maps refusals, length limits and unparseable tool arguments", () => {
    expect(fromOpenAIResponse(completion({ refusal: "no" })).stop_reason).toBe("refusal");
    expect(fromOpenAIResponse(completion({ content: "cut" }, "length")).stop_reason).toBe("max_tokens");
    const bad = fromOpenAIResponse(completion({ tool_calls: [{ id: "x", type: "function", function: { name: "n", arguments: "{oops" } }] }, "tool_calls"));
    expect(bad.content[0]).toMatchObject({ input: { _unparsed: "{oops" } });
  });
});

describe("chat on OpenAI", () => {
  it("runs a full grounded chat turn through the translator", async () => {
    const { workflows } = await loadCatalog();
    const replies = [
      completion({ tool_calls: [{ id: "s", type: "function", function: { name: "search_catalog", arguments: '{"query":"cold email","category":null}' } }] }, "tool_calls"),
      completion({ tool_calls: [{ id: "r", type: "function", function: { name: "recommend_workflows", arguments: '{"recommendations":[{"workflow_id":"outbound-sequence","reason":"Fits."}]}' } }] }, "tool_calls"),
      completion({ content: "Start with `outbound-sequence`." }),
    ];
    const sent: unknown[] = [];
    const fake: ChatCompletionsClient = { chat: { completions: { create: async (body) => (sent.push(body), replies[sent.length - 1]) } } };
    const reply = await runChatTurn({ createMessage: openAICreateMessage(() => fake), model: "gpt-6.1-sol", workflows, history: [{ role: "user", content: "My cold emails get no replies" }] });
    expect(reply.recommendations.map((r) => r.workflow.id)).toEqual(["outbound-sequence"]);
    expect(reply.usage).toEqual({ inputTokens: 36, outputTokens: 15, modelCalls: 3 });
    expect(JSON.stringify(sent[1])).toContain('"role":"tool"');
  });
});
