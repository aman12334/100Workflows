import { z } from "zod";
import { CalcError, Z_ONE_SIDED, count, label, nonNegative, percent, positive, round, round1, round2, safeDiv } from "./numbers";
import type { CalculationDefinition } from "./types";

const num = z.number().nullable();
const warnings = z.array(z.string());
const uniqueNames = <T extends { name: string }>(list: T[]) => new Set(list.map((x) => x.name.toLowerCase())).size === list.length;

/** Days per period. A month is 365.25 ÷ 12 = 30.4375 days. */
export const DAYS: Record<"day" | "week" | "month", number> = { day: 1, week: 7, month: 365.25 / 12 };
const periodUnit = z.enum(["day", "week", "month"], { message: "unit must be day, week or month" });

// -------------------------------------------------------------- inventory reorder
const InventoryInput = z
  .object({
    item_unit: label("Item unit", 30).default("units"),
    average_demand: nonNegative("Average demand"),
    demand_std_dev: nonNegative("Demand standard deviation"),
    demand_period: periodUnit,
    lead_time: positive("Lead time"),
    lead_time_std_dev: nonNegative("Lead time standard deviation").default(0),
    lead_time_unit: periodUnit,
    service_level_pct: z.enum(["90", "95", "97.5", "98", "99", "99.5", "99.9"], { message: "service level must be one of 90, 95, 97.5, 98, 99, 99.5, 99.9" }),
    current_stock: nonNegative("Current stock").optional(),
  })
  .strict();

export const inventoryReorder: CalculationDefinition<z.infer<typeof InventoryInput>, unknown> = {
  id: "inventory_reorder",
  version: "1",
  name: "Reorder point and safety stock",
  summary: "Safety stock and reorder point for a target cycle service level, with demand and lead time converted to days first.",
  input: InventoryInput,
  output: z
    .object({
      results: z
        .object({
          daily_demand: z.number(),
          daily_demand_std_dev: z.number(),
          lead_time_days: z.number(),
          lead_time_std_dev_days: z.number(),
          demand_during_lead_time: z.number(),
          service_level_pct: z.number(),
          z_value: z.number(),
          safety_stock: z.number(),
          reorder_point: z.number(),
          days_of_cover: num,
          reorder_now: z.boolean().nullable(),
        })
        .strict(),
      method: z.string(),
      warnings,
    })
    .strict(),
  units: {
    "results.daily_demand": "units per day",
    "results.daily_demand_std_dev": "units per day",
    "results.lead_time_days": "days",
    "results.lead_time_std_dev_days": "days",
    "results.demand_during_lead_time": "units",
    "results.service_level_pct": "% of cycles without a stock-out",
    "results.z_value": "standard deviations",
    "results.safety_stock": "units (rounded up)",
    "results.reorder_point": "units (rounded up)",
    "results.days_of_cover": "days",
  },
  formulas: [
    "convert to days: day = 1, week = 7, month = 30.4375 days",
    "daily demand d = average demand ÷ days per demand period; daily σd = demand σ ÷ √(days per demand period)",
    "lead time LT and σLT in days = value × days per lead-time unit",
    "safety stock = z × √(LT × σd² + d² × σLT²), z from the cycle service level",
    "reorder point = d × LT + safety stock",
    "days of cover = current stock ÷ d",
  ],
  assumptions: [
    "Daily demand is independent from day to day and roughly normal, so its variance scales with the number of days.",
    "Demand and lead time are independent. Service level is the probability of no stock-out during one replenishment cycle.",
    "Demand and lead time are converted to the same unit (days) before any calculation, so weekly or monthly inputs are never mixed with daily ones.",
  ],
  rounding: "Safety stock and reorder point rounded up to whole units; demand and lead-time figures to 2 decimals; days of cover to 1 decimal.",
  maxItems: 0,
  run(i) {
    const w: string[] = [];
    const dp = DAYS[i.demand_period];
    const lp = DAYS[i.lead_time_unit];
    const d = i.average_demand / dp;
    const sd = i.demand_std_dev / Math.sqrt(dp);
    const lt = i.lead_time * lp;
    const slt = i.lead_time_std_dev * lp;
    const z = Z_ONE_SIDED[i.service_level_pct];
    const ss = z * Math.sqrt(lt * sd * sd + d * d * slt * slt);
    const rop = d * lt + ss;
    if (i.demand_std_dev === 0 && i.lead_time_std_dev === 0) w.push("Demand and lead time have no variability, so safety stock is 0; real demand rarely behaves that way.");
    if (d === 0) w.push("Average demand is 0, so days of cover is not defined.");
    const cover = i.current_stock === undefined ? null : safeDiv(i.current_stock, d);
    const ropUnits = Math.ceil(round(rop, 9));
    return {
      results: {
        daily_demand: round2(d),
        daily_demand_std_dev: round2(sd),
        lead_time_days: round2(lt),
        lead_time_std_dev_days: round2(slt),
        demand_during_lead_time: round2(d * lt),
        service_level_pct: Number(i.service_level_pct),
        z_value: round(z, 4),
        safety_stock: Math.ceil(round(ss, 9)),
        reorder_point: ropUnits,
        days_of_cover: cover === null ? null : round1(cover),
        reorder_now: i.current_stock === undefined ? null : i.current_stock <= ropUnits,
      },
      method: `Cycle service level ${i.service_level_pct}% (z = ${round(z, 4)}), safety stock = z × √(LT·σd² + d²·σLT²), in days.`,
      warnings: w,
    };
  },
};

// ----------------------------------------------------------------- demand forecast
const ForecastInput = z
  .object({
    history: z.array(nonNegative("History value")).min(1, "add at least one historical value").max(240, "at most 240 historical values"),
    period_unit: periodUnit,
    horizon: count("Horizon").min(1, "forecast at least 1 period").max(24, "forecast at most 24 periods"),
    method: z.enum(["moving_average", "exponential_smoothing", "naive"], { message: "method must be moving_average, exponential_smoothing or naive" }),
    window: count("Window").min(2, "window must be at least 2").max(24, "window must be at most 24").optional(),
    alpha: z.number().gt(0, "alpha must be above 0").max(1, "alpha must be at most 1").optional(),
  })
  .strict();

export const MIN_HOLDOUT_HISTORY = 8;

type Method = z.infer<typeof ForecastInput>["method"];
function fit(history: number[], method: Method, window: number, alpha: number): number {
  if (method === "naive") return history[history.length - 1];
  if (method === "moving_average") return history.slice(-window).reduce((s, v) => s + v, 0) / window;
  let level = history[0];
  for (let t = 1; t < history.length; t++) level = alpha * history[t] + (1 - alpha) * level;
  return level;
}
function minHistory(method: Method, window: number) {
  return method === "moving_average" ? window : method === "exponential_smoothing" ? 2 : 1;
}

export const demandForecast: CalculationDefinition<z.infer<typeof ForecastInput>, unknown> = {
  id: "demand_forecast",
  version: "1",
  name: "Baseline demand forecast",
  summary: "A flat baseline forecast by moving average, simple exponential smoothing or naive method, with a holdout accuracy check against a naive baseline when history allows.",
  input: ForecastInput,
  output: z
    .object({
      forecast: z.array(z.object({ period: z.number().int(), value: z.number() }).strict()),
      method: z.string(),
      parameters: z.object({ window: num, alpha: num }).strict(),
      accuracy: z
        .object({ assessed: z.boolean(), holdout_periods: z.number().int(), mae: num, rmse: num, mape_pct: num, naive_mae: num, beats_naive: z.boolean().nullable() })
        .strict(),
      warnings,
    })
    .strict(),
  units: { "forecast[].value": "units per period", "accuracy.mae": "units per period", "accuracy.rmse": "units per period", "accuracy.mape_pct": "%", "accuracy.naive_mae": "units per period" },
  formulas: [
    "naive: forecast = last observed value",
    "moving average (window w): forecast = mean of the last w values",
    "simple exponential smoothing (α): level₁ = y₁; levelₜ = α·yₜ + (1−α)·levelₜ₋₁; forecast = final level",
    "all three produce a flat forecast for every future period (no trend or seasonality)",
    `holdout (history ≥ ${MIN_HOLDOUT_HISTORY}): hold back h = min(horizon, ⌊n ÷ 4⌋) periods, fit on the rest, then MAE = mean|actual − forecast|, RMSE = √mean(error²), MAPE = mean(|error| ÷ actual) × 100 over non-zero actuals; compared with the naive method's MAE`,
  ],
  assumptions: [
    "History is in order, evenly spaced, in one unit, with no gaps.",
    "These are baselines: they don't model trend, seasonality, promotions or external drivers. Accuracy is only claimed when a holdout check was possible.",
  ],
  rounding: "Forecast values and error metrics to 2 decimals; MAPE to 2 decimals; half away from zero.",
  maxItems: 240,
  run(i) {
    const w: string[] = [];
    const window = i.window ?? 3;
    const alpha = i.alpha ?? 0.3;
    if (i.method === "moving_average" && i.window === undefined) w.push("No window given; used the default of 3 periods.");
    if (i.method === "exponential_smoothing" && i.alpha === undefined) w.push("No alpha given; used the default of 0.3.");
    const need = minHistory(i.method, window);
    if (i.history.length < need) throw new CalcError(`history too short: ${i.method.replace("_", " ")} needs at least ${need} values, got ${i.history.length}`);
    const level = fit(i.history, i.method, window, alpha);
    const forecast = Array.from({ length: i.horizon }, (_, k) => ({ period: k + 1, value: round2(level) }));

    const n = i.history.length;
    const h = Math.min(i.horizon, Math.floor(n / 4));
    let accuracy = { assessed: false, holdout_periods: 0, mae: null as number | null, rmse: null as number | null, mape_pct: null as number | null, naive_mae: null as number | null, beats_naive: null as boolean | null };
    if (n < MIN_HOLDOUT_HISTORY || h < 1 || n - h < need) {
      w.push(`History is too short to test accuracy (needs at least ${MIN_HOLDOUT_HISTORY} values); no accuracy is claimed for this forecast.`);
    } else {
      const train = i.history.slice(0, n - h);
      const actual = i.history.slice(n - h);
      const pred = fit(train, i.method, window, alpha);
      const naive = train[train.length - 1];
      const errors = actual.map((a) => a - pred);
      const mae = errors.reduce((s, e) => s + Math.abs(e), 0) / h;
      const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / h);
      const nonzero = actual.map((a, k) => [a, errors[k]] as const).filter(([a]) => a !== 0);
      const mape = nonzero.length ? (nonzero.reduce((s, [a, e]) => s + Math.abs(e) / a, 0) / nonzero.length) * 100 : null;
      if (mape === null) w.push("All holdout actuals are 0, so MAPE is not defined.");
      const naiveMae = actual.reduce((s, a) => s + Math.abs(a - naive), 0) / h;
      accuracy = { assessed: true, holdout_periods: h, mae: round2(mae), rmse: round2(rmse), mape_pct: mape === null ? null : round2(mape), naive_mae: round2(naiveMae), beats_naive: round2(mae) < round2(naiveMae) };
    }
    const label = i.method === "moving_average" ? `Moving average over the last ${window} ${i.period_unit}s` : i.method === "exponential_smoothing" ? `Simple exponential smoothing, alpha ${alpha}` : "Naive (last value)";
    return { forecast, method: label, parameters: { window: i.method === "moving_average" ? window : null, alpha: i.method === "exponential_smoothing" ? alpha : null }, accuracy, warnings: w };
  },
};

// ---------------------------------------------------------- supplier scorecard
const MetricDef = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, "metric id must be snake_case, e.g. on_time_pct"),
    name: label("Metric name"),
    weight: nonNegative("Weight"),
    direction: z.enum(["higher_is_better", "lower_is_better"], { message: "direction must be higher_is_better or lower_is_better" }),
    unit: label("Unit", 30),
  })
  .strict();
const SupplierInput = z
  .object({
    metrics: z.array(MetricDef).min(1, "add at least one metric").max(10, "at most 10 metrics"),
    suppliers: z
      .array(
        z
          .object({
            name: label("Supplier"),
            values: z.array(z.object({ metric_id: z.string(), value: z.number().finite().min(-1e12).max(1e12).nullable() }).strict()).max(10, "at most 10 values per supplier"),
          })
          .strict(),
      )
      .min(1, "add at least one supplier")
      .max(50, "at most 50 suppliers"),
  })
  .strict()
  .refine((i) => new Set(i.metrics.map((m) => m.id)).size === i.metrics.length, "metric ids must be unique")
  .refine((i) => uniqueNames(i.suppliers), "supplier names must be unique");

export const supplierScorecard: CalculationDefinition<z.infer<typeof SupplierInput>, unknown> = {
  id: "supplier_scorecard",
  version: "1",
  name: "Weighted supplier scorecard",
  summary: "Normalises each metric across suppliers (direction-aware), applies normalised weights, and ranks suppliers on a 0-100 score.",
  input: SupplierInput,
  output: z
    .object({
      weights: z.array(z.object({ metric_id: z.string(), weight_pct: z.number() }).strict()),
      suppliers: z.array(
        z.object({ name: z.string(), score: num, rank: num, coverage_pct: z.number(), metric_scores: z.array(z.object({ metric_id: z.string(), value: num, normalized: num }).strict()) }).strict(),
      ),
      warnings,
    })
    .strict(),
  units: { "weights[].weight_pct": "% of total weight", "suppliers[].score": "points (0-100)", "suppliers[].coverage_pct": "% of weight with data", "suppliers[].metric_scores[].normalized": "points (0-100)" },
  formulas: [
    "weight % = weight ÷ sum of weights × 100",
    "higher is better: normalised = (value − min) ÷ (max − min) × 100; lower is better: (max − value) ÷ (max − min) × 100; min and max across suppliers with a value",
    "if every supplier has the same value, everyone scores 100 on that metric",
    "score = Σ (weight × normalised) ÷ Σ weight, over the metrics the supplier has data for",
    "coverage % = weight of metrics with data ÷ total weight × 100; rank by score, ties share a rank",
  ],
  assumptions: [
    "Scores are relative to the suppliers compared: adding or removing a supplier changes everyone's normalised values.",
    "A missing value is excluded and that supplier's weights are re-normalised over the metrics it has; coverage shows how much of the scorecard that supplier was judged on. Missing is never treated as the worst value.",
  ],
  rounding: "Scores, normalised values and weights to 2 decimals, half away from zero.",
  maxItems: 600,
  run(i) {
    const w: string[] = [];
    const total = i.metrics.reduce((s, m) => s + m.weight, 0);
    if (total <= 0) throw new CalcError("weights must add up to more than 0");
    const valueOf = new Map<string, Map<string, number | null>>();
    for (const s of i.suppliers) {
      const unknown = s.values.map((v) => v.metric_id).filter((k) => !i.metrics.some((m) => m.id === k));
      if (unknown.length) throw new CalcError(`supplier "${s.name}" has values for unknown metric(s): ${unknown.join(", ")}`);
      if (new Set(s.values.map((v) => v.metric_id)).size !== s.values.length) throw new CalcError(`supplier "${s.name}" lists a metric twice`);
      valueOf.set(s.name, new Map(s.values.map((v) => [v.metric_id, v.value])));
    }
    const get = (supplier: string, metric: string) => valueOf.get(supplier)?.get(metric) ?? null;
    const ranges = new Map(
      i.metrics.map((m) => {
        const vals = i.suppliers.map((s) => get(s.name, m.id)).filter((v): v is number => v !== null);
        if (vals.length && Math.min(...vals) === Math.max(...vals)) w.push(`Every supplier has the same ${m.name}, so it doesn't separate them.`);
        if (!vals.length) w.push(`No supplier has a value for ${m.name}.`);
        return [m.id, vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null] as const;
      }),
    );
    const scored = i.suppliers.map((s) => {
      let wsum = 0;
      let acc = 0;
      const metric_scores = i.metrics.map((m) => {
        const v = get(s.name, m.id);
        const r = ranges.get(m.id);
        if (v === null || !r) return { metric_id: m.id, value: null, normalized: null };
        const spread = r.max - r.min;
        const norm = spread === 0 ? 1 : m.direction === "higher_is_better" ? (v - r.min) / spread : (r.max - v) / spread;
        wsum += m.weight;
        acc += m.weight * norm;
        return { metric_id: m.id, value: v, normalized: round2(norm * 100) };
      });
      const missing = metric_scores.filter((x) => x.value === null).length;
      if (missing) w.push(`"${s.name}" is missing ${missing} metric value${missing === 1 ? "" : "s"}; its score uses the rest.`);
      const score = wsum > 0 ? (acc / wsum) * 100 : null;
      return { name: s.name, score: score === null ? null : round2(score), coverage_pct: round2((wsum / total) * 100), metric_scores };
    });
    const ordered = [...scored].filter((s) => s.score !== null).sort((a, b) => b.score! - a.score!);
    const rankOf = (score: number) => ordered.findIndex((s) => s.score === score) + 1;
    return {
      weights: i.metrics.map((m) => ({ metric_id: m.id, weight_pct: round2((m.weight / total) * 100) })),
      suppliers: scored.map((s) => ({ ...s, rank: s.score === null ? null : rankOf(s.score) })),
      warnings: w,
    };
  },
};

// -------------------------------------------------------------- workforce capacity
const WorkforceInput = z
  .object({
    team_fte: nonNegative("Team size (FTE)"),
    hours_per_week: positive("Hours per week").max(80, "hours per week must be at most 80"),
    weeks: positive("Weeks in the period").max(52, "at most 52 weeks"),
    productive_time_pct: percent("Productive time").refine((v) => v > 0, "productive time must be above 0%"),
    absence_pct: percent("Absence").refine((v) => v < 100, "absence must be below 100%").default(0),
    target_utilization_pct: percent("Target utilisation").refine((v) => v > 0, "target utilisation must be above 0%").default(85),
    tasks: z.array(z.object({ name: label("Task"), volume: nonNegative("Volume"), minutes_per_task: positive("Minutes per task") }).strict()).min(1, "add at least one task").max(50, "at most 50 tasks"),
  })
  .strict()
  .refine((i) => uniqueNames(i.tasks), "task names must be unique");

export const workforceCapacity: CalculationDefinition<z.infer<typeof WorkforceInput>, unknown> = {
  id: "workforce_capacity",
  version: "1",
  name: "Workforce capacity",
  summary: "Available productive hours, required hours from task volumes, utilisation, the gap, and the FTE needed at a target utilisation.",
  input: WorkforceInput,
  output: z
    .object({
      results: z
        .object({
          gross_hours: z.number(),
          available_hours: z.number(),
          required_hours: z.number(),
          utilization_pct: num,
          capacity_at_target_hours: z.number(),
          gap_hours: z.number(),
          required_fte: num,
          additional_fte: num,
          required_headcount: num,
        })
        .strict(),
      tasks: z.array(z.object({ name: z.string(), hours: z.number(), share_pct: num }).strict()),
      warnings,
    })
    .strict(),
  units: {
    "results.gross_hours": "hours in the period",
    "results.available_hours": "productive hours in the period",
    "results.required_hours": "hours in the period",
    "results.utilization_pct": "%",
    "results.capacity_at_target_hours": "hours in the period",
    "results.gap_hours": "hours (positive = short of capacity)",
    "results.required_fte": "FTE",
    "results.additional_fte": "FTE",
    "results.required_headcount": "people (rounded up)",
    "tasks[].hours": "hours",
    "tasks[].share_pct": "%",
  },
  formulas: [
    "gross hours = team FTE × hours per week × weeks",
    "available hours = gross hours × (1 − absence %) × productive time %",
    "required hours = Σ volume × minutes per task ÷ 60",
    "utilisation % = required ÷ available × 100",
    "capacity at target = available × target utilisation %; gap = required − capacity at target",
    "required FTE = required ÷ (hours per week × weeks × (1 − absence %) × productive % × target utilisation %); additional FTE = max(0, required FTE − team FTE); headcount = required FTE rounded up",
  ],
  assumptions: ["Work can be spread evenly across the team and the period (no peaks, skills or shift constraints).", "Minutes per task include handling time; volumes are for the whole period."],
  rounding: "Hours to 1 decimal; percentages and FTE to 2 decimals; headcount rounded up to whole people.",
  maxItems: 50,
  run(i) {
    const w: string[] = [];
    const perFteGross = i.hours_per_week * i.weeks;
    const factor = (1 - i.absence_pct / 100) * (i.productive_time_pct / 100);
    const gross = i.team_fte * perFteGross;
    const available = gross * factor;
    const tasks = i.tasks.map((t) => ({ name: t.name, hours: (t.volume * t.minutes_per_task) / 60 }));
    const required = tasks.reduce((s, t) => s + t.hours, 0);
    const util = safeDiv(required * 100, available);
    if (util === null) w.push("There are no available hours (team size is 0), so utilisation is not defined.");
    else if (util > 100) w.push("Required hours exceed available hours: the team is over capacity.");
    const atTarget = available * (i.target_utilization_pct / 100);
    const perFteEffective = perFteGross * factor * (i.target_utilization_pct / 100);
    const fte = required / perFteEffective;
    return {
      results: {
        gross_hours: round1(gross),
        available_hours: round1(available),
        required_hours: round1(required),
        utilization_pct: util === null ? null : round2(util),
        capacity_at_target_hours: round1(atTarget),
        gap_hours: round1(required - atTarget),
        required_fte: round2(fte),
        additional_fte: round2(Math.max(0, fte - i.team_fte)),
        required_headcount: Math.ceil(round(fte, 9)),
      },
      tasks: tasks.map((t) => ({ name: t.name, hours: round1(t.hours), share_pct: required > 0 ? round2((t.hours / required) * 100) : null })),
      warnings: w,
    };
  },
};

export const OPERATIONS = [inventoryReorder, demandForecast, supplierScorecard, workforceCapacity];
