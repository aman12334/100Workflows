import "server-only";
import type { Workflow } from "@/lib/catalog/schema";
import { fetchTransport } from "@/lib/integrations/core";
import type { Golden } from "@/lib/quality/golden";
import type { WorkflowProfile } from "@/lib/quality/profile";
import type { Fingerprint } from "@/lib/quality/types";
import { executeWorkflow, type Recorder } from "@/lib/runtime/engine";
import type { Evaluation } from "@/lib/runtime/evaluation";
import { resolveExecutor, runnability } from "@/lib/runtime/executors";
import type { CreateMessage } from "@/lib/runtime/model";
import { estimateCostUsd, pricingFor } from "@/lib/runtime/pricing";
import type { ToolCallRecord } from "@/lib/runtime/tools/runner";
import type { DB } from "@/lib/server/db";
import { getModelConfig } from "@/lib/server/config";
import { mapModelError } from "@/lib/server/model-client";
import { recordLiveExecution } from "./service";
import { finishQualityRun, startQualityRun, storeOutput } from "./store";

/**
 * Controlled live verification: runs ONE golden scenario against the real configured model
 * (and real tools or provider reads where the workflow uses them). It spends credits, so it
 * must only be called after the person approved that spend. It never approves or executes
 * proposed actions: integration workflows only read and propose here.
 */

/** Worst case in tokens and, where the price is verified, dollars. Shown before asking for approval. */
export function liveCostCeiling(profile: WorkflowProfile, model: string) {
  const calls = profile.limits.maxModelCalls ?? 6;
  const outTokens = calls * (profile.limits.maxOutputTokens ?? 8000);
  const inTokens = calls * 30_000; // generous allowance for prompt, inputs and sources per call
  const price = pricingFor(model);
  return { calls, inTokens, outTokens, usd: price ? estimateCostUsd({ inputTokens: inTokens, outputTokens: outTokens }, price) : null };
}

export interface LiveTarget {
  wf: Workflow;
  profile: WorkflowProfile;
  fingerprint: Fingerprint;
  golden: Golden;
}

export function liveProblems(t: LiveTarget, scenarioId: string, env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const scenario = t.golden.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) problems.push(`no scenario "${scenarioId}" in quality/golden/${t.wf.id}.json`);
  else if (!scenario.live) problems.push(`scenario "${scenarioId}" is not marked safe for live runs`);
  if (!getModelConfig(env).configured) problems.push("no model key is configured");
  const r = runnability(t.wf, env);
  if (!r.runnable) problems.push(r.reason);
  return problems;
}

export async function runLive(db: DB, t: LiveTarget, scenarioId: string, deps: { createMessage: CreateMessage; env?: Record<string, string | undefined> }) {
  const env = deps.env ?? process.env;
  const problems = liveProblems(t, scenarioId, env);
  if (problems.length) throw new Error(`Can't run live: ${problems.join("; ")}.`);
  const scenario = t.golden.scenarios.find((s) => s.id === scenarioId)!;
  const config = getModelConfig(env);
  const runId = startQualityRun(db, "live");
  const evaluations: Evaluation[] = [];
  const tools: ToolCallRecord[] = [];
  const recorder: Recorder = { step: () => ({ done: () => undefined, fail: () => undefined }), evaluation: (e) => evaluations.push(e), tool: (c) => tools.push(c) };
  const started = Date.now();
  const r = await executeWorkflow({
    workflow: t.wf,
    executor: resolveExecutor(t.wf)!,
    inputs: scenario.inputs,
    upstream: {},
    createMessage: deps.createMessage,
    model: config.model,
    recorder,
    env,
    describeError: (err) => mapModelError(err).message,
    integrationTransport: fetchTransport,
  });
  const durationMs = Date.now() - started;
  const out = r.result?.json as { proposed_actions?: unknown[]; retrieved_sources?: unknown[] } | undefined;
  const outputId = storeOutput(db, { qualityRunId: runId, workflowId: t.wf.id, workflowVersion: t.wf.version, scenario: scenarioId, status: r.status, output: r.result?.json, markdown: r.result?.markdown ?? null, fingerprint: t.fingerprint });
  const price = pricingFor(config.model);
  recordLiveExecution(db, runId, t, scenarioId, {
    status: r.status,
    reason: r.reason ?? null,
    output: r.result?.json,
    markdown: r.result?.markdown ?? null,
    criticalFailures: evaluations.at(-1)?.criticalFailures ?? [],
    proposals: out?.proposed_actions?.length ?? 0,
    sources: out?.retrieved_sources?.length ?? 0,
    durationMs,
    usage: r.usage,
    provider: config.provider,
    model: config.model,
    costUsd: price ? estimateCostUsd(r.usage, price) : null,
    toolVersions: [...new Set(tools.map((x) => `${x.toolId}@${x.toolVersion}`))],
    outputId,
  });
  finishQualityRun(db, runId, { workflowId: t.wf.id, scenario: scenarioId, status: r.status, durationMs });
  return { status: r.status, reason: r.reason ?? null, durationMs, usage: r.usage, outputId };
}
