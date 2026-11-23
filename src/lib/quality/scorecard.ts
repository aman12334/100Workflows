import { CRITERIA, DIMENSIONS, type Criterion } from "./criteria";
import type { WorkflowProfile } from "./profile";
import type { CriterionStatus, Dimension, Evidence, Fingerprint, ReadinessLevel, ReleaseStatus } from "./types";

/**
 * Turns evidence into a readiness scorecard. Pure: the same evidence always gives the
 * same scorecard, so every status on the dashboard can be traced to the records behind it.
 *
 * - Only the newest evidence per criterion counts, and only if its fingerprint matches what
 *   runs today (definition, relevant code, component versions); otherwise it is "stale".
 * - Evidence of a mode the criterion doesn't accept is ignored: mocked runs never satisfy
 *   live criteria, and live runs never stand in for human review.
 * - The score is a weighted average over applicable dimensions. It never overrides a
 *   failed blocker: any failed blocker makes the release status "blocked".
 */

export interface CriterionResult {
  id: string;
  title: string;
  dimension: Dimension;
  level: 1 | 2 | 3;
  blocker: boolean;
  status: CriterionStatus;
  /** The evidence the status rests on (newest accepted record), if any. */
  evidence: Evidence | null;
  /** Why it is stale, when it is. */
  staleReason: string | null;
  how: string;
}

export interface OpenIssue {
  criterion: string;
  severity: "critical" | "major";
  detail: string;
  evidenceId: string | null;
}

export interface Scorecard {
  workflowId: string;
  level: ReadinessLevel;
  release: ReleaseStatus;
  /** 0-100 over applicable dimensions; null when nothing applicable has evidence. */
  score: number | null;
  dimensions: Array<{ id: Dimension; label: string; weight: number; applicable: boolean; score: number | null; passed: number; total: number }>;
  criteria: CriterionResult[];
  blockers: CriterionResult[];
  issues: OpenIssue[];
  /** What is still needed for the next level, in order. */
  nextLevel: { level: ReadinessLevel; needs: CriterionResult[] } | null;
  awaitingLive: boolean;
  awaitingHumanReview: boolean;
  lastEvidenceAt: string | null;
}

/** Fingerprints the platform-wide checks are compared against. */
export interface CurrentFingerprints {
  workflow: Fingerprint;
  platform: Fingerprint;
}

export function staleReason(evidence: Fingerprint, current: Fingerprint): string | null {
  const reasons: string[] = [];
  if (evidence.definition !== current.definition) reasons.push("the definition changed");
  if (evidence.code !== current.code) reasons.push("runtime code it depends on changed");
  const missing = current.components.filter((c) => !evidence.components.includes(c));
  if (missing.length) reasons.push(`component versions changed (${missing.join(", ")})`);
  return reasons.length ? `Verified before ${reasons.join(" and ")}.` : null;
}

export function computeScorecard(profile: WorkflowProfile, evidence: Evidence[], current: CurrentFingerprints, criteria: Criterion[] = CRITERIA): Scorecard {
  const results: CriterionResult[] = criteria.map((c) => {
    const base = { id: c.id, title: c.title, dimension: c.dimension, level: c.level, blocker: Boolean(c.blocker), how: c.how };
    if (!c.appliesTo(profile)) return { ...base, status: "not_applicable" as const, evidence: null, staleReason: null };
    const owner = c.platform ? "*" : profile.id;
    const candidates = evidence
      .filter((e) => e.workflowId === owner && e.criterion === c.id && c.accepts.includes(e.mode))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const newest = candidates[0] ?? null;
    if (!newest) return { ...base, status: "missing" as const, evidence: null, staleReason: null };
    const stale = staleReason(newest.fingerprint, c.platform ? current.platform : current.workflow);
    if (stale) return { ...base, status: "stale" as const, evidence: newest, staleReason: stale };
    return { ...base, status: newest.status, evidence: newest, staleReason: null };
  });

  const applicable = results.filter((r) => r.status !== "not_applicable");
  const blockers = applicable.filter((r) => r.blocker && r.status === "failed");

  // Open issues: failed blockers, and the newest current human review if it flagged a major or critical problem.
  const issues: OpenIssue[] = blockers.map((b) => ({ criterion: b.id, severity: "critical", detail: b.evidence?.detail ?? b.title, evidenceId: b.evidence?.id ?? null }));
  const review = results.find((r) => r.id === "human_review");
  const sev = review?.evidence?.data?.severity;
  if (review?.status === "failed" && (sev === "critical" || sev === "major")) issues.push({ criterion: "human_review", severity: sev, detail: review.evidence!.detail, evidenceId: review.evidence!.id });

  const levelPassed = (lvl: 1 | 2 | 3) => applicable.filter((r) => r.level === lvl).every((r) => r.status === "passed");
  let level: ReadinessLevel = 0;
  if (profile.executable && levelPassed(1)) level = 1;
  if (level === 1 && levelPassed(2) && blockers.length === 0) level = 2;
  if (level === 2 && levelPassed(3) && !issues.some((i) => i.severity === "critical")) level = 3;

  const dimensions = (Object.keys(DIMENSIONS) as Dimension[]).map((d) => {
    const rs = applicable.filter((r) => r.dimension === d);
    const passed = rs.filter((r) => r.status === "passed").length;
    return { id: d, label: DIMENSIONS[d].label, weight: DIMENSIONS[d].weight, applicable: rs.length > 0, score: rs.length ? passed / rs.length : null, passed, total: rs.length };
  });
  const weighted = dimensions.filter((d) => d.applicable);
  const weightSum = weighted.reduce((s, d) => s + d.weight, 0);
  const anyEvidence = applicable.some((r) => r.evidence);
  const score = anyEvidence && weightSum ? Math.round((weighted.reduce((s, d) => s + d.weight * (d.score ?? 0), 0) / weightSum) * 1000) / 10 : null;

  const release: ReleaseStatus = blockers.length || issues.some((i) => i.severity === "critical") ? "blocked" : level === 3 ? "certified" : "not_certified";
  const next = level < 3 ? ((level + 1) as 1 | 2 | 3) : null;
  const needs = next ? applicable.filter((r) => r.level <= next && r.status !== "passed") : [];
  const live = applicable.filter((r) => criteria.find((c) => c.id === r.id)?.accepts.every((m) => m === "live"));
  // Static checks are re-derived on every read, so only recorded evidence counts as "last tested".
  const lastEvidenceAt = applicable.map((r) => (r.evidence && r.evidence.mode !== "static" ? r.evidence.createdAt : "")).sort().at(-1) || null;

  return {
    workflowId: profile.id,
    level,
    release,
    score,
    dimensions,
    criteria: results,
    blockers,
    issues,
    nextLevel: next ? { level: next, needs } : null,
    awaitingLive: profile.executable && live.some((r) => r.status !== "passed"),
    awaitingHumanReview: profile.executable && results.some((r) => r.id === "human_review" && r.status !== "passed" && r.status !== "not_applicable"),
    lastEvidenceAt,
  };
}

export const LEVEL_LABELS: Record<ReadinessLevel, string> = { 0: "Not implemented", 1: "Implemented", 2: "Verified", 3: "Production-ready" };
