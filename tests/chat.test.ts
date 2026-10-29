import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import { MAX_HISTORY_MESSAGES, MessageInputSchema, historyWindow } from "@/lib/chat-types";
import { MAX_MODEL_CALLS, extractWorkflowRefs, parseRecommendations, runChatTurn, type CreateMessage } from "@/lib/server/chat";

type Message = Anthropic.Beta.Messages.BetaMessage;
type Params = Parameters<CreateMessage>[0];

let workflows: Workflow[];
beforeAll(async () => {
  workflows = (await loadCatalog()).workflows;
});

function message(content: unknown[], stop_reason: Message["stop_reason"], usage = { input_tokens: 100, output_tokens: 20 }): Message {
  return { id: "msg", type: "message", role: "assistant", model: "test", content, stop_reason, usage } as unknown as Message;
}
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, input: unknown, name = "search_catalog") => ({ type: "tool_use", id, name, input });

/** Fake model that plays back scripted responses and records every request. */
function scripted(responses: Message[]) {
  const calls: Params[] = [];
  const createMessage: CreateMessage = async (params) => {
    // Snapshot messages: the engine keeps appending to the same array.
    calls.push({ ...params, messages: [...params.messages] });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next;
  };
  return { createMessage, calls };
}

const history = [{ role: "user" as const, content: "I want my first 100 B2B customers but have no marketing team." }];

describe("runChatTurn", () => {
  it("searches the catalog, then returns only workflows that exist", async () => {
    const { createMessage, calls } = scripted([
      message([text("Let me look."), toolUse("t1", { query: "first customers b2b", category: null })], "tool_use"),
      message([text("Start with `icp-builder`, then `outbound-sequence`. Also try `growth-hacker-9000`.")], "end_turn"),
    ]);

    const reply = await runChatTurn({ createMessage, model: "claude-opus-5-5", workflows, history });

    expect(reply.workflows.map((w) => w.id)).toEqual(["icp-builder", "outbound-sequence"]);
    expect(reply.unknownWorkflowIds).toEqual(["growth-hacker-9000"]);
    expect(reply.searchedWorkflowIds).toContain("icp-builder");
    expect(reply.usage).toEqual({ inputTokens: 200, outputTokens: 40, modelCalls: 2 });
    expect(reply.stopped).toBeUndefined();

    // The second request carries the real search results back as a tool_result.
    const toolResultTurn = calls[1].messages.at(-1)!;
    const block = (toolResultTurn.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[])[0];
    expect(block.type).toBe("tool_result");
    expect(JSON.parse(block.content as string).results.map((r: { id: string }) => r.id)).toContain("icp-builder");
  });

  it("never sends the API key or secrets in request params", async () => {
    const { createMessage, calls } = scripted([message([text("Hi")], "end_turn")]);
    await runChatTurn({ createMessage, model: "m", workflows, history });
    expect(JSON.stringify(calls)).not.toMatch(/sk-ant-|api[_-]?key/i);
  });

  it("stops after MAX_MODEL_CALLS even if the model keeps calling tools", async () => {
    const loop = message([toolUse("t", { query: "anything", category: null })], "tool_use");
    const { createMessage, calls } = scripted([loop]);

    const reply = await runChatTurn({ createMessage, model: "m", workflows, history });

    expect(calls).toHaveLength(MAX_MODEL_CALLS);
    expect(calls.at(-1)!.tool_choice).toEqual({ type: "none" });
    expect(calls.slice(0, -1).every((c) => c.tool_choice?.type === "auto")).toBe(true);
    expect(reply.stopped).toBe("step_limit");
    expect(reply.text).toMatch(/step limit/);
  });

  it("returns invalid tool input to the model as an error instead of crashing", async () => {
    const { createMessage, calls } = scripted([
      message([toolUse("bad", { query: 42 })], "tool_use"),
      message([text("Sorry, retrying gave me nothing.")], "end_turn"),
    ]);
    await runChatTurn({ createMessage, model: "m", workflows, history });
    const result = (calls[1].messages.at(-1)!.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/Invalid input/);
  });

  it("rejects calls to tools that don't exist", async () => {
    const { createMessage, calls } = scripted([
      message([toolUse("x", { cmd: "rm -rf /" }, "run_shell")], "tool_use"),
      message([text("ok")], "end_turn"),
    ]);
    await runChatTurn({ createMessage, model: "m", workflows, history });
    const result = (calls[1].messages.at(-1)!.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[])[0];
    expect(result).toMatchObject({ is_error: true, content: 'Unknown tool "run_shell".' });
  });

  it("handles a refusal without exposing partial content", async () => {
    const { createMessage } = scripted([message([text("partial")], "refusal")]);
    const reply = await runChatTurn({ createMessage, model: "m", workflows, history });
    expect(reply.stopped).toBe("refusal");
    expect(reply.text).not.toContain("partial");
    expect(reply.workflows).toEqual([]);
  });

  it("system prompt forbids inventing workflows and running planned ones", async () => {
    const { createMessage, calls } = scripted([message([text("ok")], "end_turn")]);
    await runChatTurn({ createMessage, model: "m", workflows, history });
    expect(calls[0].system).toMatch(/Never invent workflow names or IDs/);
    expect(calls[0].system).toMatch(/cannot run yet/);
  });
});

describe("extractWorkflowRefs", () => {
  it("dedupes and ignores non-id code spans", () => {
    const { found, unknown } = extractWorkflowRefs("`market-research` and `market-research`, plus `npm` and `fake-flow`", workflows);
    expect(found.map((w) => w.id)).toEqual(["market-research"]);
    expect(unknown).toEqual(["fake-flow"]);
  });
});

describe("recommend_workflows", () => {
  it("turns a valid call into recommendation cards and keeps them out of the mentions list", async () => {
    const { createMessage } = scripted([
      message([toolUse("s", { query: "customers", category: null })], "tool_use"),
      message(
        [
          toolUse("r", {
            recommendations: [
              { workflow_id: "outbound-sequence", reason: "You need outbound without a sales team." },
              { workflow_id: "icp-builder", reason: "Defines who to target first." },
            ],
          }, "recommend_workflows"),
        ],
        "tool_use",
      ),
      message([text("Pick `outbound-sequence` and `icp-builder`; `market-research` helps too.")], "end_turn"),
    ]);
    const reply = await runChatTurn({ createMessage, model: "m", workflows, history });
    expect(reply.recommendations.map((r) => r.workflow.id)).toEqual(["outbound-sequence", "icp-builder"]);
    expect(reply.recommendations[0].reason).toMatch(/outbound/);
    expect(reply.recommendations[0].workflow.requires).toEqual(["icp-builder"]);
    expect(reply.workflows.map((w) => w.id)).toEqual(["market-research"]);
  });

  it("rejects the whole call when any id is invented, and tells the model which", async () => {
    const { createMessage, calls } = scripted([
      message([toolUse("r", { recommendations: [{ workflow_id: "icp-builder", reason: "x" }, { workflow_id: "viral-loop", reason: "y" }] }, "recommend_workflows")], "tool_use"),
      message([text("Sorry.")], "end_turn"),
    ]);
    const reply = await runChatTurn({ createMessage, model: "m", workflows, history });
    expect(reply.recommendations).toEqual([]);
    const result = (calls[1].messages.at(-1)!.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[])[0];
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toMatch(/viral-loop/);
  });

  it("dedupes repeated ids and enforces the size limit", () => {
    const recs = parseRecommendations({ recommendations: [{ workflow_id: "icp-builder", reason: "a" }, { workflow_id: "icp-builder", reason: "b" }] }, workflows);
    expect(recs).toHaveLength(1);
    const seven = Array.from({ length: 7 }, () => ({ workflow_id: "icp-builder", reason: "r" }));
    expect(() => parseRecommendations({ recommendations: seven }, workflows)).toThrow(/Invalid input/);
  });
});

describe("message input and history window", () => {
  it("rejects empty and oversized messages", () => {
    expect(MessageInputSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(MessageInputSchema.safeParse({ content: "x".repeat(9000) }).success).toBe(false);
    expect(MessageInputSchema.safeParse({}).success).toBe(false);
    expect(MessageInputSchema.safeParse({ content: "hello" }).success).toBe(true);
  });

  it("keeps the last messages and always starts on a user turn", () => {
    const msgs = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `${i}` }));
    const window = historyWindow(msgs);
    expect(window.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    expect(window[0].role).toBe("user");
    expect(window.at(-1)).toEqual(msgs.at(-1));
  });
});
