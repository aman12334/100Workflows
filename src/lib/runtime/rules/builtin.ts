import { z } from "zod";
import { schemaAt } from "@/lib/catalog/output-schema";
import { isBlank, select } from "./path";
import type { RuleContext, RuleDefinition, RuleOutcome } from "./registry";

/**
 * Built-in deterministic rules. Each one scores with partial credit (good items
 * ÷ total) and writes a detail a person, and the model on a retry, can act on.
 *
 * Ids are permanent. Changing what an existing rule accepts would silently
 * change the result of packages that pinned a definition using it.
 */

const inputKey = z.string().regex(/^[a-z][a-z0-9_]*$/, "must be an input key, e.g. max_questions");
const path = z.string().min(1, "must be a path, e.g. questions[].text");

function defineRule<P>(rule: RuleDefinition<P>): RuleDefinition<P> {
  return rule;
}

const pass = (detail: string): RuleOutcome => ({ passed: true, score: 1, detail });
const quote = (s: string, max = 80) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;
const listOf = (items: string[], max = 4) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Reads a whole-number input such as max_questions, accepting numbers and numeric text. */
function wholeNumberInput(ctx: RuleContext, key: string | undefined): number | undefined {
  if (!key) return undefined;
  const v = ctx.inputs[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const count = defineRule({
  id: "count",
  summary: "A list has between min and max items. The maximum can come from an input, e.g. a user's question limit.",
  params: z
    .object({
      path,
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(),
      maxFromInput: inputKey.optional(),
    })
    .strict()
    .refine((p) => p.min !== undefined || p.max !== undefined || p.maxFromInput !== undefined, "set min, max or maxFromInput")
    .refine((p) => p.min === undefined || p.max === undefined || p.min <= p.max, "min is greater than max"),
  outputPaths: (p) => [{ param: "path", path: p.path, types: ["array"] }],
  inputKeys: (p) => (p.maxFromInput ? [p.maxFromInput] : []),
  run(p, ctx) {
    const { values } = select(ctx.output, p.path);
    const list = values.length === 1 ? values[0] : undefined;
    if (!Array.isArray(list)) return { passed: false, score: 0, detail: `"${p.path}" is missing from the output.` };

    const fromInput = wholeNumberInput(ctx, p.maxFromInput);
    const max = fromInput ?? p.max;
    const source = fromInput !== undefined ? ` (your ${p.maxFromInput} setting)` : "";
    const n = list.length;
    if (p.min !== undefined && n < p.min) {
      return { passed: false, score: p.min === 0 ? 0 : n / p.min, detail: `${plural(n, "item")} in ${p.path}; needs at least ${p.min}.` };
    }
    if (max !== undefined && n > max) {
      return { passed: false, score: n === 0 ? 0 : max / n, detail: `${plural(n, "item")} in ${p.path}; must be at most ${max}${source}.` };
    }
    const bounds = [p.min !== undefined ? `at least ${p.min}` : "", max !== undefined ? `at most ${max}${source}` : ""].filter(Boolean).join(", ");
    return pass(`${plural(n, "item")} in ${p.path} (${bounds}).`);
  },
});

const requiredFields = defineRule({
  id: "required_fields",
  summary: "Every item in a list fills in the named fields (not blank).",
  params: z.object({ path, fields: z.array(inputKey).min(1) }).strict(),
  outputPaths: (p) => [{ param: "path", path: p.path, types: ["object"] }],
  staticCheck(p, schema) {
    const node = schemaAt(schema, p.path);
    if (node?.type !== "object") return [];
    return p.fields.filter((f) => !Object.hasOwn(node.properties, f)).map((f) => `field "${f}" is not a property of ${p.path}`);
  },
  run(p, ctx) {
    const items = select(ctx.output, p.path).values;
    if (items.length === 0) return pass(`No items in ${p.path} to check.`);
    const problems: string[] = [];
    items.forEach((item, i) => {
      const record = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
      const empty = p.fields.filter((f) => !record || isBlank(record[f]));
      if (empty.length) problems.push(`item ${i + 1} is missing ${empty.join(" and ")}`);
    });
    const good = items.length - problems.length;
    return problems.length
      ? { passed: false, score: good / items.length, detail: `${good}/${items.length} items in ${p.path} are complete: ${listOf(problems)}.` }
      : pass(`All ${plural(items.length, "item")} in ${p.path} have ${p.fields.join(" and ")}.`);
  },
});

/** Lowercases, unifies quotes and whitespace, and trims surrounding punctuation, so formatting can't hide a match. */
export function normalizeForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'.,;:!?…\s-]+|["'.,;:!?…\s-]+$/g, "");
}

function inputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(inputText).join("\n");
  return "";
}

const verbatimInInputs = defineRule({
  id: "verbatim_in_inputs",
  summary: "Every quoted piece of evidence appears word-for-word in the named inputs, so the model can't present invented facts as known.",
  params: z
    .object({
      path,
      inputs: z.array(inputKey).min(1),
      /** Shorter quotes can't prove anything ("the", "yes"); they fail instead of passing trivially. */
      minChars: z.number().int().min(1).max(200).default(12),
    })
    .strict(),
  outputPaths: (p) => [{ param: "path", path: p.path, types: ["string"] }],
  inputKeys: (p) => p.inputs,
  run(p, ctx) {
    const quotes = select(ctx.output, p.path).values;
    if (quotes.length === 0) return pass(`No quoted evidence in ${p.path} to check.`);
    const haystack = normalizeForQuote(p.inputs.map((k) => inputText(ctx.inputs[k])).join("\n"));
    const problems: string[] = [];
    for (const q of quotes) {
      const needle = typeof q === "string" ? normalizeForQuote(q) : "";
      if (needle.length < p.minChars) problems.push(`${typeof q === "string" ? quote(q) : "a non-text value"} is too short to verify`);
      else if (!haystack.includes(needle)) problems.push(`${quote(String(q))} is not in your ${p.inputs.join(" or ")}`);
    }
    const good = quotes.length - problems.length;
    return problems.length
      ? { passed: false, score: good / quotes.length, detail: `${good}/${quotes.length} quotes found word-for-word: ${listOf(problems, 3)}.` }
      : pass(`All ${plural(quotes.length, "quote")} appear word-for-word in your ${p.inputs.join(" or ")}.`);
  },
});

const references = defineRule({
  id: "references",
  summary: "Ids referenced in one place exist in another (e.g. questions test known hypotheses), optionally requiring every target to be referenced.",
  params: z
    .object({
      from: path,
      to: path,
      everyTargetReferenced: z.boolean().default(false),
    })
    .strict(),
  outputPaths: (p) => [
    { param: "from", path: p.from, types: ["string"] },
    { param: "to", path: p.to, types: ["string"] },
  ],
  run(p, ctx) {
    const targets = select(ctx.output, p.to).values.filter((v): v is string => typeof v === "string");
    const refs = select(ctx.output, p.from).values.filter((v): v is string => typeof v === "string");
    const known = new Set(targets);
    const used = new Set(refs);
    const dangling = [...new Set(refs.filter((r) => !known.has(r)))];
    const unreferenced = p.everyTargetReferenced ? [...new Set(targets.filter((t) => !used.has(t)))] : [];

    const total = refs.length + (p.everyTargetReferenced ? targets.length : 0);
    const bad = refs.filter((r) => !known.has(r)).length + (p.everyTargetReferenced ? targets.filter((t) => !used.has(t)).length : 0);
    const problems = [
      dangling.length ? `${listOf(dangling)} ${dangling.length === 1 ? "is" : "are"} referenced in ${p.from} but not defined in ${p.to}` : "",
      unreferenced.length ? `${listOf(unreferenced)} in ${p.to} ${unreferenced.length === 1 ? "is" : "are"} never referenced from ${p.from}` : "",
    ].filter(Boolean);

    if (problems.length) return { passed: false, score: total ? (total - bad) / total : 0, detail: `${problems.join("; ")}.` };
    if (total === 0) return pass(`No references in ${p.from} to check.`);
    return pass(
      p.everyTargetReferenced
        ? `Every reference in ${p.from} exists, and all ${plural(targets.length, "id")} in ${p.to} are referenced.`
        : `All ${plural(refs.length, "reference")} in ${p.from} exist in ${p.to}.`,
    );
  },
});

const maxWords = defineRule({
  id: "max_words",
  summary: "Each text at the path is at most N words.",
  params: z.object({ path, max: z.number().int().min(1) }).strict(),
  outputPaths: (p) => [{ param: "path", path: p.path, types: ["string"] }],
  run(p, ctx) {
    const texts = select(ctx.output, p.path).values.filter((v): v is string => typeof v === "string");
    if (texts.length === 0) return pass(`No text in ${p.path} to check.`);
    const long = texts
      .map((t, i) => ({ i, words: t.trim() ? t.trim().split(/\s+/).length : 0 }))
      .filter((t) => t.words > p.max);
    const good = texts.length - long.length;
    return long.length
      ? {
          passed: false,
          score: good / texts.length,
          detail: `${good}/${texts.length} texts in ${p.path} are within ${p.max} words: ${listOf(long.map((t) => `item ${t.i + 1} has ${t.words}`))}.`,
        }
      : pass(`All ${plural(texts.length, "text")} in ${p.path} are within ${p.max} words.`);
  },
});

const distinct = defineRule({
  id: "distinct",
  summary: "Values at the path don't repeat (case-insensitive for text unless caseSensitive is set).",
  params: z.object({ path, caseSensitive: z.boolean().default(false) }).strict(),
  outputPaths: (p) => [{ param: "path", path: p.path, types: ["string", "number", "integer"] }],
  run(p, ctx) {
    const values = select(ctx.output, p.path).values.filter((v) => typeof v === "string" || typeof v === "number");
    if (values.length === 0) return pass(`No values in ${p.path} to check.`);
    const keyOf = (v: unknown) => (typeof v === "string" && !p.caseSensitive ? normalizeForQuote(v) : String(v));
    const seen = new Map<string, number>();
    for (const v of values) seen.set(keyOf(v), (seen.get(keyOf(v)) ?? 0) + 1);
    const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${quote(k, 40)} ×${n}`);
    return repeated.length
      ? { passed: false, score: seen.size / values.length, detail: `${p.path} repeats ${listOf(repeated)}.` }
      : pass(`All ${plural(values.length, "value")} in ${p.path} are different.`);
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BUILTIN_RULES: ReadonlyArray<RuleDefinition<any>> = [count, requiredFields, verbatimInInputs, references, maxWords, distinct];

