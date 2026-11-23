/**
 * Workflow quality and production readiness: shared types.
 *
 * The rule of the whole system: a readiness status is never assigned, it is derived
 * from evidence records, and every record says how it was obtained. Mocked tests,
 * live executions and human reviews are different kinds of proof and are never
 * counted as one another.
 */

export type ExecutionType = "model" | "research" | "calculation" | "integration" | "multi_agent";

export type Dimension = "functional" | "output_quality" | "reliability" | "security" | "integration" | "performance" | "user_experience" | "operational";

/** How a piece of evidence was obtained. */
export type EvidenceMode =
  /** Derived from the definition or repository files, without running anything. */
  | "static"
  /** Executed with scripted model replies and/or mocked providers. Proves logic, not real-world behaviour. */
  | "mocked"
  /** Executed against a real model or provider. */
  | "live"
  /** A person reviewed a real output. */
  | "human";

/** Identifies exactly what a piece of evidence was about, so changes make it stale. */
export interface Fingerprint {
  /** sha256 of the workflow definition (prompts, schema, rules, limits...). "*" for platform checks. */
  definition: string;
  /** sha256 of the runtime source files relevant to this workflow's execution type. */
  code: string;
  /** Versioned components it depends on: tools, calculations, provider actions, golden dataset. */
  components: string[];
}

export interface Evidence {
  id: string;
  qualityRunId: string | null;
  workflowId: string;
  workflowVersion: string | null;
  criterion: string;
  mode: EvidenceMode;
  status: "passed" | "failed";
  detail: string;
  fingerprint: Fingerprint;
  data: EvidenceData | null;
  source: string;
  createdAt: string;
}

/** Measurements and references carried by evidence. Never credentials or user data. */
export interface EvidenceData {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  modelCalls?: number;
  /** Only when the model's price is verified (see runtime/pricing.ts). */
  costUsd?: number | null;
  provider?: string;
  model?: string;
  toolVersions?: string[];
  scenario?: string;
  datasetVersion?: number;
  outputId?: string;
  actionId?: string;
  /** Human review: rubric scores 1-5 and the verdict. */
  scores?: Record<string, number>;
  verdict?: "accept" | "reject";
  severity?: "none" | "minor" | "major" | "critical";
  reviewer?: string;
  [key: string]: unknown;
}

export type CriterionStatus =
  | "passed"
  | "failed"
  /** No evidence yet. */
  | "missing"
  /** Evidence exists but was for a different definition, code or component version. */
  | "stale"
  | "not_applicable";

export type ReleaseStatus = "certified" | "blocked" | "not_certified";

/** 0 = not implemented (definition only or failing basic checks). */
export type ReadinessLevel = 0 | 1 | 2 | 3;
