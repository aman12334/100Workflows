import { LimitError } from "../budget";
import type { ToolCallRecord } from "../tools/runner";
import { CalcError } from "./numbers";
import { CALCULATIONS } from "./registry";
import type { CalculationResult } from "./types";

/**
 * Runs a registered calculation: allowlist and version check, input validation,
 * size limit, cancellation, deterministic execution, output validation (finite
 * numbers only), and one log record per run. Logs reuse the tool-call record
 * (tool id "calculation:<id>"), so they appear in the run trace and the
 * tool_calls table without a new migration.
 */

export class CalculationFailed extends Error {
  constructor(
    readonly kind: "not_registered" | "invalid_input" | "too_large" | "invalid_output" | "failed",
    message: string,
  ) {
    super(message);
  }
}

/** "unit_economics@1" → ["unit_economics", "1"]. */
export function parseCalcRef(ref: string): { id: string; version: string } | null {
  const m = ref.match(/^([a-z][a-z0-9_]*)@(\d+)$/);
  return m ? { id: m[1], version: m[2] } : null;
}

export function lookupCalculation(ref: string) {
  const parsed = parseCalcRef(ref);
  if (!parsed) return null;
  const versions = Object.hasOwn(CALCULATIONS, parsed.id) ? CALCULATIONS[parsed.id] : undefined;
  return versions && Object.hasOwn(versions, parsed.version) ? versions[parsed.version] : null;
}

function listSizes(value: unknown): number {
  if (Array.isArray(value)) return value.length + value.reduce<number>((n, v) => n + listSizes(v), 0);
  if (value && typeof value === "object") return Object.values(value).reduce<number>((n, v) => n + listSizes(v), 0);
  return 0;
}

function allFinite(value: unknown, path = "output"): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = allFinite(value[i], `${path}[${i}]`);
      if (bad) return bad;
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const bad = allFinite(v, `${path}.${k}`);
      if (bad) return bad;
    }
  }
  return null;
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

export function runCalculation(
  ref: string,
  rawInput: unknown,
  opts: { stepId?: string; signal?: AbortSignal; record?: (r: ToolCallRecord) => void; now?: () => number } = {},
): CalculationResult {
  const now = opts.now ?? Date.now;
  const started = now();
  const def = lookupCalculation(ref);
  const log = (status: "ok" | "error", output: unknown, err: CalculationFailed | null) =>
    opts.record?.({
      stepId: opts.stepId ?? "calculate",
      toolId: `calculation:${def?.id ?? ref}`,
      toolVersion: def?.version ?? "unknown",
      status,
      errorKind: err ? (err.kind === "not_registered" ? "not_allowed" : err.kind === "invalid_input" || err.kind === "too_large" ? "invalid_input" : err.kind === "invalid_output" ? "malformed_output" : "failed") : null,
      error: err ? err.message.slice(0, 500) : null,
      attempts: 1,
      target: ref,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      durationMs: Math.max(0, now() - started),
      inputBytes: bytes(rawInput),
      outputBytes: output === undefined ? 0 : bytes(output),
    });
  const fail = (kind: CalculationFailed["kind"], message: string): never => {
    const err = new CalculationFailed(kind, message);
    log("error", undefined, err);
    throw err;
  };

  if (opts.signal?.aborted) throw new LimitError("The run was cancelled.", "cancelled");
  if (!def) return fail("not_registered", `"${ref}" is not a registered calculation`);
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    return fail("invalid_input", parsed.error.issues.slice(0, 5).map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; "));
  }
  if (listSizes(parsed.data) > def.maxItems) return fail("too_large", `the input has more than ${def.maxItems} items`);

  let output: unknown;
  try {
    output = def.run(parsed.data);
  } catch (err) {
    if (err instanceof CalcError) return fail("invalid_input", err.message);
    return fail("failed", err instanceof Error ? err.message : String(err));
  }
  const bad = allFinite(output);
  if (bad) return fail("invalid_output", `${bad} is not a finite number`);
  const checked = def.output.safeParse(output);
  if (!checked.success) return fail("invalid_output", checked.error.issues[0]?.message ?? "output did not match its schema");
  log("ok", checked.data, null);
  return {
    calculation: def.id,
    version: def.version,
    input: parsed.data,
    output: checked.data as CalculationResult["output"],
    units: def.units,
    formulas: def.formulas,
    assumptions: def.assumptions,
    rounding: def.rounding,
  };
}
