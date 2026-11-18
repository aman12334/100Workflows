import { z } from "zod";
import { select } from "./path";
import type { RuleDefinition, RuleOutcome } from "./registry";

/**
 * The model may explain calculated results but never produce numbers of its own.
 * This rule reads every number written in the chosen text fields and requires it
 * to match a calculated result or a calculation input, at the precision written:
 * "38.3%" matches 38.33, "$2,800" matches 2800, "-2,000" or "2,000 lower" matches -2000.
 * Small whole numbers (0-12) and years are allowed, for phrases like "3 channels"
 * or "in 2026". Ids are permanent, like every rule.
 */

const path = z.string().min(1, "must be a path, e.g. insights[]");
const pass = (detail: string): RuleOutcome => ({ passed: true, score: 1, detail });

// A number not glued to letters on its left (skips ids like S1, Q2, H1), with optional thousands separators and decimals.
const NUMBER = /(?<![A-Za-z0-9_.])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;

export function numbersIn(text: string): Array<{ raw: string; value: number; decimals: number }> {
  return [...text.matchAll(NUMBER)].map((m) => {
    const raw = m[0];
    const clean = raw.replace(/,/g, "");
    return { raw, value: Number(clean), decimals: clean.includes(".") ? clean.split(".")[1].length : 0 };
  });
}

function collect(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collect(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collect(v, out));
  return out;
}

const roundTo = (v: number, d: number) => Math.round(Math.abs(v) * 10 ** d) / 10 ** d;

export function matchesAllowed(n: { value: number; decimals: number }, allowed: number[], small: boolean): boolean {
  const abs = Math.abs(n.value);
  if (small && n.decimals === 0 && (abs <= 12 || (abs >= 1900 && abs <= 2100))) return true;
  return allowed.some((v) => Math.abs(roundTo(v, n.decimals) - abs) < 1e-9 || Math.abs(Math.abs(v) - abs) < 1e-9);
}

export const numbersFromCalculation: RuleDefinition<{ path: string; allowSmallIntegers: boolean }> = {
  id: "numbers_from_calculation",
  summary: "Every number in the chosen text fields matches a calculated result or a calculation input (at the precision written); the model can't introduce numbers of its own.",
  params: z.object({ path, allowSmallIntegers: z.boolean().default(true) }).strict(),
  outputPaths: (p) => [{ param: "path", path: p.path, types: ["string"] }],
  run(p, ctx) {
    if (!ctx.calculation) return { passed: false, score: 0, detail: "No calculation results were available to check against." };
    const allowed = [...collect(ctx.calculation.output), ...collect(ctx.calculation.input)];
    const texts = select(ctx.output, p.path).values.filter((v): v is string => typeof v === "string");
    const found = texts.flatMap(numbersIn);
    if (!found.length) return pass(`No numbers in ${p.path} to check.`);
    const bad = [...new Set(found.filter((n) => !matchesAllowed(n, allowed, p.allowSmallIntegers)).map((n) => n.raw))];
    if (!bad.length) return pass(`All ${found.length} numbers in ${p.path} come from the calculation.`);
    return {
      passed: false,
      score: (found.length - found.filter((n) => bad.includes(n.raw)).length) / found.length,
      detail: `${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` and ${bad.length - 5} more` : ""} ${bad.length === 1 ? "is" : "are"} not in the calculated results; use only the numbers in <calculation_results>.`,
    };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CALCULATION_RULES: ReadonlyArray<RuleDefinition<any>> = [numbersFromCalculation];
export const CALCULATION_RULE_IDS = new Set(CALCULATION_RULES.map((r) => r.id));
