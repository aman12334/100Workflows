import type { Workflow } from "@/lib/catalog/schema";

/** A minimal valid workflow definition; tests override fields to make it invalid. */
export function workflowData(overrides: Record<string, unknown> = {}) {
  return {
    id: "demo-flow",
    version: "0.1.0",
    name: "Demo Flow",
    category: "gtm",
    summary: "A demo workflow.",
    description: "Used in tests.",
    status: "planned",
    problems: ["I need a demo"],
    tags: ["demo"],
    inputs: [{ key: "goal", label: "Goal", type: "text", required: true, description: "What you want." }],
    outputs: [{ key: "result", label: "Result", description: "The result.", format: "markdown" }],
    steps: [{ id: "do_it", name: "Do it", kind: "agent", responsibility: "Does the thing.", tools: [] }],
    evaluation: { criteria: [{ id: "valid", description: "Valid.", method: "schema", critical: true }], threshold: 0.7 },
    limits: { maxRetries: 1, timeoutSeconds: 60, maxModelCalls: 3 },
    ...overrides,
  };
}

export function entry(overrides: Record<string, unknown> = {}) {
  const data = workflowData(overrides);
  return { file: `${data.id}.json`, data };
}

export type { Workflow };
