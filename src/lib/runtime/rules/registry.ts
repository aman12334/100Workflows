import type { z } from "zod";
import { parsePath, schemaAt, type JsonSchemaNode } from "@/lib/catalog/output-schema";
import type { UpstreamOutput } from "../engine";
import { BUILTIN_RULES } from "./builtin";
import { ACTION_RULES } from "./actions";
import { CALCULATION_RULES } from "./calculation";
import { SOURCE_RULES } from "./sources";

/**
 * Deterministic validation rules that workflow definitions configure by id.
 *
 * A rule is code reviewed with the app; a definition only chooses a rule and
 * its parameters. Rules never call a model or touch the network, so the same
 * output always gets the same result.
 *
 * Rule ids are permanent: packages pin definitions that name them, so a rule
 * must never change meaning. New behaviour gets a new id.
 */

export interface RuleContext {
  output: unknown;
  /** The workflow's own input values (`inputsFor()`), keyed by its input keys. */
  inputs: Record<string, unknown>;
  upstream: Record<string, UpstreamOutput>;
  /** Research workflows only: what the tools retrieved in this run (page text and/or cited search passages). */
  sources?: Array<{ id: string; via: "page" | "search_result"; text: string }>;
  /** Calculation workflows only: the calculation's validated input and output. */
  calculation?: { input: unknown; output: unknown };
  /** Integration workflows only: outputs of read-only actions run in this run, by action id. */
  integrationData?: Record<string, unknown>;
  /** The run's clock, for checks such as "the meeting is in the future". */
  now?: Date;
}

export interface RuleOutcome {
  passed: boolean;
  /** 0..1, with partial credit, e.g. 4 of 5 items valid = 0.8. */
  score: number;
  /** Plain language. Shown in the run page and fed back to the model on a retry. */
  detail: string;
}

export type SchemaType = JsonSchemaNode["type"];

/** A place a rule reads from the output, and the schema types it can work with there. */
export interface PathUse {
  param: string;
  path: string;
  types: SchemaType[];
}

export interface RuleDefinition<P> {
  id: string;
  /** One sentence for docs and the library page. */
  summary: string;
  params: z.ZodType<P>;
  outputPaths(params: P): PathUse[];
  inputKeys?(params: P): string[];
  /** Extra checks against the output schema that only this rule knows about. */
  staticCheck?(params: P, schema: JsonSchemaNode): string[];
  run(params: P, ctx: RuleContext): RuleOutcome;
}

export interface RuleRef {
  id: string;
  params: unknown;
}

export interface RuleTarget {
  outputSchema: JsonSchemaNode;
  /** Input keys the workflow declares. */
  inputKeys: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const RULES: Readonly<Record<string, RuleDefinition<any>>> = Object.freeze(
  Object.fromEntries([...BUILTIN_RULES, ...SOURCE_RULES, ...CALCULATION_RULES, ...ACTION_RULES].map((r) => [r.id, r])),
);

/**
 * Checks a rule reference when the catalog loads: the rule exists, its
 * parameters are valid, every path exists in the output schema with a usable
 * type, and every input it reads is declared. Returns problems; empty means valid.
 */
export function validateRuleRef(ref: RuleRef, target: RuleTarget): string[] {
  const rule = RULES[ref.id];
  if (!rule) return [`unknown rule "${ref.id}" (available: ${Object.keys(RULES).sort().join(", ")})`];

  const parsed = rule.params.safeParse(ref.params);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `rule "${ref.id}" params${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`);
  }
  const params = parsed.data;
  const problems: string[] = [];

  for (const use of rule.outputPaths(params)) {
    if (!parsePath(use.path)) {
      problems.push(`rule "${ref.id}" ${use.param}: "${use.path}" is not a valid path (e.g. "questions[].text")`);
      continue;
    }
    const node = schemaAt(target.outputSchema, use.path);
    if (!node) problems.push(`rule "${ref.id}" ${use.param}: "${use.path}" does not exist in the output schema`);
    else if (!use.types.includes(node.type)) {
      const article = /^[aeiou]/.test(node.type) ? "an" : "a";
      problems.push(`rule "${ref.id}" ${use.param}: "${use.path}" is ${article} ${node.type}, but this rule needs ${use.types.join(" or ")}`);
    }
  }
  for (const key of rule.inputKeys?.(params) ?? []) {
    if (!target.inputKeys.includes(key)) problems.push(`rule "${ref.id}" reads input "${key}", which the workflow doesn't declare`);
  }
  if (!problems.length && rule.staticCheck) {
    problems.push(...rule.staticCheck(params, target.outputSchema).map((p) => `rule "${ref.id}": ${p}`));
  }
  return problems;
}

/**
 * Runs a rule on an output. References are validated when the catalog loads,
 * so an unknown rule or invalid parameters here is a bug and throws.
 */
export function runRule(ref: RuleRef, ctx: RuleContext): RuleOutcome {
  const rule = RULES[ref.id];
  if (!rule) throw new Error(`Unknown rule "${ref.id}"`);
  const params = rule.params.parse(ref.params);
  const outcome = rule.run(params, ctx);
  return { ...outcome, score: Math.min(1, Math.max(0, Number.isFinite(outcome.score) ? outcome.score : 0)) };
}
