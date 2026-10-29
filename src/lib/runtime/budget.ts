/**
 * Hard limits for one workflow execution. Every model call goes through
 * `beforeCall`, so no workflow can exceed its manifest's call count or time limit.
 */

export class LimitError extends Error {
  constructor(
    message: string,
    readonly kind: "model_calls" | "timeout" | "cancelled",
  ) {
    super(message);
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  webSearches: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, modelCalls: 0, webSearches: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    modelCalls: a.modelCalls + b.modelCalls,
    webSearches: a.webSearches + b.webSearches,
  };
}

export class Budget {
  readonly usage: Usage = emptyUsage();
  private readonly deadline: number;

  constructor(
    readonly maxModelCalls: number,
    timeoutSeconds: number,
    private readonly signal?: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + timeoutSeconds * 1000;
  }

  get remainingCalls() {
    return this.maxModelCalls - this.usage.modelCalls;
  }

  get remainingMs() {
    return Math.max(0, this.deadline - this.now());
  }

  /** Throws if the run was cancelled, timed out, or used up its model calls. */
  check() {
    if (this.signal?.aborted) throw new LimitError("The run was cancelled.", "cancelled");
    if (this.remainingMs <= 0) throw new LimitError("The workflow hit its time limit.", "timeout");
  }

  beforeCall() {
    this.check();
    if (this.remainingCalls <= 0) throw new LimitError(`The workflow used all ${this.maxModelCalls} model calls it is allowed.`, "model_calls");
    this.usage.modelCalls++;
  }

  record(u: { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests?: number } | null }) {
    this.usage.inputTokens += u.input_tokens;
    this.usage.outputTokens += u.output_tokens;
    this.usage.webSearches += u.server_tool_use?.web_search_requests ?? 0;
  }
}
