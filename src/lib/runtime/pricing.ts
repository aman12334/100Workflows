import type { Usage } from "./budget";

/**
 * Estimated model cost, only where a list price has been verified.
 *
 * Nothing here is invented: every entry is copied from a published price table,
 * with its source and the date it was read. A model that is not listed gets no
 * estimate (cost `null` with a reason) rather than a guess. In particular:
 *  - OpenAI models are not listed: no verified price table was available when this was written.
 *  - Claude Haiku 5.5 is not listed: its price depends on prompt length (tiered), which a
 *    per-token estimate from totals can't represent correctly.
 *
 * What an estimate leaves out (shown next to every estimate in the UI):
 *  - web search charges (billed per search, not per token),
 *  - prompt-caching discounts or surcharges,
 *  - partner-platform pricing (Bedrock, Vertex AI) and any negotiated rates.
 */

export interface PriceBasis {
  model: string;
  /** US dollars per million input tokens. */
  inputPerMTok: number;
  /** US dollars per million output tokens. */
  outputPerMTok: number;
  source: string;
}

const ANTHROPIC_SOURCE = "Anthropic first-party API list prices, Claude API reference (price table cached 2026-11-03)";

export const VERIFIED_PRICES: Readonly<Record<string, PriceBasis>> = Object.freeze({
  "claude-fable-5-2": { model: "claude-fable-5-2", inputPerMTok: 8, outputPerMTok: 40, source: ANTHROPIC_SOURCE },
  "claude-fable-5-1": { model: "claude-fable-5-1", inputPerMTok: 10, outputPerMTok: 50, source: ANTHROPIC_SOURCE },
  "claude-opus-5-5": { model: "claude-opus-5-5", inputPerMTok: 4, outputPerMTok: 20, source: ANTHROPIC_SOURCE },
  "claude-opus-5": { model: "claude-opus-5", inputPerMTok: 5, outputPerMTok: 25, source: ANTHROPIC_SOURCE },
  "claude-sonnet-5-5": { model: "claude-sonnet-5-5", inputPerMTok: 2, outputPerMTok: 10, source: ANTHROPIC_SOURCE },
  "claude-sonnet-5": { model: "claude-sonnet-5", inputPerMTok: 2, outputPerMTok: 10, source: ANTHROPIC_SOURCE },
});

export const COST_EXCLUSIONS = "Estimate from token counts at list price. Excludes web search charges, caching discounts and partner or negotiated pricing.";

/** The verified price for a model id, or null. Exact ids only: a date suffix or alias is not assumed to cost the same. */
export function pricingFor(model: string | null | undefined): PriceBasis | null {
  if (!model) return null;
  return Object.hasOwn(VERIFIED_PRICES, model) ? VERIFIED_PRICES[model] : null;
}

/** Why a run has no estimate, in plain language. */
export function noPriceReason(model: string | null | undefined): string {
  return model ? `Cost not estimated: no verified price for ${model}.` : "Cost not estimated: this run was recorded before cost tracking.";
}

/** US dollars for this usage at the given basis, rounded to a millionth of a dollar. Null when there is no basis. */
export function estimateCostUsd(usage: Pick<Usage, "inputTokens" | "outputTokens"> | null | undefined, basis: PriceBasis | null): number | null {
  if (!usage || !basis) return null;
  const usd = (usage.inputTokens * basis.inputPerMTok + usage.outputTokens * basis.outputPerMTok) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** "$0.0123", "<$0.0001" or "—". */
export function formatUsd(usd: number | null): string {
  if (usd === null) return "—";
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
