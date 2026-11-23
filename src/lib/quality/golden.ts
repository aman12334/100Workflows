import { z } from "zod";

/**
 * Golden datasets: quality/golden/<workflow-id>.json, versioned with the code.
 *
 * Each dataset holds representative scenarios with expected behaviour, required and
 * forbidden content, edge cases, the rubric people review real outputs against, and the
 * expected failure behaviour. `mock` holds scripted replies and canned provider data so
 * the harness can run a scenario without a model; live runs ignore it and use only the
 * inputs. Bump `datasetVersion` whenever expectations change: older evidence becomes stale.
 */

const Expect = z
  .object({
    status: z.enum(["succeeded", "needs_review", "failed"]),
    /** Critical check ids that must fail (known-bad scenarios). */
    criticalFailures: z.array(z.string()).optional(),
    /** Output paths that must be present (not missing or blank), e.g. "steps", "summary". */
    requiredFields: z.array(z.string()).default([]),
    /** Text that must appear in the output (case-insensitive). */
    requiredText: z.array(z.string()).default([]),
    /** Text that must not appear anywhere in the output (case-insensitive). */
    forbiddenText: z.array(z.string()).default([]),
    /** Calculation workflows: values by path that must match exactly. */
    values: z.record(z.string(), z.unknown()).optional(),
    /** Integration workflows: minimum number of proposed actions. */
    minProposals: z.number().int().min(0).optional(),
    /** Research workflows: minimum number of retrieved sources. */
    minSources: z.number().int().min(0).optional(),
    /** Failure scenarios: text the failure reason must contain. */
    reasonIncludes: z.string().optional(),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    kind: z.enum(["typical", "edge", "known_bad", "adversarial"]),
    description: z.string().min(5),
    inputs: z.record(z.string(), z.unknown()),
    expect: Expect,
    /** Harness only. Never sent to a real model. */
    mock: z
      .object({
        replies: z.array(z.unknown()).min(1),
        extracted: z.unknown().optional(),
        search: z.object({ results: z.array(z.object({ url: z.string(), title: z.string() })), cited: z.array(z.object({ url: z.string(), text: z.string() })) }).optional(),
        pages: z.record(z.string(), z.string()).optional(),
        http: z.record(z.string(), z.unknown()).optional(),
        review: z.number().int().min(1).max(5).optional(),
      })
      .strict()
      .optional(),
    /** Safe to run against a real model (synthetic data, no real people or companies' private data). */
    live: z.boolean().default(false),
  })
  .strict();

export const GoldenSchema = z
  .object({
    workflowId: z.string(),
    datasetVersion: z.number().int().min(1),
    /** Where the scenarios came from (a test fixture, or written by hand). */
    derivedFrom: z.string(),
    scenarios: z.array(ScenarioSchema).min(1),
    rubric: z.array(z.object({ id: z.string(), question: z.string() }).strict()).min(1),
    /** Behaviour that must hold when things go wrong, in plain words (checked by the harness's reliability cases). */
    expectedFailureBehavior: z.array(z.string()).min(1),
    /** Known limitations and edge cases that are not yet covered by a scenario. */
    knownGaps: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((g, ctx) => {
    const ids = g.scenarios.map((s) => s.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "scenario ids must be unique" });
    if (!g.scenarios.some((s) => s.kind === "typical")) ctx.addIssue({ code: "custom", message: "needs at least one typical scenario" });
  });

export type Golden = z.infer<typeof GoldenSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioExpect = z.infer<typeof Expect>;

const at = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
/** Present means not missing, null or blank text. An empty list is a valid answer (e.g. "no conflicts found"). */
const absent = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());

/** Deterministic checks of an outcome against a scenario's expectations. Returns problems; empty means it meets them. */
export function checkExpectations(
  expect: ScenarioExpect,
  outcome: { status: string; reason?: string | null; output: unknown; criticalFailures?: string[]; proposals?: number; sources?: number },
): string[] {
  const problems: string[] = [];
  if (outcome.status !== expect.status) problems.push(`status was ${outcome.status}, expected ${expect.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  for (const id of expect.criticalFailures ?? []) if (!outcome.criticalFailures?.includes(id)) problems.push(`critical check "${id}" did not fail`);
  if (expect.reasonIncludes && !(outcome.reason ?? "").toLowerCase().includes(expect.reasonIncludes.toLowerCase())) problems.push(`reason doesn't mention "${expect.reasonIncludes}"`);
  if (expect.status === "succeeded") {
    for (const f of expect.requiredFields) if (absent(at(outcome.output, f))) problems.push(`required field "${f}" is missing`);
    const text = JSON.stringify(outcome.output ?? "").toLowerCase();
    for (const t of expect.requiredText) if (!text.includes(t.toLowerCase())) problems.push(`required text "${t}" is missing`);
    for (const [p, v] of Object.entries(expect.values ?? {})) if (JSON.stringify(at(outcome.output, p)) !== JSON.stringify(v)) problems.push(`${p} is ${JSON.stringify(at(outcome.output, p))}, expected ${JSON.stringify(v)}`);
    if (expect.minProposals !== undefined && (outcome.proposals ?? 0) < expect.minProposals) problems.push(`${outcome.proposals ?? 0} proposed actions, expected at least ${expect.minProposals}`);
    if (expect.minSources !== undefined && (outcome.sources ?? 0) < expect.minSources) problems.push(`${outcome.sources ?? 0} sources, expected at least ${expect.minSources}`);
  }
  const all = JSON.stringify(outcome.output ?? "").toLowerCase();
  for (const t of expect.forbiddenText) if (all.includes(t.toLowerCase())) problems.push(`forbidden text "${t}" appears`);
  return problems;
}
