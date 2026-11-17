import { z } from "zod";
import { normalizeForQuote } from "./builtin";
import { select } from "./path";
import type { RuleDefinition, RuleOutcome } from "./registry";

/**
 * Citation rules for research workflows. They check the output against the
 * sources the tools actually retrieved in this run (RuleContext.sources), so a
 * model can't cite a page that was never fetched or quote words a page doesn't
 * contain. Ids are permanent, like every rule.
 */

const path = z.string().min(1, "must be a path, e.g. findings[].source_ids[]");
const field = z.string().regex(/^[a-z][a-z0-9_]*$/, "must be a field name");
const pass = (detail: string): RuleOutcome => ({ passed: true, score: 1, detail });
const listOf = (items: string[], max = 4) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));
const short = (s: string, max = 70) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;

const citesSources: RuleDefinition<{ path: string; min: number }> = {
  id: "cites_sources",
  summary: "Every cited source id was retrieved in this run, and at least `min` different sources are cited.",
  params: z.object({ path, min: z.number().int().min(1).max(20).default(1) }).strict(),
  outputPaths: (p) => [{ param: "path", path: p.path, types: ["string"] }],
  run(p, ctx) {
    const retrieved = new Set((ctx.sources ?? []).map((s) => s.id));
    const cited = select(ctx.output, p.path).values.filter((v): v is string => typeof v === "string");
    const unknown = [...new Set(cited.filter((id) => !retrieved.has(id)))];
    const distinct = new Set(cited.filter((id) => retrieved.has(id))).size;
    if (unknown.length) {
      const good = cited.filter((id) => retrieved.has(id)).length;
      return { passed: false, score: cited.length ? good / cited.length : 0, detail: `${listOf(unknown)} ${unknown.length === 1 ? "was" : "were"} cited but never retrieved; cite only the listed source ids.` };
    }
    if (distinct < p.min) return { passed: false, score: distinct / p.min, detail: `${distinct} distinct source${distinct === 1 ? "" : "s"} cited in ${p.path}; needs at least ${p.min}.` };
    return pass(`All citations in ${p.path} point to retrieved sources (${distinct} distinct).`);
  },
};

const quotedFromSources: RuleDefinition<{ path: string; sourceField: string; quoteField: string; requireRead: boolean; minChars: number }> = {
  id: "quoted_from_sources",
  summary: "Each item's quote appears word for word in the source it cites; optionally that source must have been read in full, not only seen as a search result.",
  params: z
    .object({ path, sourceField: field, quoteField: field, requireRead: z.boolean().default(false), minChars: z.number().int().min(1).max(200).default(12) })
    .strict(),
  outputPaths: (p) => [
    { param: "path", path: p.path, types: ["object"] },
    { param: "sourceField", path: `${p.path}.${p.sourceField}`, types: ["string"] },
    { param: "quoteField", path: `${p.path}.${p.quoteField}`, types: ["string"] },
  ],
  run(p, ctx) {
    const byId = new Map((ctx.sources ?? []).map((s) => [s.id, { ...s, norm: normalizeForQuote(s.text) }]));
    const items = select(ctx.output, p.path).values.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
    if (!items.length) return pass(`No items in ${p.path} to check.`);
    const problems: string[] = [];
    for (const item of items) {
      const id = typeof item[p.sourceField] === "string" ? (item[p.sourceField] as string) : "";
      const q = typeof item[p.quoteField] === "string" ? (item[p.quoteField] as string) : "";
      const source = byId.get(id);
      const needle = normalizeForQuote(q);
      if (!source) problems.push(`${id || "(no id)"} is not a retrieved source`);
      else if (p.requireRead && source.via !== "page") problems.push(`${id} was only seen as a search result, never read in full`);
      else if (needle.length < p.minChars) problems.push(`the quote for ${id} is too short to verify`);
      else if (!source.norm.includes(needle)) problems.push(`${short(q)} is not in ${id}`);
    }
    const good = items.length - problems.length;
    return problems.length
      ? { passed: false, score: good / items.length, detail: `${good}/${items.length} quotes verified against their sources: ${listOf(problems, 3)}.` }
      : pass(`All ${items.length} quotes appear word for word in the sources they cite${p.requireRead ? ", all read in full" : ""}.`);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SOURCE_RULES: ReadonlyArray<RuleDefinition<any>> = [citesSources, quotedFromSources];
export const SOURCE_RULE_IDS = new Set(SOURCE_RULES.map((r) => r.id));
