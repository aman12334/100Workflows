import "server-only";
import { formFields, inputsFor, missingRequired, type MissingInput } from "@/lib/packages/inputs";
import { executeWorkflow, type Recorder, type UpstreamOutput } from "@/lib/runtime/engine";
import { resolveExecutor, runnability } from "@/lib/runtime/executors";
import type { CreateMessage } from "@/lib/runtime/model";
import { pricingFor } from "@/lib/runtime/pricing";
import { createMessage as providerCreateMessage, mapModelError } from "./model-client";
import { getModelConfig } from "./config";
import type { DB } from "./db";
import {
  activeRunFor,
  createRun,
  finishRun,
  finishStep,
  finishWorkflowRun,
  getRun,
  insertEvaluation,
  insertStep,
  setWorkflowRunStatus,
  type WorkflowRunStatus,
} from "./db/runs";
import { log } from "./log";
import type { PackageView } from "./package-service";

export interface PreflightItem {
  workflowId: string;
  name: string;
  version: string;
  state: "ready" | "needs_input" | "skip" | "blocked";
  reason: string | null;
}

export interface Preflight {
  canRun: boolean;
  /** Why the run button is disabled, in plain language. */
  summary: string | null;
  items: PreflightItem[];
  missing: MissingInput[];
}

/**
 * Decides, before anything executes, what a run would do with each workflow:
 * run it, skip it (definition only / tool not configured), or block it (missing
 * inputs, or a required upstream workflow can't run).
 */
export function preflight(view: PackageView, env: Record<string, string | undefined> = process.env): Preflight {
  const config = getModelConfig(env);
  const fields = formFields(view.requirements);
  const items: PreflightItem[] = [];
  const state = new Map<string, PreflightItem["state"]>();

  for (const step of view.steps) {
    const wf = step.member.workflow;
    const base = { workflowId: wf.id, name: wf.name, version: wf.version };
    const r = runnability(wf, env);
    if (!r.runnable) {
      items.push({ ...base, state: "skip", reason: r.reason });
      state.set(wf.id, "skip");
      continue;
    }
    const blocker = wf.dependencies.find((d) => d.required && state.has(d.workflowId) && state.get(d.workflowId) !== "ready");
    if (blocker) {
      const name = view.steps.find((s) => s.member.workflow.id === blocker.workflowId)?.member.workflow.name ?? blocker.workflowId;
      items.push({ ...base, state: "blocked", reason: `Needs ${name} to run first, and it can't run in this package yet.` });
      state.set(wf.id, "blocked");
      continue;
    }
    const missing = missingRequired(fields, view.inputs, new Set([wf.id]));
    if (missing.length) {
      items.push({ ...base, state: "needs_input", reason: `Missing: ${missing.map((m) => m.label).join(", ")}.` });
      state.set(wf.id, "needs_input");
      continue;
    }
    items.push({ ...base, state: "ready", reason: null });
    state.set(wf.id, "ready");
  }

  const ready = items.filter((i) => i.state === "ready");
  const runnableIds = new Set(items.filter((i) => i.state === "ready" || i.state === "needs_input").map((i) => i.workflowId));
  const missing = missingRequired(fields, view.inputs, runnableIds);

  let summary: string | null = null;
  if (!config.configured) summary = config.problem ?? "The model is not configured.";
  else if (missing.length) summary = `Fill in ${missing.length} required input${missing.length === 1 ? "" : "s"} in Setup first.`;
  else if (!ready.length) summary = "Nothing in this package can run yet. See the reason next to each workflow.";

  return { canRun: summary === null, summary, items, missing };
}

const globalForRuns = globalThis as unknown as { workflowsActiveRuns?: Map<string, AbortController> };
const active = (globalForRuns.workflowsActiveRuns ??= new Map());

export class RunError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Creates the run and starts it in the background. Returns as soon as the run is recorded. */
export function startRun(db: DB, view: PackageView, deps: { createMessage?: CreateMessage; env?: Record<string, string | undefined> } = {}): string {
  const env = deps.env ?? process.env;
  if (activeRunFor(db, view.pkg.id)) throw new RunError("This package is already running. Wait for it to finish or cancel it.", 409);
  const check = preflight(view, env);
  if (!check.canRun) throw new RunError(check.summary ?? "This package can't run yet.", 409);

  const plan = check.items.map((i) => ({
    workflowId: i.workflowId,
    version: i.version,
    status: (i.state === "ready" ? "pending" : i.state === "skip" ? "skipped" : "blocked") as WorkflowRunStatus,
    reason: i.reason ?? undefined,
  }));
  const config = getModelConfig(env);
  // The price is snapshotted with the run, and only when it is verified (see pricing.ts).
  const { runId, workflowRunIds } = createRun(db, view.pkg.id, plan, { provider: config.provider, model: config.model, pricing: pricingFor(config.model) });
  const controller = new AbortController();
  active.set(runId, controller);
  log.info("run.started", { runId, packageId: view.pkg.id, provider: config.provider, model: config.model, workflows: plan.map((p) => `${p.workflowId}:${p.status}`) });

  void executeRun(db, view, runId, workflowRunIds, controller.signal, deps.createMessage ?? providerCreateMessage, config.model)
    .catch((err) => {
      log.error("run.crashed", { runId, error: err });
      finishRun(db, runId, "failed", "The run stopped because of an internal error. Check the terminal log.");
    })
    .finally(() => active.delete(runId));
  return runId;
}

/** Executes pending workflows one at a time, in the package's dependency order. Exported for tests. */
export async function executeRun(
  db: DB,
  view: PackageView,
  runId: string,
  workflowRunIds: string[],
  signal: AbortSignal,
  createMessage: CreateMessage,
  model: string,
): Promise<void> {
  const outcomes = new Map<string, { status: WorkflowRunStatus; output: unknown; version: string }>();
  const run = getRun(db, runId)!;

  for (const [i, step] of view.steps.entries()) {
    const wf = step.member.workflow;
    const wrId = workflowRunIds[i];
    const planned = run.workflows[i];
    if (planned.status !== "pending") {
      outcomes.set(wf.id, { status: planned.status, output: null, version: wf.version });
      continue;
    }
    if (signal.aborted) {
      setWorkflowRunStatus(db, wrId, "cancelled", "The run was cancelled before this workflow started.");
      continue;
    }
    const failedDep = wf.dependencies.find((d) => d.required && outcomes.has(d.workflowId) && outcomes.get(d.workflowId)!.status !== "succeeded");
    if (failedDep) {
      const depStatus = outcomes.get(failedDep.workflowId)!.status.replace("_", " ");
      setWorkflowRunStatus(db, wrId, "blocked", `${failedDep.workflowId} ended as "${depStatus}", and this workflow requires its output.`);
      outcomes.set(wf.id, { status: "blocked", output: null, version: wf.version });
      continue;
    }

    // Only accepted upstream outputs are handed on, never ones that need review.
    const upstream: Record<string, UpstreamOutput> = {};
    for (const d of wf.dependencies) {
      const o = outcomes.get(d.workflowId);
      if (o?.status === "succeeded") upstream[d.workflowId] = { workflowId: d.workflowId, version: o.version, output: o.output };
    }

    setWorkflowRunStatus(db, wrId, "running");
    const recorder: Recorder = {
      step(stepId, kind, attempt) {
        const id = insertStep(db, wrId, stepId, kind, attempt);
        return {
          done: (detail, usage) => finishStep(db, id, "done", detail ?? null, null, usage),
          fail: (error, usage) => finishStep(db, id, "failed", null, error, usage),
        };
      },
      evaluation: (e) => insertEvaluation(db, wrId, e),
    };

    const outcome = await executeWorkflow({
      workflow: wf,
      // preflight() only marks a workflow "pending" when runnability() found an executor.
      executor: resolveExecutor(wf)!,
      inputs: inputsFor(wf, view.inputs),
      upstream,
      createMessage,
      model,
      recorder,
      signal,
      describeError: (err) => mapModelError(err).message,
    });
    finishWorkflowRun(db, wrId, outcome);
    outcomes.set(wf.id, { status: outcome.status, output: outcome.result?.json ?? null, version: wf.version });
    log.info("run.workflow_finished", {
      runId,
      workflowId: wf.id,
      status: outcome.status,
      attempts: outcome.attempts,
      score: outcome.qualityScore,
      modelCalls: outcome.usage.modelCalls,
      webSearches: outcome.usage.webSearches,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    });
  }

  finishRun(db, runId, signal.aborted ? "cancelled" : "completed");
  const { summary } = getRun(db, runId)!;
  log.info("run.finished", {
    runId,
    status: signal.aborted ? "cancelled" : "completed",
    modelCalls: summary.usage.modelCalls,
    webSearches: summary.usage.webSearches,
    inputTokens: summary.usage.inputTokens,
    outputTokens: summary.usage.outputTokens,
    durationMs: summary.durationMs,
    estimatedCostUsd: summary.costUsd,
  });
}

/** Signals a running run to stop. The current model call is aborted; finished results are kept. */
export function cancelRun(db: DB, runId: string): boolean {
  const controller = active.get(runId);
  if (controller) {
    controller.abort();
    return true;
  }
  const run = getRun(db, runId);
  if (run?.status === "running") {
    // Not in this process (e.g. after a restart): nothing is executing, so mark it.
    finishRun(db, runId, "interrupted", "The run was no longer executing.");
    return true;
  }
  return false;
}
