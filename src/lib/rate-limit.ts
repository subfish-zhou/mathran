/**
 * Rate-limit vocabulary.
 *
 * The standalone runtime does not enforce distributed rate limits, but the
 * Agent Gateway principal layer still classifies callers by `RateLimitKind`
 * for bookkeeping. Kept as a type-only contract ported from Mathub.
 */
export type RateLimitKind =
  | "bot"
  | "user-chat"
  | "user-tool"
  | "webhook-delivery"
  | "lean-build";
