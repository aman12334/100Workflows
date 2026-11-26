import type { Workflow } from "@/lib/catalog/schema";
import { runnability } from "@/lib/runtime/executors";
import type { AvailabilityInfo } from "@/lib/catalog/availability";
import { getModelConfig } from "./config";

export type { Availability, AvailabilityInfo } from "@/lib/catalog/availability";

export function availabilityOf(workflow: Workflow, env: Record<string, string | undefined> = process.env): AvailabilityInfo {
  if (workflow.status !== "available") return { state: "definition", reason: "Definition only. It can be discovered, but not run yet." };
  const r = runnability(workflow, env);
  if (!r.runnable) return { state: "setup", reason: r.reason };
  const config = getModelConfig(env);
  if (!config.configured) return { state: "setup", reason: config.problem ?? "The model is not configured." };
  return { state: "ready", reason: null };
}

export function availabilityMap(workflows: Workflow[], env: Record<string, string | undefined> = process.env): Record<string, AvailabilityInfo> {
  return Object.fromEntries(workflows.map((w) => [w.id, availabilityOf(w, env)]));
}
