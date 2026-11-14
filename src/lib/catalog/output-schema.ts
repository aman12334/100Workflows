import { z } from "zod";

/**
 * Machine-readable output schemas for schema-v2 workflow definitions.
 *
 * A definition declares its output as a small, deliberately limited subset of
 * JSON Schema. The subset is what both providers' structured-output modes
 * handle well, what Zod can turn into a validator (`toZod`), and what rules
 * can point into with a path (`schemaAt`). Anything outside it — $ref,
 * oneOf/anyOf, open objects, pattern properties — is rejected with a precise
 * error instead of being half-supported.
 */

interface Annotated {
  title?: string;
  description?: string;
}

export type JsonSchemaNode =
  | (Annotated & {
      type: "object";
      properties: Record<string, JsonSchemaNode>;
      required: string[];
      additionalProperties: false;
    })
  | (Annotated & { type: "array"; items: JsonSchemaNode; minItems?: number; maxItems?: number })
  | (Annotated & { type: "string"; enum?: string[]; minLength?: number; maxLength?: number })
  | (Annotated & { type: "number" | "integer"; minimum?: number; maximum?: number })
  | (Annotated & { type: "boolean" });

/** Limits that keep schemas readable, cheap to send with every request, and safe to walk recursively. */
export const OUTPUT_SCHEMA_LIMITS = { maxDepth: 6, maxNodes: 200, maxProperties: 50, maxEnum: 100 } as const;

const PROPERTY_KEY = /^[a-z][a-z0-9_]*$/;
const COMMON = ["type", "title", "description"];
const ALLOWED: Record<string, string[]> = {
  object: [...COMMON, "properties", "required", "additionalProperties"],
  array: [...COMMON, "items", "minItems", "maxItems"],
  string: [...COMMON, "enum", "minLength", "maxLength"],
  number: [...COMMON, "minimum", "maximum"],
  integer: [...COMMON, "minimum", "maximum"],
  boolean: COMMON,
};
const UNSUPPORTED_HINT: Record<string, string> = {
  $ref: "references are not supported; write the object inline",
  $defs: "definitions are not supported; write objects inline",
  definitions: "definitions are not supported; write objects inline",
  oneOf: "unions are not supported; use one object with clearly named fields",
  anyOf: "unions are not supported; use one object with clearly named fields",
  allOf: "composition is not supported; write the object inline",
  patternProperties: "open-ended keys are not supported; list every property",
  pattern: "regex patterns are not supported; check formats with a rule instead",
  format: "string formats are not supported; check formats with a rule instead",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

export interface SchemaProblem {
  /** Location inside the schema, e.g. "properties.facts.items.required". Empty for the root. */
  path: string;
  message: string;
}

/**
 * Checks that `value` is a valid output schema in the supported subset.
 * Returns every problem found (not just the first), each with its location.
 */
export function outputSchemaProblems(value: unknown): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  let nodes = 0;
  const add = (path: string[], message: string) => problems.push({ path: path.join("."), message });

  const walk = (node: unknown, path: string[], depth: number) => {
    nodes++;
    if (!isRecord(node)) return add(path, "must be a schema object");
    if (depth > OUTPUT_SCHEMA_LIMITS.maxDepth) return add(path, `nesting is deeper than ${OUTPUT_SCHEMA_LIMITS.maxDepth} levels`);

    const type = node.type;
    if (typeof type !== "string" || !(type in ALLOWED)) {
      return add([...path, "type"], `must be one of ${Object.keys(ALLOWED).join(", ")}`);
    }
    for (const key of Object.keys(node)) {
      if (ALLOWED[type].includes(key)) continue;
      add([...path, key], UNSUPPORTED_HINT[key] ?? `"${key}" is not allowed on a ${type} schema`);
    }
    for (const key of ["title", "description"] as const) {
      if (key in node && typeof node[key] !== "string") add([...path, key], "must be a string");
    }

    if (type === "object") {
      if (node.additionalProperties !== false) add([...path, "additionalProperties"], "must be false so outputs can't carry unexpected fields");
      if (!isRecord(node.properties) || Object.keys(node.properties).length === 0) {
        add([...path, "properties"], "must list at least one property");
      } else {
        const keys = Object.keys(node.properties);
        if (keys.length > OUTPUT_SCHEMA_LIMITS.maxProperties) add([...path, "properties"], `has more than ${OUTPUT_SCHEMA_LIMITS.maxProperties} properties`);
        for (const key of keys) {
          if (!PROPERTY_KEY.test(key)) add([...path, "properties", key], "property names must be snake_case, e.g. next_steps");
          walk(node.properties[key], [...path, "properties", key], depth + 1);
        }
      }
      if (!Array.isArray(node.required)) {
        add([...path, "required"], "must be an array of property names");
      } else {
        const seen = new Set<string>();
        for (const name of node.required) {
          if (typeof name !== "string") add([...path, "required"], "must contain only strings");
          else if (seen.has(name)) add([...path, "required"], `lists "${name}" twice`);
          else if (isRecord(node.properties) && !(name in node.properties)) add([...path, "required"], `"${name}" is not a declared property`);
          if (typeof name === "string") seen.add(name);
        }
      }
    }

    if (type === "array") {
      if (!("items" in node)) add([...path, "items"], "is required for arrays");
      else walk(node.items, [...path, "items"], depth + 1);
      for (const key of ["minItems", "maxItems"] as const) {
        if (key in node && !isCount(node[key])) add([...path, key], "must be a non-negative integer");
      }
      if (isCount(node.minItems) && isCount(node.maxItems) && (node.minItems as number) > (node.maxItems as number)) {
        add([...path, "minItems"], "is greater than maxItems");
      }
    }

    if (type === "string") {
      if ("enum" in node) {
        const values = node.enum;
        if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string")) {
          add([...path, "enum"], "must be a non-empty list of strings");
        } else {
          if (new Set(values).size !== values.length) add([...path, "enum"], "contains duplicates");
          if (values.length > OUTPUT_SCHEMA_LIMITS.maxEnum) add([...path, "enum"], `has more than ${OUTPUT_SCHEMA_LIMITS.maxEnum} values`);
        }
      }
      for (const key of ["minLength", "maxLength"] as const) {
        if (key in node && !isCount(node[key])) add([...path, key], "must be a non-negative integer");
      }
      if (isCount(node.minLength) && isCount(node.maxLength) && (node.minLength as number) > (node.maxLength as number)) {
        add([...path, "minLength"], "is greater than maxLength");
      }
    }

    if (type === "number" || type === "integer") {
      for (const key of ["minimum", "maximum"] as const) {
        if (key in node && (typeof node[key] !== "number" || !Number.isFinite(node[key]))) add([...path, key], "must be a finite number");
      }
      if (typeof node.minimum === "number" && typeof node.maximum === "number" && node.minimum > node.maximum) {
        add([...path, "minimum"], "is greater than maximum");
      }
    }
  };

  if (isRecord(value) && value.type !== "object") {
    problems.push({ path: "type", message: 'the top level must be an object ("type": "object")' });
  }
  walk(value, [], 1);
  if (nodes > OUTPUT_SCHEMA_LIMITS.maxNodes) problems.push({ path: "", message: `has more than ${OUTPUT_SCHEMA_LIMITS.maxNodes} schema nodes` });
  return problems;
}

/**
 * Zod schema for the `outputSchema` field of a definition. Validation errors
 * keep their location, so the catalog reports e.g.
 * `outputSchema.properties.facts.items.additionalProperties: must be false…`.
 */
export const OutputSchemaSpec = z.unknown().transform((value, ctx) => {
  const problems = outputSchemaProblems(value);
  for (const p of problems) {
    ctx.addIssue({ code: "custom", message: p.message, path: p.path ? p.path.split(".") : [] });
  }
  return problems.length ? z.NEVER : (value as JsonSchemaNode);
});

const zodCache = new Map<string, z.ZodType>();
const ZOD_CACHE_LIMIT = 200;

/**
 * Builds a validator for outputs from a schema that already passed
 * `outputSchemaProblems`. Cached by content: the catalog is re-read on every
 * request, so equal schemas arrive as new objects.
 */
export function toZod(spec: JsonSchemaNode): z.ZodType {
  const cacheKey = JSON.stringify(spec);
  const cached = zodCache.get(cacheKey);
  if (cached) return cached;
  const problems = outputSchemaProblems(spec);
  if (problems.length) throw new Error(`Invalid output schema: ${problems.map((p) => `${p.path || "(root)"}: ${p.message}`).join("; ")}`);
  const schema = z.fromJSONSchema(spec as Parameters<typeof z.fromJSONSchema>[0]);
  if (zodCache.size >= ZOD_CACHE_LIMIT) zodCache.delete(zodCache.keys().next().value as string);
  zodCache.set(cacheKey, schema);
  return schema;
}

/** One step of a parsed path: enter a property, or step into an array's items. */
export type PathToken = { kind: "property"; name: string } | { kind: "items" };

/**
 * Parses the path language rules use to point into an output:
 *   ""                    the whole output
 *   "questions"           the `questions` property (an array)
 *   "questions[]"         each item of `questions`
 *   "questions[].tests"   the `tests` field of each item
 *   "matrix[][]"          items of nested arrays
 * Returns null for malformed paths.
 */
export function parsePath(path: string): PathToken[] | null {
  if (path === "") return [];
  const tokens: PathToken[] = [];
  for (const part of path.split(".")) {
    const match = /^([a-z][a-z0-9_]*)((?:\[\])*)$/.exec(part);
    if (!match) return null;
    tokens.push({ kind: "property", name: match[1] });
    for (let i = 0; i < match[2].length / 2; i++) tokens.push({ kind: "items" });
  }
  return tokens;
}

/** The schema node a path points to, or null when the path doesn't exist in the schema. */
export function schemaAt(spec: JsonSchemaNode, path: string): JsonSchemaNode | null {
  const tokens = parsePath(path);
  if (!tokens) return null;
  let node: JsonSchemaNode = spec;
  for (const token of tokens) {
    if (token.kind === "property") {
      if (node.type !== "object" || !Object.hasOwn(node.properties, token.name)) return null;
      node = node.properties[token.name];
    } else {
      if (node.type !== "array") return null;
      node = node.items;
    }
  }
  return node;
}
