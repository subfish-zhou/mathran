/**
 * Model pricing table — Phase ζ / DESIGN-REFERENCE.md §5 row E (cost meter gap).
 *
 * Sibling of `copilot-models-cache.ts`: same function-based export shape (no
 * module-level Map exported) so tree-shaking + unit tests stay easy. Where
 * `copilot-models-cache.ts` answers "how big is this model's context window?",
 * this file answers "how many dollars did N input + M output tokens cost?".
 *
 * Prices are USD per 1,000,000 tokens, split input vs output. Snapshot of
 * PUBLICLY listed provider pricing as of 2026-01 (sourced from openai.com,
 * anthropic.com, ai.google.dev pricing pages). Sources at the time:
 *   - OpenAI gpt-4o:        $2.50 in / $10.00 out
 *   - OpenAI gpt-4o-mini:   $0.15 in / $0.60  out
 *   - Anthropic Sonnet 4.5: $3.00 in / $15.00 out
 *   - Anthropic Opus 4.5:   $5.00 in / $25.00 out
 *   - Google Gemini 2.5 Pro:$1.25 in / $10.00 out (≤200K-token prompt tier)
 *
 * IMPORTANT — do NOT invent prices. Copilot-served slugs that have no
 * verifiable public list price (the gpt-5.x family, claude-opus-4.6/4.7/4.8,
 * claude-sonnet-4.6, gemini-3.x previews) are intentionally `null`. A `null`
 * entry (or an unknown slug) makes {@link computeCostUsd} return `null`, which
 * the UI renders as "—" rather than a fake $0.00. When these models get a
 * published price, fill in the number and date the change in a comment.
 *
 * Real prices change. This is a point-in-time snapshot; treat the displayed
 * dollar figure as an estimate, not a billing source of truth.
 */

export interface ModelPrice {
  /** USD per 1,000,000 input (prompt) tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 output (completion) tokens. */
  outputPer1M: number;
}

// `null` => price is not publicly verifiable; callers treat as "unknown".
const PRICING_TABLE: Record<string, ModelPrice | null> = {
  // === gpt-5 family — no verifiable public list price (copilot-served) ===
  "gpt-5.5":               null,
  "gpt-5.4":               null,
  "gpt-5.4-mini":          null,
  "gpt-5.3-codex":         null,
  "gpt-5-mini":            null,
  // === gpt-4 family (OpenAI public list, 2026-01) ===
  "gpt-4o":                { inputPer1M: 2.50, outputPer1M: 10.00 },
  "gpt-4o-2024-05-13":     { inputPer1M: 2.50, outputPer1M: 10.00 },
  "gpt-4o-2024-08-06":     { inputPer1M: 2.50, outputPer1M: 10.00 },
  "gpt-4o-2024-11-20":     { inputPer1M: 2.50, outputPer1M: 10.00 },
  "gpt-4o-mini":           { inputPer1M: 0.15, outputPer1M: 0.60 },
  "gpt-4o-mini-2024-07-18":{ inputPer1M: 0.15, outputPer1M: 0.60 },
  // === claude family (Anthropic public list, 2026-01) ===
  "claude-opus-4.5":       { inputPer1M: 5.00, outputPer1M: 25.00 },
  "claude-opus-4.6":       null, // no public list price yet
  "claude-opus-4.7":       null, // no public list price yet
  "claude-opus-4.8":       null, // no public list price yet
  "claude-sonnet-4.5":     { inputPer1M: 3.00, outputPer1M: 15.00 },
  "claude-sonnet-4.6":     null, // no public list price yet
  // === gemini family (Google public list, 2026-01; ≤200K prompt tier) ===
  "gemini-2.5-pro":        { inputPer1M: 1.25, outputPer1M: 10.00 },
  "gemini-3-flash-preview":null, // preview, no list price
  "gemini-3.1-pro-preview":null, // preview, no list price
  "gemini-3.5-flash":      null, // no public list price yet
};

function stripProviderPrefix(model: string): string {
  const idx = model.indexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/**
 * Resolve the per-1M USD rates for a model slug. The slug may carry a
 * provider prefix (e.g. "copilot/gpt-4o", "anthropic/claude-opus-4.5");
 * the prefix is stripped before lookup.
 *
 * Returns `null` when the slug is unknown OR is a known-but-unpriced model
 * (those have a `null` table entry). Callers MUST treat `null` as "price
 * unavailable" and surface "—" rather than $0.00.
 */
export function costForModel(slug: string): ModelPrice | null {
  const bare = stripProviderPrefix(slug);
  const entry = PRICING_TABLE[bare];
  return entry ?? null;
}

/**
 * Dollar cost of `inputTokens` prompt + `outputTokens` completion for a model.
 *
 * Returns `null` when the model has no verifiable price (unknown slug or a
 * `null` table entry) so the UI can render "—".
 *
 * Behavior notes:
 *   - Zero tokens → $0 (a priced model that did no work cost nothing).
 *   - Negative token counts are clamped to 0 (defensive — token counters
 *     should never go negative, but we never want to report a negative cost).
 */
export function computeCostUsd(
  slug: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = costForModel(slug);
  if (!price) return null;
  const inTok = Math.max(0, inputTokens);
  const outTok = Math.max(0, outputTokens);
  return (inTok / 1_000_000) * price.inputPer1M + (outTok / 1_000_000) * price.outputPer1M;
}
