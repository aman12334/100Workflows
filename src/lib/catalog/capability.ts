import type { Workflow } from "./schema";

/** What a workflow needs to run, for discovery filters. Derived from the definition; nothing is stored. */
export type Capability = "model" | "research" | "calculation" | "integration";

export const CAPABILITY_LABELS: Record<Capability, string> = {
  model: "Model only",
  research: "Web research",
  calculation: "Calculations",
  integration: "Connects to apps",
};

export function capabilityOf(w: Workflow): Capability {
  if (w.integrations.length > 0) return "integration";
  if (w.steps.some((s) => s.calculate)) return "calculation";
  if (w.tools.length > 0 || w.steps.some((s) => s.mode === "gather")) return "research";
  return "model";
}
