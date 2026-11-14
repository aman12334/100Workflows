import { parsePath } from "@/lib/catalog/output-schema";

/** What a path picked out of an output. */
export interface Selection {
  values: unknown[];
  /** Places the path expected a value (or an array) but found none. */
  missing: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Selects values from a model output with the path language of
 * `parsePath` ("questions[].tests[]"). Each `[]` steps into every item of an
 * array, so one path can select many values. Paths are validated against the
 * output schema when the catalog loads; a malformed path here is a bug and throws.
 */
export function select(value: unknown, path: string): Selection {
  const tokens = parsePath(path);
  if (!tokens) throw new Error(`Malformed rule path "${path}"`);
  let frontier: unknown[] = [value];
  let missing = 0;
  for (const token of tokens) {
    const next: unknown[] = [];
    for (const v of frontier) {
      if (token.kind === "property") {
        if (isRecord(v) && Object.hasOwn(v, token.name) && v[token.name] !== undefined) next.push(v[token.name]);
        else missing++;
      } else if (Array.isArray(v)) {
        next.push(...v);
      } else {
        missing++;
      }
    }
    frontier = next;
  }
  return { values: frontier, missing };
}

/** True for values a person would call empty: missing, null, blank text, or an empty list. */
export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}
