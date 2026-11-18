import { z } from "zod";
import { CalcError, Z_TWO_SIDED, count, currency, label, nonNegative, normalCdf, percent, positive, round, round1, round2, safeDiv } from "./numbers";
import type { CalculationDefinition } from "./types";

const num = z.number().nullable();
const warnings = z.array(z.string());
const uniqueNames = <T extends { name: string }>(list: T[]) => new Set(list.map((x) => x.name.toLowerCase())).size === list.length;

// ------------------------------------------------------------------- funnel
const FunnelInput = z
  .object({ stages: z.array(z.object({ name: label("Stage name"), count: count("Stage count") }).strict()).min(2, "a funnel needs at least 2 stages").max(20, "at most 20 stages") })
  .strict()
  .refine((i) => uniqueNames(i.stages), "stage names must be unique");

export const funnel: CalculationDefinition<z.infer<typeof FunnelInput>, unknown> = {
  id: "funnel",
  version: "1",
  name: "Conversion funnel",
  summary: "Stage-to-stage conversion and drop-off, overall conversion, and the largest absolute and relative drop-offs.",
  input: FunnelInput,
  output: z
    .object({
      transitions: z.array(z.object({ from: z.string(), to: z.string(), from_count: z.number(), to_count: z.number(), conversion_pct: num, drop_off: z.number(), drop_off_pct: num }).strict()),
      overall_conversion_pct: num,
      largest_absolute_drop: z.object({ from: z.string(), to: z.string(), drop_off: z.number() }).strict().nullable(),
      largest_relative_drop: z.object({ from: z.string(), to: z.string(), drop_off_pct: z.number() }).strict().nullable(),
      warnings,
    })
    .strict(),
  units: { "transitions[].from_count": "count", "transitions[].to_count": "count", "transitions[].conversion_pct": "%", "transitions[].drop_off": "count", "transitions[].drop_off_pct": "%", overall_conversion_pct: "%" },
  formulas: [
    "conversion % (stage i → i+1) = count(i+1) ÷ count(i) × 100",
    "drop-off = count(i) − count(i+1); drop-off % = 100 − conversion %",
    "overall conversion % = last stage ÷ first stage × 100",
    "largest absolute drop = transition with the biggest drop-off count; largest relative drop = biggest drop-off %; ties go to the earlier stage",
  ],
  assumptions: ["Stages are in order and each stage's count is a subset of the previous one (the same people moving through)."],
  rounding: "Percentages to 2 decimals, half away from zero; counts are exact.",
  maxItems: 40,
  run(i) {
    const w: string[] = [];
    const transitions = i.stages.slice(1).map((to, k) => {
      const from = i.stages[k];
      const conv = safeDiv(to.count * 100, from.count);
      if (conv === null) w.push(`"${from.name}" has 0, so conversion to "${to.name}" is not defined.`);
      if (to.count > from.count) w.push(`"${to.name}" (${to.count}) is larger than "${from.name}" (${from.count}); check that the stages measure the same people in order.`);
      return { from: from.name, to: to.name, from_count: from.count, to_count: to.count, conversion_pct: conv === null ? null : round2(conv), drop_off: from.count - to.count, drop_off_pct: conv === null ? null : round2(100 - conv) };
    });
    const first = i.stages[0].count;
    const overall = safeDiv(i.stages[i.stages.length - 1].count * 100, first);
    let abs: (typeof transitions)[number] | undefined;
    let rel: (typeof transitions)[number] | undefined;
    for (const t of transitions) {
      if (t.drop_off > 0 && (!abs || t.drop_off > abs.drop_off)) abs = t;
      if (t.drop_off_pct !== null && t.drop_off_pct > 0 && (!rel || t.drop_off_pct > rel.drop_off_pct!)) rel = t;
    }
    return {
      transitions,
      overall_conversion_pct: overall === null ? null : round2(overall),
      largest_absolute_drop: abs ? { from: abs.from, to: abs.to, drop_off: abs.drop_off } : null,
      largest_relative_drop: rel ? { from: rel.from, to: rel.to, drop_off_pct: rel.drop_off_pct! } : null,
      warnings: w,
    };
  },
};

// --------------------------------------------------------------- cohort retention
const CohortInput = z
  .object({
    period_unit: z.enum(["week", "month"], { message: "period unit must be week or month" }),
    cohorts: z
      .array(
        z
          .object({
            name: label("Cohort label"),
            size: count("Cohort size").min(1, "a cohort needs at least 1 customer"),
            retained: z.array(count("Retained count").nullable()).min(1, "give at least one period").max(36, "at most 36 periods"),
          })
          .strict(),
      )
      .min(1, "add at least one cohort")
      .max(36, "at most 36 cohorts"),
  })
  .strict()
  .refine((i) => uniqueNames(i.cohorts), "cohort labels must be unique");

export const cohortRetention: CalculationDefinition<z.infer<typeof CohortInput>, unknown> = {
  id: "cohort_retention",
  version: "1",
  name: "Cohort retention",
  summary: "Retention % per cohort and period, and a size-weighted average per period over the cohorts actually observed.",
  input: CohortInput,
  output: z
    .object({
      cohorts: z.array(z.object({ name: z.string(), size: z.number(), retention_pct: z.array(num) }).strict()),
      by_period: z.array(z.object({ period: z.number().int(), observed_cohorts: z.number().int(), retained_total: z.number(), cohort_size_total: z.number(), weighted_retention_pct: num }).strict()),
      warnings,
    })
    .strict(),
  units: { "cohorts[].retention_pct[]": "%", "by_period[].weighted_retention_pct": "%", "by_period[].retained_total": "customers", "by_period[].cohort_size_total": "customers" },
  formulas: [
    "retention % (cohort c, period k) = retained(c, k) ÷ size(c) × 100",
    "weighted retention % (period k) = Σ retained(c, k) ÷ Σ size(c), over cohorts with an observation at period k only",
  ],
  assumptions: [
    "Period k counts customers from the cohort still active k periods after it started; period 0 is the cohort itself (100%).",
    "A missing value (null) means not observed yet. It is excluded from both numerator and denominator; it is never treated as 0% retention. A 0 means nobody was retained.",
  ],
  rounding: "Percentages to 2 decimals, half away from zero; counts are exact.",
  maxItems: 1400,
  run(i) {
    const w: string[] = [];
    const periods = Math.max(...i.cohorts.map((c) => c.retained.length));
    const cohorts = i.cohorts.map((c) => {
      c.retained.forEach((r, k) => {
        if (r !== null && r > c.size) throw new CalcError(`cohort "${c.name}" retains ${r} in period ${k + 1}, more than its size of ${c.size}`);
      });
      return { name: c.name, size: c.size, retention_pct: Array.from({ length: periods }, (_, k) => (c.retained[k] === null || c.retained[k] === undefined ? null : round2((c.retained[k]! / c.size) * 100))) };
    });
    const by_period = Array.from({ length: periods }, (_, k) => {
      const observed = i.cohorts.filter((c) => c.retained[k] !== null && c.retained[k] !== undefined);
      const retained = observed.reduce((s, c) => s + c.retained[k]!, 0);
      const size = observed.reduce((s, c) => s + c.size, 0);
      return { period: k + 1, observed_cohorts: observed.length, retained_total: retained, cohort_size_total: size, weighted_retention_pct: size ? round2((retained / size) * 100) : null };
    });
    const thin = by_period.filter((p) => p.observed_cohorts > 0 && p.observed_cohorts < i.cohorts.length).map((p) => p.period);
    if (thin.length) w.push(`Periods ${thin.join(", ")} include only the cohorts observed so far, so later periods average fewer cohorts.`);
    return { cohorts, by_period, warnings: w };
  },
};

// ----------------------------------------------------------- acquisition efficiency
const AcquisitionInput = z
  .object({
    currency,
    period: label("Period"),
    revenue_per_customer_month: positive("Revenue per customer per month"),
    gross_margin_pct: percent("Gross margin").refine((v) => v > 0, "gross margin must be above 0% for CAC payback"),
    channels: z.array(z.object({ name: label("Channel"), spend: nonNegative("Spend"), new_customers: count("New customers") }).strict()).min(1, "add at least one channel").max(30, "at most 30 channels"),
  })
  .strict()
  .refine((i) => uniqueNames(i.channels), "channel names must be unique");

export const acquisitionEfficiency: CalculationDefinition<z.infer<typeof AcquisitionInput>, unknown> = {
  id: "acquisition_efficiency",
  version: "1",
  name: "Acquisition efficiency",
  summary: "CAC and CAC payback per channel and blended, each channel's share of spend and customers, and an efficiency index.",
  input: AcquisitionInput,
  output: z
    .object({
      channels: z.array(z.object({ name: z.string(), spend: z.number(), new_customers: z.number(), cac: num, cac_payback_months: num, spend_share_pct: num, customer_share_pct: num, efficiency_index: num }).strict()),
      blended: z.object({ spend: z.number(), new_customers: z.number(), cac: num, cac_payback_months: num }).strict(),
      lowest_cac_channel: z.string().nullable(),
      highest_cac_channel: z.string().nullable(),
      warnings,
    })
    .strict(),
  units: { "channels[].spend": "currency", "channels[].cac": "currency per customer", "channels[].cac_payback_months": "months", "channels[].spend_share_pct": "%", "channels[].customer_share_pct": "%", "channels[].efficiency_index": "ratio (1 = average)", "blended.cac": "currency per customer", "blended.cac_payback_months": "months" },
  formulas: [
    "CAC = spend ÷ new customers (per channel and blended)",
    "CAC payback (months) = CAC ÷ (revenue per customer per month × gross margin % ÷ 100)",
    "spend share % = channel spend ÷ total spend × 100; customer share % = channel customers ÷ total customers × 100",
    "efficiency index = customer share ÷ spend share (above 1 = brings more than its share of customers for its share of spend)",
  ],
  assumptions: ["Spend and new customers cover the same period and are attributed to one channel each.", "Revenue per customer and gross margin are the same across channels."],
  rounding: "Money, percentages and the index to 2 decimals; months to 1 decimal; half away from zero.",
  maxItems: 30,
  run(i) {
    const w: string[] = [];
    const totalSpend = i.channels.reduce((s, c) => s + c.spend, 0);
    const totalCustomers = i.channels.reduce((s, c) => s + c.new_customers, 0);
    const monthlyMargin = i.revenue_per_customer_month * (i.gross_margin_pct / 100);
    const channels = i.channels.map((c) => {
      const cac = safeDiv(c.spend, c.new_customers);
      if (cac === null) w.push(`"${c.name}" acquired no customers, so its CAC is not defined.`);
      const spendShare = safeDiv(c.spend * 100, totalSpend);
      const custShare = safeDiv(c.new_customers * 100, totalCustomers);
      const index = spendShare === null || custShare === null ? null : safeDiv(custShare, spendShare);
      return { name: c.name, spend: round2(c.spend), new_customers: c.new_customers, cac: cac === null ? null : round2(cac), cac_payback_months: cac === null ? null : round1(cac / monthlyMargin), spend_share_pct: spendShare === null ? null : round2(spendShare), customer_share_pct: custShare === null ? null : round2(custShare), efficiency_index: index === null ? null : round2(index), _cac: cac };
    });
    const blendedCac = safeDiv(totalSpend, totalCustomers);
    if (blendedCac === null) w.push("No customers were acquired in total, so blended CAC is not defined.");
    const ranked = channels.filter((c) => c._cac !== null).sort((a, b) => a._cac! - b._cac!);
    return {
      channels: channels.map(({ _cac, ...c }) => (void _cac, c)),
      blended: { spend: round2(totalSpend), new_customers: totalCustomers, cac: blendedCac === null ? null : round2(blendedCac), cac_payback_months: blendedCac === null ? null : round1(blendedCac / monthlyMargin) },
      lowest_cac_channel: ranked[0]?.name ?? null,
      highest_cac_channel: ranked.length > 1 ? ranked[ranked.length - 1].name : null,
      warnings: w,
    };
  },
};

// -------------------------------------------------------------- experiment results
const Arm = z.object({ visitors: count("Visitors").min(1, "each arm needs at least 1 visitor"), conversions: count("Conversions") }).strict();
const AbInput = z
  .object({ control: Arm, treatment: Arm, confidence_level: z.enum(["90", "95", "99"], { message: "confidence level must be 90, 95 or 99" }).default("95") })
  .strict()
  .refine((i) => i.control.conversions <= i.control.visitors && i.treatment.conversions <= i.treatment.visitors, "conversions can't exceed visitors");

export const MIN_EVENTS = 10;

export const abTest: CalculationDefinition<z.infer<typeof AbInput>, unknown> = {
  id: "ab_test",
  version: "1",
  name: "A/B test results",
  summary: "Conversion rates, absolute and relative lift, a confidence interval for the difference and a two-proportion z-test, only when sample sizes support it.",
  input: AbInput,
  output: z
    .object({
      results: z
        .object({
          control_rate_pct: z.number(),
          treatment_rate_pct: z.number(),
          absolute_lift_pp: z.number(),
          relative_lift_pct: num,
          ci_low_pp: num,
          ci_high_pp: num,
          z_score: num,
          p_value: num,
          significance: z.enum(["significant", "not_significant", "not_assessed"]),
          confidence_level_pct: z.number(),
        })
        .strict(),
      method: z.string(),
      warnings,
    })
    .strict(),
  units: { "results.control_rate_pct": "%", "results.treatment_rate_pct": "%", "results.absolute_lift_pp": "percentage points", "results.relative_lift_pct": "%", "results.ci_low_pp": "percentage points", "results.ci_high_pp": "percentage points", "results.z_score": "standard deviations", "results.p_value": "probability (two-sided)", "results.confidence_level_pct": "%" },
  formulas: [
    "rate = conversions ÷ visitors (control p₁, treatment p₂)",
    "absolute lift (pp) = (p₂ − p₁) × 100; relative lift % = (p₂ − p₁) ÷ p₁ × 100",
    "CI for p₂ − p₁ = (p₂ − p₁) ± z × √(p₁(1−p₁)/n₁ + p₂(1−p₂)/n₂)  (Wald, unpooled)",
    "z = (p₂ − p₁) ÷ √(p̂(1−p̂)(1/n₁ + 1/n₂)), p̂ = pooled rate; p-value two-sided from the normal distribution",
  ],
  assumptions: [
    `Significance, the z-test and the interval are only calculated when every arm has at least ${MIN_EVENTS} conversions and ${MIN_EVENTS} non-conversions (normal approximation).`,
    "Visitors are independent and randomly assigned; the test was analysed once at its planned end (no peeking or early stopping), with one primary metric.",
    "\"Significant\" means p < 1 − confidence level; it is not the probability that the treatment is better.",
  ],
  rounding: "Rates, lifts and interval bounds to 2 decimals; z to 3 decimals; p-value to 4 decimals; half away from zero.",
  maxItems: 0,
  run(i) {
    const w: string[] = [];
    const n1 = i.control.visitors;
    const n2 = i.treatment.visitors;
    const p1 = i.control.conversions / n1;
    const p2 = i.treatment.conversions / n2;
    const diff = p2 - p1;
    const rel = safeDiv(diff * 100, p1);
    if (rel === null) w.push("The control converted 0%, so relative lift is not defined.");
    const enough = [i.control, i.treatment].every((a) => a.conversions >= MIN_EVENTS && a.visitors - a.conversions >= MIN_EVENTS);
    const z = Z_TWO_SIDED[i.confidence_level];
    let ci: [number, number] | null = null;
    let zScore: number | null = null;
    let p: number | null = null;
    let significance: "significant" | "not_significant" | "not_assessed" = "not_assessed";
    if (!enough) {
      w.push(`Not enough data for a statistical conclusion: each arm needs at least ${MIN_EVENTS} conversions and ${MIN_EVENTS} non-conversions. The rates and lift are descriptive only.`);
    } else {
      const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
      ci = [(diff - z * se) * 100, (diff + z * se) * 100];
      const pooled = (i.control.conversions + i.treatment.conversions) / (n1 + n2);
      const seP = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
      zScore = diff / seP;
      p = 2 * (1 - normalCdf(Math.abs(zScore)));
      significance = p < 1 - Number(i.confidence_level) / 100 ? "significant" : "not_significant";
    }
    return {
      results: {
        control_rate_pct: round2(p1 * 100),
        treatment_rate_pct: round2(p2 * 100),
        absolute_lift_pp: round2(diff * 100),
        relative_lift_pct: rel === null ? null : round2(rel),
        ci_low_pp: ci ? round2(ci[0]) : null,
        ci_high_pp: ci ? round2(ci[1]) : null,
        z_score: zScore === null ? null : round(zScore, 3),
        p_value: p === null ? null : round(Math.max(0, p), 4),
        significance,
        confidence_level_pct: Number(i.confidence_level),
      },
      method: enough
        ? `Two-proportion z-test (pooled), two-sided, ${i.confidence_level}% confidence; Wald interval for the difference in rates.`
        : "Descriptive comparison only (sample too small for the normal approximation).",
      warnings: w,
    };
  },
};

export const ANALYTICS = [funnel, cohortRetention, acquisitionEfficiency, abTest];
