import { z } from "zod";
import { amount, count, currency, fromCents, label, nonNegative, percent, positive, round, round1, round2, safeDiv, toCents } from "./numbers";
import type { CalculationDefinition } from "./types";

const money = z.number().nullable();
const num = z.number().nullable();
const warnings = z.array(z.string());

// ------------------------------------------------------------------ unit economics
const UnitEconomicsInput = z
  .object({
    currency,
    revenue_per_customer_month: positive("Revenue per customer per month"),
    variable_cost_per_customer_month: nonNegative("Variable cost per customer per month"),
    cac: nonNegative("Customer acquisition cost"),
    monthly_churn_pct: percent("Monthly churn").optional(),
  })
  .strict();

export const unitEconomics: CalculationDefinition<z.infer<typeof UnitEconomicsInput>, unknown> = {
  id: "unit_economics",
  version: "1",
  name: "Unit economics",
  summary: "Contribution margin, gross margin, customer lifetime, LTV, LTV:CAC and CAC payback for a subscription customer.",
  input: UnitEconomicsInput,
  output: z
    .object({
      results: z
        .object({
          contribution_per_customer_month: money,
          gross_margin_pct: num,
          customer_lifetime_months: num,
          ltv: money,
          ltv_to_cac: num,
          cac_payback_months: num,
          lifetime_profit_per_customer: money,
        })
        .strict(),
      warnings,
    })
    .strict(),
  units: {
    "results.contribution_per_customer_month": "currency per month",
    "results.gross_margin_pct": "%",
    "results.customer_lifetime_months": "months",
    "results.ltv": "currency",
    "results.ltv_to_cac": "ratio (x)",
    "results.cac_payback_months": "months",
    "results.lifetime_profit_per_customer": "currency",
  },
  formulas: [
    "contribution = revenue per customer per month − variable cost per customer per month",
    "gross margin % = contribution ÷ revenue × 100",
    "customer lifetime (months) = 100 ÷ monthly churn %",
    "LTV = contribution × customer lifetime",
    "LTV:CAC = LTV ÷ CAC",
    "CAC payback (months) = CAC ÷ contribution",
    "lifetime profit per customer = LTV − CAC",
  ],
  assumptions: [
    "Churn is constant each month, so expected lifetime is 1 ÷ churn rate.",
    "Revenue and variable cost per customer are constant over the lifetime; no expansion revenue, discounting or inflation.",
    "\"Gross margin\" here is contribution margin on the revenue and variable cost supplied.",
  ],
  rounding: "Money to 2 decimals; percentages and ratios to 2 decimals; months to 1 decimal; half away from zero, applied once to each reported value.",
  maxItems: 0,
  run(i) {
    const w: string[] = [];
    const contribution = i.revenue_per_customer_month - i.variable_cost_per_customer_month;
    if (contribution <= 0) w.push("Contribution per customer is zero or negative, so CAC never pays back and LTV is not meaningful.");
    const lifetime = i.monthly_churn_pct === undefined ? null : safeDiv(100, i.monthly_churn_pct);
    if (i.monthly_churn_pct === undefined) w.push("No churn rate supplied, so customer lifetime, LTV and LTV:CAC were not calculated.");
    else if (lifetime === null) w.push("Churn is 0%, so customer lifetime is unbounded; LTV and LTV:CAC were not calculated.");
    const ltv = lifetime === null || contribution <= 0 ? null : contribution * lifetime;
    const ltvToCac = ltv === null ? null : safeDiv(ltv, i.cac);
    if (ltv !== null && i.cac === 0) w.push("CAC is 0, so LTV:CAC is undefined.");
    const payback = contribution <= 0 ? null : i.cac / contribution;
    return {
      results: {
        contribution_per_customer_month: round2(contribution),
        gross_margin_pct: round2((contribution / i.revenue_per_customer_month) * 100),
        customer_lifetime_months: lifetime === null ? null : round1(lifetime),
        ltv: ltv === null ? null : round2(ltv),
        ltv_to_cac: ltvToCac === null ? null : round2(ltvToCac),
        cac_payback_months: payback === null ? null : round1(payback),
        lifetime_profit_per_customer: ltv === null ? null : round2(ltv - i.cac),
      },
      warnings: w,
    };
  },
};

// --------------------------------------------------------------------- break-even
const BreakEvenInput = z
  .object({
    currency,
    fixed_costs: nonNegative("Fixed costs for the period"),
    price_per_unit: positive("Price per unit"),
    variable_cost_per_unit: nonNegative("Variable cost per unit"),
    target_profit: nonNegative("Target profit").optional(),
    period: label("Period").default("period"),
  })
  .strict();

export const breakEven: CalculationDefinition<z.infer<typeof BreakEvenInput>, unknown> = {
  id: "break_even",
  version: "1",
  name: "Break-even analysis",
  summary: "Break-even units and revenue for a period, and the volume needed for a target profit.",
  input: BreakEvenInput,
  output: z
    .object({
      results: z
        .object({
          contribution_per_unit: money,
          contribution_margin_pct: num,
          break_even_units_exact: num,
          break_even_units: num,
          break_even_revenue: money,
          units_for_target_profit: num,
          revenue_for_target_profit: money,
        })
        .strict(),
      warnings,
    })
    .strict(),
  units: {
    "results.contribution_per_unit": "currency per unit",
    "results.contribution_margin_pct": "%",
    "results.break_even_units_exact": "units",
    "results.break_even_units": "whole units",
    "results.break_even_revenue": "currency per period",
    "results.units_for_target_profit": "whole units",
    "results.revenue_for_target_profit": "currency per period",
  },
  formulas: [
    "contribution per unit = price − variable cost per unit",
    "contribution margin % = contribution per unit ÷ price × 100",
    "break-even units (exact) = fixed costs ÷ contribution per unit",
    "break-even units = exact units rounded up to a whole unit",
    "break-even revenue = fixed costs ÷ (contribution margin % ÷ 100)",
    "units for target profit = (fixed costs + target profit) ÷ contribution per unit, rounded up",
  ],
  assumptions: ["Price and variable cost per unit are constant at every volume.", "Fixed costs are fixed over the period and don't step up with volume.", "Everything produced is sold."],
  rounding: "Money and percentages to 2 decimals; exact units to 2 decimals; whole units rounded up (you can't sell part of a unit).",
  maxItems: 0,
  run(i) {
    const w: string[] = [];
    const c = i.price_per_unit - i.variable_cost_per_unit;
    if (c <= 0) {
      w.push("Price does not exceed variable cost, so every unit loses money and there is no break-even point.");
      return { results: { contribution_per_unit: round2(c), contribution_margin_pct: round2((c / i.price_per_unit) * 100), break_even_units_exact: null, break_even_units: null, break_even_revenue: null, units_for_target_profit: null, revenue_for_target_profit: null }, warnings: w };
    }
    const exact = i.fixed_costs / c;
    const ratio = c / i.price_per_unit;
    const target = i.target_profit === undefined ? null : (i.fixed_costs + i.target_profit) / c;
    return {
      results: {
        contribution_per_unit: round2(c),
        contribution_margin_pct: round2(ratio * 100),
        break_even_units_exact: round2(exact),
        break_even_units: Math.ceil(round(exact, 9)),
        break_even_revenue: round2(i.fixed_costs / ratio),
        units_for_target_profit: target === null ? null : Math.ceil(round(target, 9)),
        revenue_for_target_profit: target === null ? null : round2((i.fixed_costs + i.target_profit!) / ratio),
      },
      warnings: w,
    };
  },
};

// --------------------------------------------------------------- revenue forecast
const ScenarioInput = z
  .object({
    name: label("Scenario name"),
    monthly_growth_pct: percent("Monthly growth", { min: -100, max: 1000 }),
    monthly_churn_pct: percent("Monthly churn"),
  })
  .strict();
const RevenueForecastInput = z
  .object({
    currency,
    starting_mrr: nonNegative("Starting MRR"),
    months: count("Months").min(1, "forecast at least 1 month").max(60, "forecast at most 60 months"),
    scenarios: z.array(ScenarioInput).min(1, "add at least one scenario").max(5, "at most 5 scenarios"),
  })
  .strict()
  .refine((i) => new Set(i.scenarios.map((s) => s.name.toLowerCase())).size === i.scenarios.length, "scenario names must be unique");

export const revenueForecast: CalculationDefinition<z.infer<typeof RevenueForecastInput>, unknown> = {
  id: "revenue_forecast",
  version: "1",
  name: "Revenue forecast",
  summary: "Month-by-month MRR projection under named scenarios of growth and churn.",
  input: RevenueForecastInput,
  output: z
    .object({
      scenarios: z.array(
        z.object({ name: z.string(), monthly: z.array(z.object({ month: z.number().int(), mrr: z.number() }).strict()), ending_mrr: z.number(), ending_arr: z.number(), total_revenue: z.number() }).strict(),
      ),
      warnings,
    })
    .strict(),
  units: { "scenarios[].monthly[].mrr": "currency per month", "scenarios[].ending_mrr": "currency per month", "scenarios[].ending_arr": "currency per year", "scenarios[].total_revenue": "currency over the forecast" },
  formulas: [
    "MRR(month m) = MRR(m−1) × (1 + growth % ÷ 100 − churn % ÷ 100), floored at 0",
    "ending ARR = ending MRR × 12",
    "total revenue = sum of MRR for months 1..n",
  ],
  assumptions: ["Growth and churn rates are constant every month within a scenario.", "Growth is applied to the whole base (net new MRR as a share of MRR); expansion is part of growth.", "Month 0 is the starting MRR and is not counted in total revenue."],
  rounding: "Each month's MRR is rounded to the cent and the next month compounds on the rounded value, so the schedule adds up exactly; totals are sums of rounded months.",
  maxItems: 10,
  run(i) {
    const w: string[] = [];
    const scenarios = i.scenarios.map((s) => {
      let cents = toCents(i.starting_mrr, "Starting MRR");
      const factor = 1 + s.monthly_growth_pct / 100 - s.monthly_churn_pct / 100;
      const monthly: Array<{ month: number; mrr: number }> = [];
      let total = 0;
      for (let m = 1; m <= i.months; m++) {
        cents = Math.max(0, Math.round(round(cents * factor, 6)));
        monthly.push({ month: m, mrr: fromCents(cents) });
        total += cents;
      }
      if (factor <= 0) w.push(`In "${s.name}", churn is at least growth + 100%, so MRR falls to zero.`);
      return { name: s.name, monthly, ending_mrr: fromCents(cents), ending_arr: fromCents(cents * 12), total_revenue: fromCents(total) };
    });
    return { scenarios, warnings: w };
  },
};

// ---------------------------------------------------------------- budget variance
const BudgetLine = z
  .object({
    name: label("Line name"),
    type: z.enum(["revenue", "expense"], { message: "type must be revenue or expense" }),
    budget: amount("Budget"),
    actual: amount("Actual"),
  })
  .strict();
const BudgetVarianceInput = z
  .object({ currency, lines: z.array(BudgetLine).min(1, "add at least one line").max(200, "at most 200 lines") })
  .strict()
  .refine((i) => new Set(i.lines.map((l) => l.name.toLowerCase())).size === i.lines.length, "line names must be unique");

export const budgetVariance: CalculationDefinition<z.infer<typeof BudgetVarianceInput>, unknown> = {
  id: "budget_variance",
  version: "1",
  name: "Budget variance",
  summary: "Absolute and percentage variance per line, favourable or unfavourable by line type, with totals.",
  input: BudgetVarianceInput,
  output: z
    .object({
      lines: z.array(z.object({ name: z.string(), type: z.enum(["revenue", "expense"]), budget: z.number(), actual: z.number(), variance: z.number(), variance_pct: num, assessment: z.enum(["favorable", "unfavorable", "on_budget"]) }).strict()),
      totals: z.array(z.object({ type: z.enum(["revenue", "expense", "net"]), budget: z.number(), actual: z.number(), variance: z.number(), variance_pct: num, assessment: z.enum(["favorable", "unfavorable", "on_budget"]) }).strict()),
      largest_unfavorable: z.string().nullable(),
      warnings,
    })
    .strict(),
  units: { "lines[].budget": "currency", "lines[].actual": "currency", "lines[].variance": "currency", "lines[].variance_pct": "%", "totals[].budget": "currency", "totals[].actual": "currency", "totals[].variance": "currency", "totals[].variance_pct": "%" },
  formulas: [
    "variance = actual − budget",
    "variance % = variance ÷ |budget| × 100 (not calculated when budget is 0)",
    "revenue: actual above budget is favourable; expense: actual below budget is favourable; exactly equal is on budget",
    "net = revenue total − expense total, assessed like revenue",
  ],
  assumptions: ["Amounts are in one currency and the same period.", "Amounts are entered to the cent; sums are exact (computed in integer cents)."],
  rounding: "Amounts are exact to the cent; percentages to 2 decimals, half away from zero.",
  maxItems: 200,
  run(i) {
    const w: string[] = [];
    const assess = (type: "revenue" | "expense" | "net", v: number) => (v === 0 ? "on_budget" : (type === "expense" ? v < 0 : v > 0) ? "favorable" : "unfavorable");
    const pct = (v: number, b: number, name: string) => {
      const q = safeDiv(v * 100, Math.abs(b));
      if (q === null) w.push(`"${name}" has a budget of 0, so its variance % is not defined.`);
      return q === null ? null : round2(q);
    };
    const lines = i.lines.map((l) => {
      const b = toCents(l.budget, `Budget for "${l.name}"`);
      const a = toCents(l.actual, `Actual for "${l.name}"`);
      const v = a - b;
      return { name: l.name, type: l.type, budget: fromCents(b), actual: fromCents(a), variance: fromCents(v), variance_pct: pct(v, b, l.name), assessment: assess(l.type, v), _b: b, _a: a, _v: v };
    });
    const sum = (type: "revenue" | "expense") => {
      const ls = lines.filter((l) => l.type === type);
      return { b: ls.reduce((s, l) => s + l._b, 0), a: ls.reduce((s, l) => s + l._a, 0), n: ls.length };
    };
    const rev = sum("revenue");
    const exp = sum("expense");
    const total = (type: "revenue" | "expense" | "net", b: number, a: number) => ({ type, budget: fromCents(b), actual: fromCents(a), variance: fromCents(a - b), variance_pct: pct(a - b, b, `${type} total`), assessment: assess(type, a - b) as "favorable" | "unfavorable" | "on_budget" });
    const totals = [
      ...(rev.n ? [total("revenue", rev.b, rev.a)] : []),
      ...(exp.n ? [total("expense", exp.b, exp.a)] : []),
      ...(rev.n && exp.n ? [total("net", rev.b - exp.b, rev.a - exp.a)] : []),
    ];
    const worst = lines.filter((l) => l.assessment === "unfavorable").sort((x, y) => Math.abs(y._v) - Math.abs(x._v))[0];
    return { lines: lines.map(({ _b, _a, _v, ...l }) => (void _b, void _a, void _v, l)), totals, largest_unfavorable: worst?.name ?? null, warnings: w };
  },
};

// -------------------------------------------------------------- investment return
const InvestmentInput = z
  .object({
    currency,
    initial_investment: positive("Initial investment"),
    ending_value: nonNegative("Ending value"),
    cash_received: nonNegative("Cash received during the holding period").default(0),
    holding_period_years: positive("Holding period (years)").max(100, "holding period must be at most 100 years").optional(),
    annual_pre_tax_cash_flow: amount("Annual pre-tax cash flow").optional(),
    cash_invested: positive("Cash invested (equity)").optional(),
  })
  .strict();

export const investmentReturn: CalculationDefinition<z.infer<typeof InvestmentInput>, unknown> = {
  id: "investment_return",
  version: "1",
  name: "Investment return",
  summary: "Total gain, ROI, annualised return over a stated period, and cash-on-cash return.",
  input: InvestmentInput,
  output: z.object({ results: z.object({ total_gain: money, roi_pct: num, annualized_return_pct: num, cash_on_cash_pct: num }).strict(), warnings }).strict(),
  units: { "results.total_gain": "currency", "results.roi_pct": "% over the whole period", "results.annualized_return_pct": "% per year", "results.cash_on_cash_pct": "% per year" },
  formulas: [
    "total gain = ending value + cash received − initial investment",
    "ROI % = total gain ÷ initial investment × 100",
    "annualised return % = ((ending value + cash received) ÷ initial investment)^(1 ÷ years) − 1, × 100",
    "cash-on-cash % = annual pre-tax cash flow ÷ cash invested × 100 (cash invested defaults to the initial investment)",
  ],
  assumptions: [
    "Annualised return treats all cash received as if received at the end of the period (it is not an IRR); it is only calculated when a holding period is supplied.",
    "No taxes, fees or inflation unless already reflected in the amounts.",
  ],
  rounding: "Money and percentages to 2 decimals, half away from zero.",
  maxItems: 0,
  run(i) {
    const w: string[] = [];
    const end = i.ending_value + i.cash_received;
    const gain = end - i.initial_investment;
    let annualized: number | null = null;
    if (i.holding_period_years === undefined) w.push("No holding period supplied, so the return was not annualised; ROI covers the whole period.");
    else annualized = (Math.pow(end / i.initial_investment, 1 / i.holding_period_years) - 1) * 100;
    if (i.holding_period_years !== undefined && i.holding_period_years < 1) w.push("The holding period is under a year, so the annualised figure extrapolates a short period and can look extreme.");
    let coc: number | null = null;
    if (i.annual_pre_tax_cash_flow === undefined) w.push("No annual cash flow supplied, so cash-on-cash return was not calculated.");
    else coc = (i.annual_pre_tax_cash_flow / (i.cash_invested ?? i.initial_investment)) * 100;
    return { results: { total_gain: round2(gain), roi_pct: round2((gain / i.initial_investment) * 100), annualized_return_pct: annualized === null ? null : round2(annualized), cash_on_cash_pct: coc === null ? null : round2(coc) }, warnings: w };
  },
};

export const FINANCE = [unitEconomics, breakEven, revenueForecast, budgetVariance, investmentReturn];
