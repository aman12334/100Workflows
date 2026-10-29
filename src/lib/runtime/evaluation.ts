import type { Workflow } from "@/lib/catalog/schema";

/** What an executor reports for one evaluation criterion. */
export interface CriterionResult {
  id: string;
  passed: boolean;
  /** 0..1. Partial credit is allowed (e.g. 4 of 5 findings traceable = 0.8). */
  score: number;
  detail: string;
  /** Not evaluated (e.g. output didn't parse, or not enough budget for a model review). Excluded from the score. */
  skipped?: boolean;
}

export type Decision = "accept" | "retry" | "escalate";

export interface EvaluatedCriterion extends CriterionResult {
  description: string;
  method: "schema" | "rule" | "model";
  critical: boolean;
}

export interface Evaluation {
  attempt: number;
  /** Mean of the evaluated criteria, or null when nothing could be evaluated. */
  score: number | null;
  threshold: number;
  passed: boolean;
  criticalFailures: string[];
  criteria: EvaluatedCriterion[];
  decision: Decision;
}

/**
 * Scores one attempt against the workflow's criteria. A failed critical
 * criterion fails the attempt regardless of the aggregate score.
 */
export function evaluate(
  workflow: Workflow,
  results: CriterionResult[],
  opts: { attempt: number; maxRetries: number; canRetry: boolean },
): Evaluation {
  const byId = new Map(results.map((r) => [r.id, r]));
  const unknown = results.filter((r) => !workflow.evaluation.criteria.some((c) => c.id === r.id));
  if (unknown.length) throw new Error(`Executor reported unknown criteria: ${unknown.map((u) => u.id).join(", ")}`);

  const criteria: EvaluatedCriterion[] = workflow.evaluation.criteria.map((c) => {
    const r = byId.get(c.id);
    if (!r) throw new Error(`Executor did not report criterion "${c.id}"`);
    const score = Math.min(1, Math.max(0, Number.isFinite(r.score) ? r.score : 0));
    return { ...r, score, description: c.description, method: c.method, critical: c.critical };
  });

  const scored = criteria.filter((c) => !c.skipped);
  const score = scored.length ? scored.reduce((s, c) => s + c.score, 0) / scored.length : null;
  // A skipped critical check can't be trusted to pass.
  const criticalFailures = criteria.filter((c) => c.critical && (c.skipped || !c.passed)).map((c) => c.id);
  const passed = criticalFailures.length === 0 && score !== null && score >= workflow.evaluation.threshold;

  const decision: Decision = passed ? "accept" : opts.canRetry && opts.attempt < opts.maxRetries ? "retry" : "escalate";
  return { attempt: opts.attempt, score, threshold: workflow.evaluation.threshold, passed, criticalFailures, criteria, decision };
}

/** Plain-language feedback for the next attempt, built only from failed checks. */
export function feedbackFor(evaluation: Evaluation): string {
  const failed = evaluation.criteria.filter((c) => !c.skipped && !c.passed);
  if (!failed.length) return `The overall quality score ${evaluation.score?.toFixed(2)} was below the ${evaluation.threshold} threshold. Improve completeness and specificity.`;
  return failed.map((c) => `- ${c.description} Problem: ${c.detail}`).join("\n");
}
