/**
 * Pure formatting + color-bucket helpers for the chat-panel context meter
 * (v0.3 §19). Lives in `src/web/lib/` so vitest can test it without needing
 * a React DOM testing framework (the actual SPA at `web/src/` does NOT have
 * @testing-library/react installed; we surface that and ship pure-logic
 * tests instead — same principle the spec applies to the token counter).
 *
 * The actual React component (`web/src/components/ContextMeter.tsx`) imports
 * these helpers via a relative path so the SPA build stays self-contained
 * inside `web/`.
 */

/**
 * Format a token count as a short human-readable string with K / M suffix.
 *
 * Examples (matches the spec):
 *   1234     → "1.2K"
 *   12345    → "12K"
 *   123456   → "123K"
 *   1234567  → "1.2M"
 *
 * Below 1000 we just print the integer ("0", "42", "999").
 * Negative inputs collapse to 0; non-finite inputs collapse to 0.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) {
    // K range: <10K shows one decimal ("1.2K"), >=10K is integer ("12K", "123K").
    if (n < 10_000) {
      return `${(n / 1000).toFixed(1)}K`;
    }
    return `${Math.round(n / 1000)}K`;
  }
  if (n < 1_000_000_000) {
    if (n < 10_000_000) {
      return `${(n / 1_000_000).toFixed(1)}M`;
    }
    return `${Math.round(n / 1_000_000)}M`;
  }
  // Beyond a billion tokens? Round to one decimal "B".
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** Color bucket name; the React component maps these to Tailwind classes. */
export type MeterColor = "green" | "yellow" | "orange" | "red";

/**
 * Pick a color bucket for a given utilisation percentage.
 *   <50  → green
 *   <75  → yellow
 *   <90  → orange
 *   >=90 → red
 */
export function pickColor(percentage: number): MeterColor {
  if (!Number.isFinite(percentage) || percentage < 50) return "green";
  if (percentage < 75) return "yellow";
  if (percentage < 90) return "orange";
  return "red";
}

/** Clamp percentage into [0, 100] for the visual bar width. */
export function clampPercentage(percentage: number): number {
  if (!Number.isFinite(percentage) || percentage <= 0) return 0;
  if (percentage >= 100) return 100;
  return percentage;
}

/**
 * Build the canonical "12.3K / 200K tokens (6%)" label.
 * Used by the React component and asserted directly in unit tests.
 */
export function formatLabel(tokens: number, contextWindow: number, percentage: number): string {
  const t = formatTokens(tokens);
  const w = formatTokens(contextWindow);
  const pct = Number.isFinite(percentage) ? Math.round(percentage) : 0;
  return `${t} / ${w} tokens (${pct}%)`;
}
