import { describe, expect, it } from "vitest";
import { normalCdf, round, toCents, CalcError } from "@/lib/runtime/calc/numbers";
import { CALCULATIONS, calculationRefs } from "@/lib/runtime/calc/registry";
import { CalculationFailed, runCalculation } from "@/lib/runtime/calc/runner";
import type { ToolCallRecord } from "@/lib/runtime/tools/runner";

/**
 * Every expected value below was worked out independently of the implementation
 * (by hand, or with Python's standard library for the statistics), then written
 * in as a literal. None is produced by the code under test.
 */

const calc = (ref: string, input: unknown) => runCalculation(ref, input).output as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fails = (ref: string, input: unknown, message: RegExp) => {
  let err: unknown;
  try {
    runCalculation(ref, input);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CalculationFailed);
  expect((err as Error).message).toMatch(message);
};

describe("numeric helpers", () => {
  it("rounds half away from zero without binary float errors", () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.675, 2)).toBe(2.68);
    expect(round(-1.005, 2)).toBe(-1.01);
    expect(round(0.1 + 0.2, 2)).toBe(0.3);
    expect(round(-0.004, 2)).toBe(0); // never -0
    expect(Object.is(round(-0.004, 2), -0)).toBe(false);
    expect(round(1e-7, 2)).toBe(0);
    expect(() => round(Number.NaN, 2)).toThrow(CalcError);
  });

  it("converts money to integer cents and refuses sub-cent amounts instead of rounding them silently", () => {
    expect(toCents(0.1, "x") + toCents(0.2, "x")).toBe(30);
    expect(toCents(19.99, "x")).toBe(1999);
    expect(() => toCents(10.005, "Budget")).toThrow(/more than 2 decimal places/);
  });

  it("normal CDF matches reference values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1.6448536269514722)).toBeCloseTo(0.05, 6);
  });
});

describe("registry and runner", () => {
  it("registers exactly the 13 Phase 3 calculations, each versioned and documented", () => {
    expect(calculationRefs()).toEqual([
      "ab_test@1", "acquisition_efficiency@1", "break_even@1", "budget_variance@1", "cohort_retention@1", "demand_forecast@1", "funnel@1",
      "inventory_reorder@1", "investment_return@1", "revenue_forecast@1", "supplier_scorecard@1", "unit_economics@1", "workforce_capacity@1",
    ]);
    expect(Object.isFrozen(CALCULATIONS)).toBe(true);
    for (const versions of Object.values(CALCULATIONS)) {
      for (const d of Object.values(versions)) {
        expect(d.formulas.length, d.id).toBeGreaterThan(0);
        expect(d.rounding, d.id).not.toBe("");
        expect(d.assumptions.length, d.id).toBeGreaterThan(0);
        expect(Object.keys(d.units).length, d.id).toBeGreaterThan(0);
      }
    }
  });

  it("refuses unregistered calculations and unknown versions", () => {
    fails("eval@1", {}, /not a registered calculation/);
    fails("unit_economics@2", {}, /not a registered calculation/);
    fails("unit_economics", {}, /not a registered calculation/);
  });

  it("validates input strictly: no coercion, no unknown fields, ranges enforced", () => {
    fails("break_even@1", { fixed_costs: "1000", price_per_unit: 10, variable_cost_per_unit: 5 }, /must be a number/);
    fails("break_even@1", { fixed_costs: 1000, price_per_unit: 10, variable_cost_per_unit: 5, script: "x" }, /Unrecognized key/);
    fails("break_even@1", { fixed_costs: -5, price_per_unit: 10, variable_cost_per_unit: 5 }, /can't be negative/);
    fails("break_even@1", { fixed_costs: 1e13, price_per_unit: 10, variable_cost_per_unit: 5 }, /out of range/);
    fails("break_even@1", { fixed_costs: Number.NaN, price_per_unit: 10, variable_cost_per_unit: 5 }, /must be a number|finite/);
  });

  it("logs every run, success or failure, with the calculation id and version", () => {
    const records: ToolCallRecord[] = [];
    runCalculation("break_even@1", { fixed_costs: 100, price_per_unit: 10, variable_cost_per_unit: 5 }, { record: (r) => records.push(r), stepId: "calculate" });
    expect(() => runCalculation("break_even@1", {}, { record: (r) => records.push(r) })).toThrow();
    expect(records.map((r) => [r.toolId, r.toolVersion, r.status, r.target])).toEqual([
      ["calculation:break_even", "1", "ok", "break_even@1"],
      ["calculation:break_even", "1", "error", "break_even@1"],
    ]);
    expect(records[1].errorKind).toBe("invalid_input");
  });

  it("is reproducible: the same input always gives the same output", () => {
    const input = { history: [10, 12, 14, 16, 18, 20, 22, 24], period_unit: "week", horizon: 2, method: "exponential_smoothing", alpha: 0.4 };
    expect(JSON.stringify(runCalculation("demand_forecast@1", input))).toBe(JSON.stringify(runCalculation("demand_forecast@1", input)));
  });

  it("stops on cancellation before running", () => {
    const c = new AbortController();
    c.abort();
    expect(() => runCalculation("break_even@1", { fixed_costs: 1, price_per_unit: 2, variable_cost_per_unit: 1 }, { signal: c.signal })).toThrow(/cancelled/);
  });

  it("enforces the per-calculation size budget", () => {
    fails("budget_variance@1", { lines: Array.from({ length: 201 }, (_, k) => ({ name: `L${k}`, type: "expense", budget: 1, actual: 1 })) }, /at most 200 lines/);
  });
});

describe("unit_economics@1", () => {
  it("calculates contribution, margin, lifetime, LTV, LTV:CAC and payback", () => {
    expect(calc("unit_economics@1", { revenue_per_customer_month: 100, variable_cost_per_customer_month: 30, cac: 420, monthly_churn_pct: 2.5 }).results).toEqual({
      contribution_per_customer_month: 70,
      gross_margin_pct: 70,
      customer_lifetime_months: 40,
      ltv: 2800,
      ltv_to_cac: 6.67,
      cac_payback_months: 6,
      lifetime_profit_per_customer: 2380,
    });
  });
  it("leaves LTV uncalculated, with a reason, when churn is missing or 0", () => {
    const missing = calc("unit_economics@1", { revenue_per_customer_month: 100, variable_cost_per_customer_month: 30, cac: 420 });
    expect([missing.results.ltv, missing.results.customer_lifetime_months]).toEqual([null, null]);
    expect(missing.warnings[0]).toMatch(/No churn rate/);
    expect(calc("unit_economics@1", { revenue_per_customer_month: 100, variable_cost_per_customer_month: 30, cac: 420, monthly_churn_pct: 0 }).warnings[0]).toMatch(/unbounded/);
  });
  it("handles negative contribution and zero CAC", () => {
    const loss = calc("unit_economics@1", { revenue_per_customer_month: 100, variable_cost_per_customer_month: 120, cac: 50, monthly_churn_pct: 5 });
    expect(loss.results).toMatchObject({ contribution_per_customer_month: -20, gross_margin_pct: -20, cac_payback_months: null, ltv: null });
    const free = calc("unit_economics@1", { revenue_per_customer_month: 50, variable_cost_per_customer_month: 10, cac: 0, monthly_churn_pct: 10 });
    expect(free.results).toMatchObject({ cac_payback_months: 0, ltv: 400, ltv_to_cac: null });
  });
  it("rejects zero revenue and impossible churn", () => {
    fails("unit_economics@1", { revenue_per_customer_month: 0, variable_cost_per_customer_month: 0, cac: 1 }, /greater than zero/);
    fails("unit_economics@1", { revenue_per_customer_month: 10, variable_cost_per_customer_month: 0, cac: 1, monthly_churn_pct: 120 }, /at most 100%/);
  });
});

describe("break_even@1", () => {
  it("calculates break-even units and revenue, and the volume for a target profit", () => {
    expect(calc("break_even@1", { fixed_costs: 10000, price_per_unit: 50, variable_cost_per_unit: 30, target_profit: 5000 }).results).toEqual({
      contribution_per_unit: 20,
      contribution_margin_pct: 40,
      break_even_units_exact: 500,
      break_even_units: 500,
      break_even_revenue: 25000,
      units_for_target_profit: 750,
      revenue_for_target_profit: 37500,
    });
  });
  it("rounds whole units up", () => {
    expect(calc("break_even@1", { fixed_costs: 10001, price_per_unit: 50, variable_cost_per_unit: 30 }).results).toMatchObject({ break_even_units_exact: 500.05, break_even_units: 501 });
  });
  it("reports no break-even when price doesn't cover variable cost, and handles zero fixed costs", () => {
    const none = calc("break_even@1", { fixed_costs: 1000, price_per_unit: 30, variable_cost_per_unit: 30 });
    expect(none.results.break_even_units).toBeNull();
    expect(none.warnings[0]).toMatch(/no break-even point/);
    expect(calc("break_even@1", { fixed_costs: 0, price_per_unit: 30, variable_cost_per_unit: 10 }).results.break_even_units).toBe(0);
  });
});

describe("revenue_forecast@1", () => {
  it("compounds monthly on the rounded cent, with totals that add up", () => {
    const out = calc("revenue_forecast@1", { starting_mrr: 10000, months: 3, scenarios: [{ name: "Base", monthly_growth_pct: 5, monthly_churn_pct: 2 }] });
    expect(out.scenarios[0]).toEqual({ name: "Base", monthly: [{ month: 1, mrr: 10300 }, { month: 2, mrr: 10609 }, { month: 3, mrr: 10927.27 }], ending_mrr: 10927.27, ending_arr: 131127.24, total_revenue: 31836.27 });
  });
  it("floors at zero and warns when churn wipes out the base", () => {
    const out = calc("revenue_forecast@1", { starting_mrr: 1000, months: 2, scenarios: [{ name: "Collapse", monthly_growth_pct: 0, monthly_churn_pct: 100 }] });
    expect(out.scenarios[0].ending_mrr).toBe(0);
    expect(out.warnings[0]).toMatch(/falls to zero/);
  });
  it("rejects sub-cent MRR, duplicate scenario names and out-of-range periods", () => {
    fails("revenue_forecast@1", { starting_mrr: 100.555, months: 1, scenarios: [{ name: "A", monthly_growth_pct: 1, monthly_churn_pct: 1 }] }, /more than 2 decimal places/);
    fails("revenue_forecast@1", { starting_mrr: 100, months: 1, scenarios: [{ name: "A", monthly_growth_pct: 1, monthly_churn_pct: 1 }, { name: "a", monthly_growth_pct: 2, monthly_churn_pct: 1 }] }, /unique/);
    fails("revenue_forecast@1", { starting_mrr: 100, months: 61, scenarios: [{ name: "A", monthly_growth_pct: 1, monthly_churn_pct: 1 }] }, /at most 60 months/);
  });
});

describe("budget_variance@1", () => {
  const lines = [
    { name: "Subscriptions", type: "revenue", budget: 50000, actual: 55000 },
    { name: "Software", type: "expense", budget: 8000, actual: 11200 },
    { name: "Contractors", type: "expense", budget: 20000, actual: 14500 },
    { name: "Travel", type: "expense", budget: 0, actual: 300 },
  ];
  it("calculates variances with the right favourable direction per line type, and exact totals", () => {
    const out = calc("budget_variance@1", { lines });
    expect(out.lines.map((l: any) => [l.name, l.variance, l.variance_pct, l.assessment])).toEqual([ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["Subscriptions", 5000, 10, "favorable"],
      ["Software", 3200, 40, "unfavorable"],
      ["Contractors", -5500, -27.5, "favorable"],
      ["Travel", 300, null, "unfavorable"],
    ]);
    expect(out.totals).toEqual([
      { type: "revenue", budget: 50000, actual: 55000, variance: 5000, variance_pct: 10, assessment: "favorable" },
      { type: "expense", budget: 28000, actual: 26000, variance: -2000, variance_pct: -7.14, assessment: "favorable" },
      { type: "net", budget: 22000, actual: 29000, variance: 7000, variance_pct: 31.82, assessment: "favorable" },
    ]);
    expect(out.largest_unfavorable).toBe("Software");
    expect(out.warnings[0]).toMatch(/"Travel" has a budget of 0/);
  });
  it("keeps cents exact where floats would drift", () => {
    const out = calc("budget_variance@1", { lines: [{ name: "A", type: "expense", budget: 0.1, actual: 0.3 }, { name: "B", type: "expense", budget: 0.2, actual: 0 }] });
    expect(out.lines[0].variance).toBe(0.2);
    expect(out.totals[0]).toMatchObject({ budget: 0.3, actual: 0.3, variance: 0, assessment: "on_budget" });
  });
  it("rejects sub-cent amounts, unknown line types and duplicate names", () => {
    fails("budget_variance@1", { lines: [{ name: "A", type: "expense", budget: 10.005, actual: 1 }] }, /more than 2 decimal places/);
    fails("budget_variance@1", { lines: [{ name: "A", type: "asset", budget: 1, actual: 1 }] }, /revenue or expense/);
    fails("budget_variance@1", { lines: [{ name: "A", type: "expense", budget: 1, actual: 1 }, { name: "a", type: "expense", budget: 1, actual: 1 }] }, /unique/);
  });
});

describe("investment_return@1", () => {
  it("calculates gain, ROI, annualised return and cash-on-cash", () => {
    expect(calc("investment_return@1", { initial_investment: 100000, ending_value: 150000, cash_received: 10000, holding_period_years: 5, annual_pre_tax_cash_flow: 8000 }).results).toEqual({
      total_gain: 60000,
      roi_pct: 60,
      annualized_return_pct: 9.86,
      cash_on_cash_pct: 8,
    });
  });
  it("only annualises with a holding period, and handles a total loss", () => {
    const noYears = calc("investment_return@1", { initial_investment: 1000, ending_value: 1100 });
    expect(noYears.results).toMatchObject({ roi_pct: 10, annualized_return_pct: null, cash_on_cash_pct: null });
    expect(noYears.warnings[0]).toMatch(/not annualised/);
    expect(calc("investment_return@1", { initial_investment: 1000, ending_value: 0, holding_period_years: 2 }).results).toMatchObject({ roi_pct: -100, annualized_return_pct: -100 });
  });
  it("rejects a zero investment", () => {
    fails("investment_return@1", { initial_investment: 0, ending_value: 1 }, /greater than zero/);
  });
});

describe("funnel@1", () => {
  it("calculates stage conversion, drop-off, overall conversion and the largest drops", () => {
    const out = calc("funnel@1", { stages: [{ name: "Visit", count: 10000 }, { name: "Signup", count: 4000 }, { name: "Trial", count: 1000 }, { name: "Paid", count: 300 }] });
    expect(out.transitions.map((t: any) => [t.conversion_pct, t.drop_off, t.drop_off_pct])).toEqual([[40, 6000, 60], [25, 3000, 75], [30, 700, 70]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.overall_conversion_pct).toBe(3);
    expect(out.largest_absolute_drop).toEqual({ from: "Visit", to: "Signup", drop_off: 6000 });
    expect(out.largest_relative_drop).toEqual({ from: "Signup", to: "Trial", drop_off_pct: 75 });
  });
  it("handles empty stages without dividing by zero, and flags increases", () => {
    const zero = calc("funnel@1", { stages: [{ name: "A", count: 100 }, { name: "B", count: 0 }, { name: "C", count: 0 }] });
    expect(zero.transitions.map((t: any) => t.conversion_pct)).toEqual([0, null]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(zero.overall_conversion_pct).toBe(0);
    const up = calc("funnel@1", { stages: [{ name: "A", count: 100 }, { name: "B", count: 120 }] });
    expect(up.transitions[0]).toMatchObject({ conversion_pct: 120, drop_off: -20 });
    expect(up.warnings[0]).toMatch(/larger than/);
    expect(up.largest_absolute_drop).toBeNull();
  });
  it("rejects fractional counts and single-stage funnels", () => {
    fails("funnel@1", { stages: [{ name: "A", count: 10.5 }, { name: "B", count: 1 }] }, /whole number/);
    fails("funnel@1", { stages: [{ name: "A", count: 10 }] }, /at least 2 stages/);
  });
});

describe("cohort_retention@1", () => {
  it("weights by cohort size over observed cohorts only, never treating missing as zero", () => {
    const out = calc("cohort_retention@1", {
      period_unit: "month",
      cohorts: [
        { name: "Jan", size: 100, retained: [60, 45, 40] },
        { name: "Feb", size: 200, retained: [100, 70, null] },
        { name: "Mar", size: 50, retained: [20, null, null] },
      ],
    });
    expect(out.cohorts.map((c: any) => c.retention_pct)).toEqual([[60, 45, 40], [50, 35, null], [40, null, null]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.by_period).toEqual([
      { period: 1, observed_cohorts: 3, retained_total: 180, cohort_size_total: 350, weighted_retention_pct: 51.43 },
      { period: 2, observed_cohorts: 2, retained_total: 115, cohort_size_total: 300, weighted_retention_pct: 38.33 },
      { period: 3, observed_cohorts: 1, retained_total: 40, cohort_size_total: 100, weighted_retention_pct: 40 },
    ]);
  });
  it("keeps genuine zero retention distinct from a missing observation", () => {
    const out = calc("cohort_retention@1", { period_unit: "week", cohorts: [{ name: "A", size: 10, retained: [0] }, { name: "B", size: 10, retained: [null] }] });
    expect(out.cohorts.map((c: any) => c.retention_pct[0])).toEqual([0, null]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.by_period[0]).toMatchObject({ observed_cohorts: 1, cohort_size_total: 10, weighted_retention_pct: 0 });
  });
  it("rejects retained counts larger than the cohort", () => {
    fails("cohort_retention@1", { period_unit: "month", cohorts: [{ name: "A", size: 10, retained: [11] }] }, /more than its size/);
  });
});

describe("acquisition_efficiency@1", () => {
  const base = { period: "Q2 2026", revenue_per_customer_month: 100, gross_margin_pct: 80 };
  it("calculates CAC, payback, shares and efficiency per channel and blended", () => {
    const out = calc("acquisition_efficiency@1", { ...base, channels: [{ name: "Ads", spend: 10000, new_customers: 50 }, { name: "Events", spend: 15000, new_customers: 20 }, { name: "SEO", spend: 5000, new_customers: 30 }] });
    expect(out.channels.map((c: any) => [c.name, c.cac, c.cac_payback_months, c.spend_share_pct, c.customer_share_pct, c.efficiency_index])).toEqual([ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["Ads", 200, 2.5, 33.33, 50, 1.5],
      ["Events", 750, 9.4, 50, 20, 0.4],
      ["SEO", 166.67, 2.1, 16.67, 30, 1.8],
    ]);
    expect(out.blended).toEqual({ spend: 30000, new_customers: 100, cac: 300, cac_payback_months: 3.8 });
    expect([out.lowest_cac_channel, out.highest_cac_channel]).toEqual(["SEO", "Events"]);
  });
  it("reports CAC as undefined for a channel with no customers", () => {
    const out = calc("acquisition_efficiency@1", { ...base, channels: [{ name: "Podcast", spend: 2000, new_customers: 0 }, { name: "Ads", spend: 1000, new_customers: 10 }] });
    expect(out.channels[0].cac).toBeNull();
    expect(out.warnings[0]).toMatch(/acquired no customers/);
  });
  it("needs a gross margin above 0 and a period", () => {
    fails("acquisition_efficiency@1", { ...base, gross_margin_pct: 0, channels: [{ name: "A", spend: 1, new_customers: 1 }] }, /above 0%/);
    fails("acquisition_efficiency@1", { revenue_per_customer_month: 100, gross_margin_pct: 80, channels: [{ name: "A", spend: 1, new_customers: 1 }] }, /period/i);
  });
});

describe("ab_test@1", () => {
  it("calculates rates, lift, interval and z-test when samples are large enough (not significant)", () => {
    const out = calc("ab_test@1", { control: { visitors: 10000, conversions: 500 }, treatment: { visitors: 10000, conversions: 560 }, confidence_level: "95" });
    expect(out.results).toEqual({ control_rate_pct: 5, treatment_rate_pct: 5.6, absolute_lift_pp: 0.6, relative_lift_pct: 12, ci_low_pp: -0.02, ci_high_pp: 1.22, z_score: 1.894, p_value: 0.0583, significance: "not_significant", confidence_level_pct: 95 });
    expect(out.method).toMatch(/Two-proportion z-test/);
  });
  it("calls a clear effect significant", () => {
    const out = calc("ab_test@1", { control: { visitors: 10000, conversions: 500 }, treatment: { visitors: 10000, conversions: 600 }, confidence_level: "95" });
    expect(out.results).toMatchObject({ absolute_lift_pp: 1, relative_lift_pct: 20, ci_low_pp: 0.37, ci_high_pp: 1.63, z_score: 3.102, p_value: 0.0019, significance: "significant" });
  });
  it("refuses a statistical conclusion on small samples and says why", () => {
    const out = calc("ab_test@1", { control: { visitors: 50, conversions: 3 }, treatment: { visitors: 50, conversions: 9 } });
    expect(out.results).toMatchObject({ control_rate_pct: 6, treatment_rate_pct: 18, significance: "not_assessed", z_score: null, p_value: null, ci_low_pp: null });
    expect(out.warnings[0]).toMatch(/Not enough data/);
  });
  it("handles a zero control rate and rejects impossible counts", () => {
    expect(calc("ab_test@1", { control: { visitors: 100, conversions: 0 }, treatment: { visitors: 100, conversions: 5 } }).results.relative_lift_pct).toBeNull();
    fails("ab_test@1", { control: { visitors: 10, conversions: 11 }, treatment: { visitors: 10, conversions: 1 } }, /can't exceed visitors/);
    fails("ab_test@1", { control: { visitors: 0, conversions: 0 }, treatment: { visitors: 10, conversions: 1 } }, /at least 1 visitor/);
  });
});

describe("inventory_reorder@1", () => {
  it("calculates safety stock and reorder point for daily demand and a lead time in weeks", () => {
    const out = calc("inventory_reorder@1", { average_demand: 20, demand_std_dev: 5, demand_period: "day", lead_time: 2, lead_time_unit: "week", service_level_pct: "95", current_stock: 300 });
    expect(out.results).toEqual({ daily_demand: 20, daily_demand_std_dev: 5, lead_time_days: 14, lead_time_std_dev_days: 0, demand_during_lead_time: 280, service_level_pct: 95, z_value: 1.6449, safety_stock: 31, reorder_point: 311, days_of_cover: 15, reorder_now: true });
  });
  it("converts monthly demand and lead time to days before combining them", () => {
    const out = calc("inventory_reorder@1", { average_demand: 600, demand_std_dev: 30, demand_period: "month", lead_time: 1, lead_time_unit: "month", service_level_pct: "95" });
    expect(out.results).toMatchObject({ daily_demand: 19.71, daily_demand_std_dev: 5.44, lead_time_days: 30.44, demand_during_lead_time: 600, safety_stock: 50, reorder_point: 650, reorder_now: null });
  });
  it("includes lead-time variability", () => {
    expect(calc("inventory_reorder@1", { average_demand: 20, demand_std_dev: 5, demand_period: "day", lead_time: 10, lead_time_std_dev: 2, lead_time_unit: "day", service_level_pct: "99" }).results).toMatchObject({ safety_stock: 101, reorder_point: 301 });
  });
  it("handles zero demand and rejects unsupported service levels or a missing unit", () => {
    const zero = calc("inventory_reorder@1", { average_demand: 0, demand_std_dev: 0, demand_period: "day", lead_time: 5, lead_time_unit: "day", service_level_pct: "95", current_stock: 10 });
    expect(zero.results).toMatchObject({ safety_stock: 0, reorder_point: 0, days_of_cover: null });
    fails("inventory_reorder@1", { average_demand: 1, demand_std_dev: 1, demand_period: "day", lead_time: 5, lead_time_unit: "day", service_level_pct: "96" }, /service level must be one of/);
    fails("inventory_reorder@1", { average_demand: 1, demand_std_dev: 1, lead_time: 5, lead_time_unit: "day", service_level_pct: "95" }, /day, week or month/);
  });
});

describe("demand_forecast@1", () => {
  const history = [10, 12, 14, 16, 18, 20, 22, 24];
  it("moving average with a holdout check against the naive baseline", () => {
    const out = calc("demand_forecast@1", { history, period_unit: "week", horizon: 2, method: "moving_average", window: 3 });
    expect(out.forecast).toEqual([{ period: 1, value: 22 }, { period: 2, value: 22 }]);
    expect(out.accuracy).toEqual({ assessed: true, holdout_periods: 2, mae: 5, rmse: 5.1, mape_pct: 21.59, naive_mae: 3, beats_naive: false });
  });
  it("simple exponential smoothing follows the stated recursion", () => {
    const out = calc("demand_forecast@1", { history: [10, 20], period_unit: "month", horizon: 1, method: "exponential_smoothing", alpha: 0.5 });
    expect(out.forecast).toEqual([{ period: 1, value: 15 }]);
    expect(out.parameters).toEqual({ window: null, alpha: 0.5 });
  });
  it("claims no accuracy when history is too short, and refuses history shorter than the method needs", () => {
    const short = calc("demand_forecast@1", { history: [7], period_unit: "day", horizon: 1, method: "naive" });
    expect(short.forecast).toEqual([{ period: 1, value: 7 }]);
    expect(short.accuracy.assessed).toBe(false);
    expect(short.warnings[0]).toMatch(/too short to test accuracy/);
    fails("demand_forecast@1", { history: [1, 2], period_unit: "day", horizon: 1, method: "moving_average", window: 3 }, /history too short/);
    fails("demand_forecast@1", { history: [1, 2], period_unit: "day", horizon: 1, method: "exponential_smoothing", alpha: 0 }, /alpha must be above 0/);
    fails("demand_forecast@1", { history: [1, -2], period_unit: "day", horizon: 1, method: "naive" }, /can't be negative/);
  });
  it("leaves MAPE undefined when the holdout actuals are all zero", () => {
    const out = calc("demand_forecast@1", { history: [5, 5, 5, 5, 5, 5, 0, 0], period_unit: "day", horizon: 2, method: "naive" });
    expect(out.accuracy).toMatchObject({ assessed: true, mape_pct: null, mae: 5 });
  });
});

describe("supplier_scorecard@1", () => {
  const metrics = [
    { id: "on_time_pct", name: "On-time delivery", weight: 50, direction: "higher_is_better", unit: "%" },
    { id: "defect_pct", name: "Defect rate", weight: 30, direction: "lower_is_better", unit: "%" },
    { id: "cost_index", name: "Cost index", weight: 20, direction: "lower_is_better", unit: "index" },
  ];
  it("normalises direction-aware, weights, ranks, and re-normalises over available data", () => {
    const out = calc("supplier_scorecard@1", {
      metrics,
      suppliers: [
        { name: "Alpha", values: [{ metric_id: "on_time_pct", value: 98 }, { metric_id: "defect_pct", value: 1.0 }, { metric_id: "cost_index", value: 100 }] },
        { name: "Beta", values: [{ metric_id: "on_time_pct", value: 90 }, { metric_id: "defect_pct", value: 0.5 }, { metric_id: "cost_index", value: 90 }] },
        { name: "Gamma", values: [{ metric_id: "on_time_pct", value: 94 }, { metric_id: "defect_pct", value: 2.0 }, { metric_id: "cost_index", value: null }] },
      ],
    });
    expect(out.weights).toEqual([{ metric_id: "on_time_pct", weight_pct: 50 }, { metric_id: "defect_pct", weight_pct: 30 }, { metric_id: "cost_index", weight_pct: 20 }]);
    expect(out.suppliers.map((s: any) => [s.name, s.score, s.rank, s.coverage_pct])).toEqual([["Alpha", 70, 1, 100], ["Beta", 50, 2, 100], ["Gamma", 31.25, 3, 80]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.suppliers[0].metric_scores[1]).toEqual({ metric_id: "defect_pct", value: 1, normalized: 66.67 });
    expect(out.warnings.some((w: string) => /"Gamma" is missing 1 metric value/.test(w))).toBe(true);
  });
  it("gives everyone full marks on a metric with no spread", () => {
    const out = calc("supplier_scorecard@1", { metrics: [metrics[0]], suppliers: [{ name: "A", values: [{ metric_id: "on_time_pct", value: 95 }] }, { name: "B", values: [{ metric_id: "on_time_pct", value: 95 }] }] });
    expect(out.suppliers.map((s: any) => [s.score, s.rank])).toEqual([[100, 1], [100, 1]]); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  it("rejects invalid weights, unknown metrics and bad directions", () => {
    fails("supplier_scorecard@1", { metrics: metrics.map((m) => ({ ...m, weight: 0 })), suppliers: [{ name: "A", values: [] }] }, /weights must add up to more than 0/);
    fails("supplier_scorecard@1", { metrics: [{ ...metrics[0], weight: -1 }], suppliers: [{ name: "A", values: [] }] }, /can't be negative/);
    fails("supplier_scorecard@1", { metrics, suppliers: [{ name: "A", values: [{ metric_id: "price", value: 1 }] }] }, /unknown metric/);
    fails("supplier_scorecard@1", { metrics: [{ ...metrics[0], direction: "up" }], suppliers: [{ name: "A", values: [] }] }, /higher_is_better or lower_is_better/);
  });
});

describe("workforce_capacity@1", () => {
  const tasks = [{ name: "Tickets", volume: 2000, minutes_per_task: 6 }, { name: "Calls", volume: 300, minutes_per_task: 20 }];
  it("calculates capacity, utilisation, the gap and the FTE needed", () => {
    const out = calc("workforce_capacity@1", { team_fte: 5, hours_per_week: 40, weeks: 4, productive_time_pct: 80, absence_pct: 10, target_utilization_pct: 85, tasks });
    expect(out.results).toEqual({ gross_hours: 800, available_hours: 576, required_hours: 300, utilization_pct: 52.08, capacity_at_target_hours: 489.6, gap_hours: -189.6, required_fte: 3.06, additional_fte: 0, required_headcount: 4 });
    expect(out.tasks).toEqual([{ name: "Tickets", hours: 200, share_pct: 66.67 }, { name: "Calls", hours: 100, share_pct: 33.33 }]);
  });
  it("handles a team of zero and flags over-capacity", () => {
    const none = calc("workforce_capacity@1", { team_fte: 0, hours_per_week: 40, weeks: 4, productive_time_pct: 80, tasks });
    expect(none.results).toMatchObject({ utilization_pct: null, additional_fte: 2.76 }); // 300 ÷ (40 × 4 × 0.8 × 0.85), absence defaults to 0%
    const over = calc("workforce_capacity@1", { team_fte: 1, hours_per_week: 40, weeks: 4, productive_time_pct: 80, tasks });
    expect(over.warnings[0]).toMatch(/over capacity/);
  });
  it("rejects impossible hours and 100% absence", () => {
    fails("workforce_capacity@1", { team_fte: 1, hours_per_week: 90, weeks: 4, productive_time_pct: 80, tasks }, /at most 80/);
    fails("workforce_capacity@1", { team_fte: 1, hours_per_week: 40, weeks: 4, productive_time_pct: 80, absence_pct: 100, tasks }, /below 100%/);
  });
});

describe("numbers_from_calculation rule", () => {
  // Imported lazily to keep this block self-contained.
  const check = async (text: string, output: unknown, input: unknown = {}) => {
    const { runRule } = await import("@/lib/runtime/rules/registry");
    return runRule({ id: "numbers_from_calculation", params: { path: "summary" } }, { output: { summary: text }, inputs: {}, upstream: {}, calculation: { input, output } });
  };
  const result = { results: { ltv: 2800, ratio: 6.6667, pct: 38.33, change: -2000, tiny: 0.0019 } };

  it("accepts numbers written at the same or lower precision, with separators, signs and units", async () => {
    expect((await check("LTV is $2,800, or 6.67x CAC (38.3%); costs fell 2,000; p = 0.0019.", result)).passed).toBe(true);
    expect((await check("Roughly 6.7x.", result)).passed).toBe(true);
  });
  it("rejects a number the calculation did not produce, even if close", async () => {
    const r = await check("LTV is 2,900 and the ratio is 6.6.", result);
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/2,900, 6\.6 are not in the calculated results/);
  });
  it("allows small counts and years, ignores ids like Q2 or S1, and accepts input values", async () => {
    expect((await check("Over 3 channels in Q2 2026, as S1 noted.", result)).passed).toBe(true);
    expect((await check("With 420 of CAC.", result, { cac: 420 })).passed).toBe(true);
    expect((await check("About 13 customers.", result)).passed).toBe(false);
  });
  it("fails closed when there are no calculation results", async () => {
    const { runRule } = await import("@/lib/runtime/rules/registry");
    expect(runRule({ id: "numbers_from_calculation", params: { path: "summary" } }, { output: { summary: "1" }, inputs: {}, upstream: {} }).passed).toBe(false);
  });
});
