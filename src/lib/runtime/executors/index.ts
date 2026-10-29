import type { Workflow } from "@/lib/catalog/schema";
import type { Executor } from "../engine";
import { icpBuilder } from "./icp-builder";
import { marketResearch } from "./market-research";

/**
 * Workflows the runtime can execute. Definitions stay data in catalog/workflows;
 * behavior lives here, reviewed with the app's code. A definition marked
 * "available" without an executor below is never run.
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

export type Runnability = { runnable: true } | { runnable: false; reason: string };

/** Can this exact pinned definition run? Checks status, executor and version together. */
export function runnability(workflow: Workflow, env: Record<string, string | undefined> = process.env): Runnability {
  const executor = EXECUTORS[workflow.id];
  if (workflow.status !== "available" || !executor) {
    return { runnable: false, reason: "Definition only. This workflow can't be executed yet." };
  }
  if (!implementsVersion(executor, workflow.version)) {
    return {
      runnable: false,
      reason: `This package is pinned to v${workflow.version}, but the runtime implements v${executor.versions.map((v) => `${v}.x`).join(", v")}. Update the workflow to run it.`,
    };
  }
  const blocked = executor.preflight(env);
  return blocked ? { runnable: false, reason: blocked } : { runnable: true };
}
