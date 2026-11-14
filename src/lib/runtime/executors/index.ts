import { validateGenericDefinition } from "@/lib/catalog/catalog";
import type { Workflow } from "@/lib/catalog/schema";
import type { Executor } from "../engine";
import { createGenericExecutor } from "./generic";
import { icpBuilder } from "./icp-builder";
import { marketResearch } from "./market-research";

/**
 * Hand-written executors, for workflows that need code (tools, custom checks).
 * Definitions stay data in catalog/workflows; this behavior is reviewed with the
 * app's code. Schema-v2 definitions without an entry here run on the generic executor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EXECUTORS: Record<string, Executor<any, any>> = {
  [marketResearch.workflowId]: marketResearch,
  [icpBuilder.workflowId]: icpBuilder,
};

/**
 * Executors declare the major.minor lines they implement ("0.2"). Patch releases
 * of a definition (wording, examples) run on the same code; a minor or major bump
 * signals a behavioral change that needs an executor update.
 */
export function implementsVersion(executor: Executor<unknown, unknown>, version: string): boolean {
  return executor.versions.some((line) => version === line || version.startsWith(`${line}.`));
}

function isGenericDefinition(workflow: Workflow): boolean {
  return workflow.schemaVersion === 2 && workflow.execution?.engine === "generic";
}

/**
 * The executor for this exact (possibly pinned) definition:
 *  1. a hand-written executor that implements its version,
 *  2. otherwise the generic executor, for schema-v2 generic definitions,
 *  3. otherwise the hand-written executor anyway (so runnability can explain the version mismatch), or null.
 * The generic executor reads its whole configuration from the definition, so an
 * older pinned version keeps running with the configuration it was pinned with.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveExecutor(workflow: Workflow): Executor<any, any> | null {
  const handWritten = EXECUTORS[workflow.id];
  if (handWritten && implementsVersion(handWritten, workflow.version)) return handWritten;
  if (isGenericDefinition(workflow) && validateGenericDefinition(workflow).length === 0) return createGenericExecutor(workflow);
  return handWritten ?? null;
}

export type Runnability = { runnable: true } | { runnable: false; reason: string };

/** Can this exact pinned definition run? Checks status, executor, version and configuration together. */
export function runnability(workflow: Workflow, env: Record<string, string | undefined> = process.env): Runnability {
  if (workflow.status !== "available") {
    return { runnable: false, reason: "Definition only. This workflow can't be executed yet." };
  }
  if (isGenericDefinition(workflow) && !EXECUTORS[workflow.id]) {
    // Pinned snapshots are re-checked: a rule they rely on might no longer exist.
    const problems = validateGenericDefinition(workflow);
    if (problems.length) {
      return { runnable: false, reason: `This pinned definition can no longer run: ${problems[0]}. Update the workflow to run it.` };
    }
  }
  const executor = resolveExecutor(workflow);
  if (!executor) return { runnable: false, reason: "Definition only. This workflow can't be executed yet." };
  if (!implementsVersion(executor, workflow.version)) {
    return {
      runnable: false,
      reason: `This package is pinned to v${workflow.version}, but the runtime implements v${executor.versions.map((v) => `${v}.x`).join(", v")}. Update the workflow to run it.`,
    };
  }
  const blocked = executor.preflight(env);
  return blocked ? { runnable: false, reason: blocked } : { runnable: true };
}
