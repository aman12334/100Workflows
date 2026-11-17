import type { Workflow } from "@/lib/catalog/schema";
import { LimitError } from "../budget";
import type { CreateParams, Message } from "../model";
import { safeFetch, type PageTransport } from "./http-fetch";
import { TOOLS, type ToolDefinition } from "./registry";
import { UrlRejected } from "./url-guard";

/**
 * Every tool call goes through ToolRunner.run(). It enforces, in order:
 *   1. allowlist   the tool is registered, the workflow declares it, and the calling step lists it
 *   2. availability the environment provides it (opt-in flags, provider support)
 *   3. budget      per-tool limit for this workflow execution (the smaller of the tool's and the definition's)
 *   4. input       validated against the tool's schema; model- or user-supplied values can't skip this
 *   5. execution   per-attempt timeout, cancellation, retries only for retryable errors
 *   6. output      validated against the tool's output schema (a malformed result is an error, never passed on)
 *   7. logging     one record per call: tool, version, status, attempts, timing, sizes, error
 */

export type ToolErrorKind = "not_allowed" | "unavailable" | "budget" | "invalid_input" | "rejected_url" | "timeout" | "failed" | "malformed_output" | "cancelled";

export class ToolError extends Error {
  constructor(
    readonly kind: ToolErrorKind,
    readonly toolId: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ToolCallRecord {
  stepId: string;
  toolId: string;
  toolVersion: string;
  status: "ok" | "error";
  errorKind: ToolErrorKind | null;
  error: string | null;
  attempts: number;
  target: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
}

export interface ToolOverrides {
  /** Replaces the network transport for web-fetch (tests use canned pages). */
  transport?: PageTransport;
}

export interface ToolRunnerOptions {
  workflow: Workflow;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  callModel(params: Omit<CreateParams, "model">): Promise<Message>;
  record?(call: ToolCallRecord): void;
  overrides?: ToolOverrides;
  /** Extra per-tool limits from the definition (e.g. maxPages), applied on top of each tool's own limit. */
  limits?: Record<string, number>;
  now?: () => number;
}

const bytes = (v: unknown) => {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
  } catch {
    return 0;
  }
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new LimitError("The run was cancelled.", "cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new LimitError("The run was cancelled.", "cancelled"))), { once: true });
  });

/** Per-tool limits a definition sets through its gather step (pages to read, one search request). */
export function toolLimitsFor(workflow: Workflow): Record<string, number> {
  const g = workflow.steps.find((s) => s.mode === "gather")?.gather;
  return { ...(g?.search ? { "web-search": 1 } : {}), ...(g?.fetch ? { "web-fetch": g.fetch.maxPages } : {}) };
}

export class ToolRunner {
  private readonly counts = new Map<string, number>();
  readonly calls: ToolCallRecord[] = [];

  constructor(private readonly opts: ToolRunnerOptions) {}

  /** How many more calls of this tool this execution may make. */
  remaining(toolId: string): number {
    const tool = TOOLS[toolId];
    if (!tool) return 0;
    const limit = Math.min(tool.maxCallsPerRun, this.opts.limits?.[toolId] ?? Infinity);
    return Math.max(0, limit - (this.counts.get(toolId) ?? 0));
  }

  async run<O = unknown>(stepId: string, toolId: string, rawInput: unknown): Promise<O> {
    const now = this.opts.now ?? Date.now;
    const started = now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool: ToolDefinition<any, any> | undefined = Object.hasOwn(TOOLS, toolId) ? TOOLS[toolId] : undefined;
    let attempts = 0;
    let target = "";
    const log = (status: "ok" | "error", output: unknown, err: ToolError | null) => {
      const record: ToolCallRecord = {
        stepId,
        toolId,
        toolVersion: tool?.version ?? "unknown",
        status,
        errorKind: err?.kind ?? null,
        error: err ? err.message.slice(0, 500) : null,
        attempts,
        target,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(now()).toISOString(),
        durationMs: Math.max(0, now() - started),
        inputBytes: bytes(rawInput),
        outputBytes: output === undefined ? 0 : bytes(output),
      };
      this.calls.push(record);
      this.opts.record?.(record);
    };
    const fail = (kind: ToolErrorKind, message: string): never => {
      const err = new ToolError(kind, toolId, message);
      log("error", undefined, err);
      throw err;
    };

    // 1. allowlist
    if (!tool) return fail("not_allowed", `"${toolId}" is not a registered tool`);
    const step = this.opts.workflow.steps.find((s) => s.id === stepId);
    if (!this.opts.workflow.tools.some((t) => t.id === toolId) || !step?.tools.includes(toolId)) {
      return fail("not_allowed", `${this.opts.workflow.id} step "${stepId}" does not declare tool "${toolId}"`);
    }
    // 2. availability
    const unavailable = tool.availability(this.opts.env);
    if (unavailable) return fail("unavailable", unavailable);
    // 3. budget
    if (this.remaining(toolId) <= 0) return fail("budget", `the ${toolId} limit for this workflow run is used up`);
    // 4. input
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) return fail("invalid_input", `invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`);
    target = tool.target(parsed.data);
    this.counts.set(toolId, (this.counts.get(toolId) ?? 0) + 1);

    // 5. execution with timeout, cancellation and retries
    let lastError: unknown;
    for (attempts = 1; attempts <= tool.retry.attempts; attempts++) {
      if (this.opts.signal?.aborted) return fail("cancelled", "the run was cancelled");
      const timeout = AbortSignal.timeout(tool.timeoutMs);
      const signal = this.opts.signal ? AbortSignal.any([this.opts.signal, timeout]) : timeout;
      try {
        const result = await Promise.race([
          tool.execute(parsed.data, { signal, transport: this.opts.overrides?.transport ?? safeFetch, callModel: this.opts.callModel }),
          new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
        ]);
        // 6. output
        const out = tool.output.safeParse(result);
        if (!out.success) return fail("malformed_output", `the tool returned malformed data: ${out.error.issues[0]?.message ?? "invalid"}`);
        log("ok", out.data, null);
        return out.data as O;
      } catch (err) {
        if (err instanceof LimitError) {
          // Model budget, time limit or cancellation: logged here, decided by the engine.
          log("error", undefined, new ToolError(err.kind === "cancelled" ? "cancelled" : "budget", toolId, err.message));
          throw err;
        }
        if (this.opts.signal?.aborted) return fail("cancelled", "the run was cancelled");
        if (err instanceof UrlRejected) return fail("rejected_url", `URL not allowed: ${err.message}`);
        if (timeout.aborted) {
          lastError = new ToolError("timeout", toolId, `timed out after ${tool.timeoutMs / 1000}s`);
        } else {
          lastError = err;
          if (!tool.retryable(err)) break;
        }
        if (attempts < tool.retry.attempts) await sleep(tool.retry.backoffMs * attempts, this.opts.signal);
      }
    }
    attempts = Math.min(attempts, tool.retry.attempts);
    if (lastError instanceof ToolError) return fail(lastError.kind, lastError.message);
    return fail("failed", lastError instanceof Error ? lastError.message : String(lastError));
  }
}
