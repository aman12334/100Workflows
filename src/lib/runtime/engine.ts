import type { Workflow } from "@/lib/catalog/schema";
import { Budget, LimitError, type Usage } from "./budget";
import { evaluate, feedbackFor, type CriterionResult, type Evaluation } from "./evaluation";
import { COMMON_PARAMS, OutputInvalidError, type CreateMessage, type CreateParams, type Message } from "./model";
import { ToolRunner, toolLimitsFor, type ToolCallRecord, type ToolOverrides } from "./tools/runner";

/**
 * The workflow runtime: a small, explicit state machine.
 *
 *   prepare (once) ─▶ produce ─▶ check ─▶ evaluate ─┬─ accept ───▶ succeeded
 *                       ▲                           ├─ retry ────▶ produce again with feedback
 *                       └───────────────────────────┘
 *                                                   └─ escalate ─▶ needs_review (best output kept) or failed
 *
 * Termination is guaranteed: at most `maxRetries + 1` attempts, every model call
 * is counted against `maxModelCalls`, and a wall-clock deadline applies.
 */

export interface Confidence {
  /** A heuristic about the evidence behind the output. Not a calibrated probability. */
  level: "low" | "medium" | "high";
  basis: string[];
}

export interface UpstreamOutput {
  workflowId: string;
  version: string;
  output: unknown;
}

export interface StepHandle {
  done(detail?: string, usage?: Usage): void;
  fail(error: string, usage?: Usage): void;
}

/** Where the engine writes its trace. The run service persists it; tests keep it in memory. */
export interface Recorder {
  step(stepId: string, kind: "agent" | "check", attempt: number): StepHandle;
  evaluation(evaluation: Evaluation): void;
  /** Optional: one record per tool call (see tools/runner.ts). */
  tool?(call: ToolCallRecord): void;
}

export interface ExecContext {
  workflow: Workflow;
  inputs: Record<string, unknown>;
  upstream: Record<string, UpstreamOutput>;
  attempt: number;
  budget: Budget;
  /** A budgeted model call. Model, fallbacks and limits are filled in. */
  call(params: Omit<CreateParams, "model">): Promise<Message>;
  /** Runs `fn` as a traced step. `stepId` must be one of the manifest's steps. */
  step<T>(stepId: string, fn: () => Promise<{ value: T; detail?: string }>): Promise<T>;
  /** Registered, allowlisted tools for this execution; budgets span all attempts. */
  tools: ToolRunner;
  signal?: AbortSignal;
}

/** Honest, non-retryable failure (e.g. search found no sources). Never papered over with invented content. */
export class WorkflowFailure extends Error {}

export interface Executor<State = unknown, Output = unknown> {
  workflowId: string;
  /** Definition lines (major.minor, e.g. "0.2") this code implements. Other versions can't run here. */
  versions: string[];
  /** Model calls one produce + check attempt needs; used to decide whether a retry fits the budget. */
  callsPerAttempt: number;
  /** Returns a reason when the workflow can't run in this environment (e.g. a tool isn't configured). */
  preflight(env: Record<string, string | undefined>): string | null;
  prepare(ctx: ExecContext): Promise<State>;
  produce(ctx: ExecContext, state: State, feedback: string | null): Promise<Output>;
  check(ctx: ExecContext, state: State, output: Output): Promise<CriterionResult[]>;
  confidence(state: State, output: Output, evaluation: Evaluation): Confidence;
  render(state: State, output: Output): { json: unknown; markdown: string };
  /**
   * Optional: when no attempt produced an acceptable output (or a model call failed),
   * return a result built only from deterministic work done in prepare, e.g. the
   * calculated numbers without the model's explanation. The run ends as needs_review.
   */
  salvage?(state: State, reason: string): { json: unknown; markdown: string; note: string } | null;
}

export type WorkflowStatus = "succeeded" | "needs_review" | "failed" | "cancelled";

export interface WorkflowOutcome {
  status: WorkflowStatus;
  reason?: string;
  attempts: number;
  qualityScore: number | null;
  decision: Evaluation["decision"] | null;
  confidence: Confidence | null;
  result: { json: unknown; markdown: string } | null;
  usage: Usage;
}

export interface ExecuteOptions {
  workflow: Workflow;
  executor: Executor<any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  inputs: Record<string, unknown>;
  upstream: Record<string, UpstreamOutput>;
  createMessage: CreateMessage;
  model: string;
  recorder: Recorder;
  signal?: AbortSignal;
  describeError?: (err: unknown) => string;
  now?: () => number;
  /** Environment for tool availability checks. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Test seam: replaces tool transports (never the allowlist, validation or budgets). */
  toolOverrides?: ToolOverrides;
  /** Per-tool limits from the definition, applied on top of each tool's own limit. */
  toolLimits?: Record<string, number>;
}

const SCHEMA_CRITERION = "schema_valid";

export async function executeWorkflow(opts: ExecuteOptions): Promise<WorkflowOutcome> {
  const { workflow, executor, recorder } = opts;
  const budget = new Budget(workflow.limits.maxModelCalls, workflow.limits.timeoutSeconds, opts.signal, opts.now);
  const maxRetries = workflow.limits.maxRetries;
  let attempt = 0;
  let attemptsMade = 0;
  let best: { state: unknown; output: unknown; evaluation: Evaluation } | null = null;
  let state: unknown;

  const call = async (params: Omit<CreateParams, "model">) => {
    budget.beforeCall();
    const response = await opts.createMessage(
      { ...COMMON_PARAMS, ...params, model: opts.model } as CreateParams,
      { signal: opts.signal, timeout: budget.remainingMs },
    );
    budget.record(response.usage);
    return response;
  };
  const tools = new ToolRunner({
    workflow,
    env: opts.env ?? process.env,
    signal: opts.signal,
    callModel: call,
    record: recorder.tool ? (c) => recorder.tool!(c) : undefined,
    overrides: opts.toolOverrides,
    limits: opts.toolLimits ?? toolLimitsFor(workflow),
    now: opts.now,
  });

  const ctx = (): ExecContext => ({
    workflow,
    inputs: opts.inputs,
    upstream: opts.upstream,
    attempt,
    budget,
    tools,
    signal: opts.signal,
    call,
    step: async (stepId, fn) => {
      const def = workflow.steps.find((s) => s.id === stepId);
      if (!def) throw new Error(`Executor used step "${stepId}", which ${workflow.id}@${workflow.version} does not declare.`);
      budget.check();
      const before = { ...budget.usage };
      const handle = recorder.step(stepId, def.kind, attempt);
      const delta = () => ({
        inputTokens: budget.usage.inputTokens - before.inputTokens,
        outputTokens: budget.usage.outputTokens - before.outputTokens,
        modelCalls: budget.usage.modelCalls - before.modelCalls,
        webSearches: budget.usage.webSearches - before.webSearches,
      });
      try {
        const { value, detail } = await fn();
        handle.done(detail, delta());
        return value;
      } catch (err) {
        handle.fail(err instanceof Error ? err.message : String(err), delta());
        throw err;
      }
    },
  });

  const finish = (status: WorkflowStatus, reason?: string): WorkflowOutcome => {
    const chosen = best;
    return {
      status,
      reason,
      attempts: attemptsMade,
      qualityScore: chosen?.evaluation.score ?? null,
      decision: chosen?.evaluation.decision ?? null,
      confidence: chosen ? executor.confidence(chosen.state, chosen.output, chosen.evaluation) : null,
      result: chosen ? executor.render(chosen.state, chosen.output) : null,
      usage: { ...budget.usage },
    };
  };

  /** Deterministic results, kept when the model part couldn't produce an acceptable output. */
  const salvaged = (reason: string): WorkflowOutcome | null => {
    if (best || state === undefined || !executor.salvage) return null;
    const result = executor.salvage(state, reason);
    if (!result) return null;
    return { status: "needs_review", reason: `${reason} ${result.note}`, attempts: attemptsMade, qualityScore: null, decision: null, confidence: null, result: { json: result.json, markdown: result.markdown }, usage: { ...budget.usage } };
  };

  try {
    state = await executor.prepare(ctx());
    let feedback: string | null = null;

    for (attempt = 0; attempt <= maxRetries; attempt++) {
      let output: unknown;
      let results: CriterionResult[];
      attemptsMade++;
      try {
        output = await executor.produce(ctx(), state, feedback);
        const checks = await executor.check(ctx(), state, output);
        const hasSchema = workflow.evaluation.criteria.some((c) => c.id === SCHEMA_CRITERION);
        results = hasSchema && !checks.some((c) => c.id === SCHEMA_CRITERION)
          ? [{ id: SCHEMA_CRITERION, passed: true, score: 1, detail: "Output matched the schema." }, ...checks]
          : checks;
      } catch (err) {
        if (!(err instanceof OutputInvalidError)) throw err;
        output = undefined;
        // Nothing else can be judged on an output that doesn't parse.
        results = workflow.evaluation.criteria.map((c) =>
          c.id === SCHEMA_CRITERION
            ? { id: c.id, passed: false, score: 0, detail: err.message }
            : { id: c.id, passed: false, score: 0, detail: "Not evaluated: the output did not match the schema.", skipped: true },
        );
      }

      const canRetry = budget.remainingCalls >= executor.callsPerAttempt && budget.remainingMs > 5_000;
      const evaluation = evaluate(workflow, results, { attempt, maxRetries, canRetry });
      recorder.evaluation(evaluation);

      if (output !== undefined && (!best || (evaluation.score ?? -1) > (best.evaluation.score ?? -1) || evaluation.passed)) {
        best = { state, output, evaluation };
      }
      if (evaluation.decision === "accept") return finish("succeeded");
      if (evaluation.decision === "escalate") {
        const why = evaluation.criticalFailures.length
          ? `Critical checks failed: ${evaluation.criticalFailures.join(", ")}.`
          : `Quality score ${evaluation.score?.toFixed(2) ?? "n/a"} is below the ${evaluation.threshold} threshold.`;
        const limit = attempt < maxRetries ? " Not enough budget left for another attempt." : ` Retried ${maxRetries} time(s).`;
        if (best) return finish("needs_review", `${why}${limit} Review the best attempt before relying on it.`);
        return salvaged(`${why}${limit}`) ?? finish("failed", `${why}${limit} No usable output was produced.`);
      }
      feedback = feedbackFor(evaluation);
    }
    return finish("failed", "Retry loop ended without a decision."); // unreachable: the last attempt always escalates
  } catch (err) {
    if (err instanceof LimitError) {
      if (err.kind === "cancelled") return finish("cancelled", err.message);
      return best ? finish("needs_review", `${err.message} Showing the best attempt so far.`) : (salvaged(err.message) ?? finish("failed", err.message));
    }
    if (opts.signal?.aborted) return finish("cancelled", "The run was cancelled.");
    if (err instanceof WorkflowFailure) return finish("failed", err.message);
    const message = opts.describeError ? opts.describeError(err) : err instanceof Error ? err.message : "Unexpected error.";
    return salvaged(message) ?? finish("failed", message);
  }
}
