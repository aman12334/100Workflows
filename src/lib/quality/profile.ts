import type { Workflow } from "@/lib/catalog/schema";
import type { ExecutionType } from "./types";

/** What a workflow is and what it needs, derived from its definition only. */
export interface WorkflowProfile {
  id: string;
  name: string;
  category: string;
  version: string;
  executable: boolean;
  handWritten: boolean;
  executionType: ExecutionType;
  /** Agent (model) steps: more than one producing step makes it multi-agent. */
  agentSteps: number;
  hasModelReview: boolean;
  tools: string[];
  usesWebSearch: boolean;
  usesWebFetch: boolean;
  calculation: string | null;
  integrations: string[];
  /** Registered actions it reads or proposes, as "<provider>.<action>@<version>". */
  actions: string[];
  /** Read-only actions it runs during the workflow (before drafting). */
  reads: string[];
  /** Setting names it needs beyond the model key (never values). */
  credentials: string[];
  inputs: Array<{ key: string; type: string; required: boolean }>;
  outputs: string[];
  dependencies: Array<{ workflowId: string; required: boolean }>;
  limits: { maxModelCalls: number | null; maxRetries: number; timeoutSeconds: number; maxOutputTokens: number | null };
}

const TOOL_SETTINGS: Record<string, string> = { "web-search": "WORKFLOWS_WEB_SEARCH=on", "web-fetch": "WORKFLOWS_WEB_FETCH=on" };

export function workflowProfile(wf: Workflow, opts: { handWritten: boolean; providerSettings?: Record<string, string[]> }): WorkflowProfile {
  const producing = wf.steps.filter((s) => s.kind === "agent" && s.mode);
  const reviews = wf.evaluation.criteria.filter((c) => c.method === "model");
  const calc = wf.steps.find((s) => s.calculate)?.calculate?.calculation ?? null;
  const gather = wf.steps.find((s) => s.mode === "gather")?.gather;
  const actions = [...wf.steps.flatMap((s) => s.reads ?? []).map((r) => r.action), ...wf.steps.flatMap((s) => s.propose ?? []).map((p) => p.action)];
  const tools = wf.tools.map((t) => t.id);
  const executionType: ExecutionType = wf.integrations.length
    ? "integration"
    : calc
      ? "calculation"
      : tools.length || gather
        ? "research"
        : opts.handWritten || producing.length > 1
          ? "multi_agent"
          : "model";
  const credentials = [
    ...tools.map((t) => TOOL_SETTINGS[t]).filter(Boolean),
    ...(gather?.search ? [TOOL_SETTINGS["web-search"]] : []),
    ...(gather?.fetch ? [TOOL_SETTINGS["web-fetch"]] : []),
    ...wf.integrations.flatMap((i) => opts.providerSettings?.[i.id] ?? []),
  ];
  const outputSchema = wf.outputSchema as { type?: string; properties?: Record<string, unknown> } | undefined;
  return {
    id: wf.id,
    name: wf.name,
    category: wf.category,
    version: wf.version,
    executable: wf.status === "available",
    handWritten: opts.handWritten,
    executionType,
    agentSteps: producing.length + (opts.handWritten ? 1 : 0),
    hasModelReview: reviews.length > 0,
    tools,
    usesWebSearch: Boolean(gather?.search) || tools.includes("web-search"),
    usesWebFetch: Boolean(gather?.fetch) || tools.includes("web-fetch"),
    calculation: calc,
    integrations: wf.integrations.map((i) => i.id),
    actions: [...new Set(actions)],
    reads: wf.steps.flatMap((s) => s.reads ?? []).map((r) => r.action),
    credentials: [...new Set(credentials)],
    inputs: wf.inputs.map((i) => ({ key: i.key, type: i.type, required: i.required })),
    outputs: outputSchema?.type === "object" ? Object.keys(outputSchema.properties ?? {}) : wf.outputs.map((o) => o.key),
    dependencies: wf.dependencies.map((d) => ({ workflowId: d.workflowId, required: d.required })),
    limits: {
      maxModelCalls: wf.limits.maxModelCalls ?? null,
      maxRetries: wf.limits.maxRetries,
      timeoutSeconds: wf.limits.timeoutSeconds,
      maxOutputTokens: wf.execution?.maxOutputTokens ?? null,
    },
  };
}
