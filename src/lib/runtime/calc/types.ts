import type { z } from "zod";

/**
 * A registered, versioned, deterministic calculation. Definitions reference it
 * as "<id>@<version>"; they never contain formulas or code.
 *
 * Contract for implementations:
 *  - pure: same input → same output; no clock, randomness, I/O or model calls
 *  - input and output are validated against strict Zod schemas by the runner
 *  - invalid or unsupported input throws CalcError with a plain-language reason
 *  - a value that can't be computed (e.g. division by zero) is null, with a warning
 *  - reported numbers are rounded as documented in `rounding`
 */
export interface CalculationDefinition<I = unknown, O = unknown> {
  id: string;
  version: string;
  name: string;
  summary: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /** Unit of each result field (dot paths; "[]" for list items), e.g. { "results.cac": "currency" }. */
  units: Record<string, string>;
  formulas: string[];
  assumptions: string[];
  rounding: string;
  /** Upper bound on list sizes in the input, enforced before running (execution budget). */
  maxItems: number;
  run(input: I): O & { warnings: string[] };
}

export interface CalculationResult<O = unknown> {
  calculation: string;
  version: string;
  input: unknown;
  output: O & { warnings: string[] };
  units: Record<string, string>;
  formulas: string[];
  assumptions: string[];
  rounding: string;
}
