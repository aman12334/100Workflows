import { z } from "zod";

/**
 * Numeric helpers shared by every registered calculation.
 *
 * Representation: values are IEEE-754 doubles, which hold about 15 significant
 * digits. Inputs are bounded (|x| ≤ 1e12), so for money that leaves well over a
 * millionth of a cent of headroom. Where sums of money must be exact (budget
 * lines), amounts are converted to integer minor units (cents) first.
 * Rounding happens once, when a result is reported, never in the middle of a
 * formula (except where a calculation documents otherwise, e.g. monthly MRR).
 */

export class CalcError extends Error {}

export const MAX_ABS = 1e12;

/** Round half away from zero to `dp` decimals, without the 1.005 → 1.00 float trap. */
export function round(x: number, dp: number): number {
  if (!Number.isFinite(x)) throw new CalcError(`cannot round ${x}`);
  const sign = x < 0 ? -1 : 1;
  const abs = Number(Math.abs(x).toPrecision(15)); // drop binary noise beyond 15 significant digits
  const text = abs.toString();
  if (text.includes("e")) return (sign * Math.round(abs * 10 ** dp)) / 10 ** dp;
  const shifted = Math.round(Number(`${text}e${dp}`));
  const result = Number(`${shifted}e-${dp}`);
  return result === 0 ? 0 : sign * result; // never -0
}

export const round2 = (x: number) => round(x, 2);
export const round1 = (x: number) => round(x, 1);

/** a / b, or null when b is zero (the caller reports why). Never Infinity or NaN. */
export function safeDiv(a: number, b: number): number | null {
  if (b === 0) return null;
  const q = a / b;
  return Number.isFinite(q) ? q : null;
}

/** Converts an amount to integer cents. Rejects amounts with more than 2 decimals instead of silently rounding them. */
export function toCents(x: number, label: string): number {
  const cents = Number(`${x}e2`);
  if (!Number.isFinite(cents)) throw new CalcError(`${label} is not a valid amount`);
  const rounded = Math.round(cents);
  if (Math.abs(cents - rounded) > 1e-6) throw new CalcError(`${label} has more than 2 decimal places (${x}); enter amounts to the cent`);
  return rounded;
}

export const fromCents = (c: number) => c / 100;

/** Standard normal CDF, via the error function (Abramowitz & Stegun 7.1.26, absolute error < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Two-sided z critical values for the confidence levels the calculations accept. Exact to 16 digits. */
export const Z_TWO_SIDED: Record<string, number> = { "90": 1.6448536269514722, "95": 1.959963984540054, "99": 2.5758293035489004 };

/** One-sided z for cycle service levels (inventory). */
export const Z_ONE_SIDED: Record<string, number> = {
  "90": 1.2815515655446004,
  "95": 1.6448536269514722,
  "97.5": 1.959963984540054,
  "98": 2.053748910631823,
  "99": 2.3263478740408408,
  "99.5": 2.5758293035489004,
  "99.9": 3.090232306167813,
};

// ---------- strict input building blocks (no coercion: numbers must be numbers) ----------

const finite = (label: string) =>
  z
    .number({ error: (issue) => (issue.code === "invalid_type" ? `${label} must be a number` : undefined) })
    .finite(`${label} must be a finite number`)
    .min(-MAX_ABS, `${label} is out of range (at most ${MAX_ABS.toExponential()} in size)`)
    .max(MAX_ABS, `${label} is out of range (at most ${MAX_ABS.toExponential()} in size)`);
export const amount = (label: string) => finite(label);
export const nonNegative = (label: string) => finite(label).min(0, `${label} can't be negative`);
export const positive = (label: string) => finite(label).gt(0, `${label} must be greater than zero`);
export const percent = (label: string, { min = 0, max = 100 } = {}) => finite(label).min(min, `${label} must be at least ${min}%`).max(max, `${label} must be at most ${max}%`);
export const count = (label: string) =>
  z
    .number({ error: (issue) => (issue.code === "invalid_type" ? `${label} must be a number` : undefined) })
    .int(`${label} must be a whole number`)
    .min(0, `${label} can't be negative`)
    .max(MAX_ABS, `${label} is out of range`);
export const label = (what: string, max = 80) => z.string({ message: `${what} must be text` }).trim().min(1, `${what} can't be empty`).max(max);
export const currency = z.string().trim().regex(/^[A-Z]{3}$/, "currency must be a 3-letter code such as USD").default("USD");
