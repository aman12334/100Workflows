import type { Category, Workflow } from "./schema";

export interface SearchOptions {
  category?: Category | null;
  limit?: number;
}

export interface SearchHit {
  workflow: Workflow;
  score: number;
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from get have how i in into is it its my me of on or our so that the their them this to want we with without you your".split(" "),
);

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * A deliberately small suffix stripper ("customers" → "customer", "pricing" →
 * "pric"), applied to both the query and the catalog, so plural and verb forms
 * match without a stemming dependency.
 */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const [suffix, replacement] of [["ies", "y"], ["ing", ""], ["ers", "er"], ["ed", ""], ["es", ""], ["s", ""]] as const) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) return token.slice(0, -suffix.length) + replacement;
  }
  return token;
}

const terms = (value: string) => tokenize(value).map(stem);

// Field weights: names and problem statements matter more than long descriptions.
const FIELDS: Array<[number, (w: Workflow) => string]> = [
  [4, (w) => `${w.name} ${w.id}`],
  [3, (w) => w.tags.join(" ")],
  [3, (w) => w.problems.join(" ")],
  [2, (w) => w.summary],
  [1, (w) => `${w.description} ${w.category} ${w.outputs.map((o) => o.label).join(" ")}`],
];

/**
 * Deterministic keyword search. Good enough for a catalog of tens to low hundreds
 * of definitions; the model does the semantic matching on top of these results.
 */
export function searchCatalog(workflows: Workflow[], query: string, options: SearchOptions = {}): SearchHit[] {
  const limit = options.limit ?? 6;
  const pool = options.category ? workflows.filter((w) => w.category === options.category) : workflows;
  const queryTerms = [...new Set(terms(query))];

  if (queryTerms.length === 0) {
    return pool.slice(0, limit).map((workflow) => ({ workflow, score: 0 }));
  }

  const hits: SearchHit[] = [];
  for (const workflow of pool) {
    let score = 0;
    for (const [weight, field] of FIELDS) {
      const tokens = terms(field(workflow));
      for (const term of queryTerms) {
        // Prefix matching catches forms the stemmer misses ("price" vs "pric").
        if (tokens.some((t) => t === term || (term.length >= 4 && (t.startsWith(term) || term.startsWith(t)) && t.length >= 4))) {
          score += weight;
        }
      }
    }
    if (score > 0) hits.push({ workflow, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.workflow.name.localeCompare(b.workflow.name)).slice(0, limit);
}
