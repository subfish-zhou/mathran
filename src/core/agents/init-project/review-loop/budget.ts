/**
 * Review-loop budget + cost estimation (DESIGN-REFERENCE §6.6).
 *
 * The rewrite loop is bounded by two limits per artifact:
 *   - maxRevisions  : default 3 — hard cap on writer rewrites.
 *   - costAlarmUsd  : default $5 — once cumulative estimated spend exceeds this
 *                     we accept the current draft with `flagged_persistent`.
 *
 * Cost is estimated, not metered: mathran's SpineLLM adapter does not surface
 * token usage, so we approximate tokens from character counts (~4 chars/token)
 * and apply a coarse, provider-aware price table keyed on the routing label.
 * The numbers are deliberately rough order-of-magnitude heuristics whose only
 * job is to trip the alarm on pathological runs; they are not billing-accurate.
 */

export interface ReviewLoopBudget {
  maxRevisions: number;
  costAlarmUsd: number;
}

export const DEFAULT_REVIEW_LOOP_BUDGET: ReviewLoopBudget = {
  maxRevisions: 3,
  costAlarmUsd: 5,
};

/** Estimated USD per 1K tokens, {in, out}, keyed by substring of model label. */
interface Price {
  in: number;
  out: number;
}

const PRICE_TABLE: Array<{ match: RegExp; price: Price }> = [
  // Anthropic Opus-class (default reviewer) — premium.
  { match: /opus/i, price: { in: 0.015, out: 0.075 } },
  // Anthropic Sonnet-class.
  { match: /sonnet/i, price: { in: 0.003, out: 0.015 } },
  // Anthropic Haiku-class.
  { match: /haiku/i, price: { in: 0.0008, out: 0.004 } },
  // OpenAI GPT-5-class (default writer).
  { match: /gpt-?5/i, price: { in: 0.005, out: 0.015 } },
  // OpenAI GPT-4-class.
  { match: /gpt-?4/i, price: { in: 0.0025, out: 0.01 } },
];

const FALLBACK_PRICE: Price = { in: 0.003, out: 0.015 };

function priceFor(model: string): Price {
  for (const { match, price } of PRICE_TABLE) {
    if (match.test(model)) return price;
  }
  return FALLBACK_PRICE;
}

/** Approximate token count from a character length (~4 chars/token). */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/**
 * Default cost estimator: provider-aware price table × estimated tokens.
 * Callers may inject their own `estimateCost` to plug in real metering.
 */
export function estimateCost(model: string, tokens: { in: number; out: number }): number {
  const p = priceFor(model);
  return (tokens.in / 1000) * p.in + (tokens.out / 1000) * p.out;
}
