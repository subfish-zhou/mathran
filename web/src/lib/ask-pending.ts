/**
 * v0.19 Codex parity — pure helpers that classify an `askPending` payload
 * into one of the discrete render modes the ToolCallDisplay widget needs.
 *
 * Kept in its own file (and out of the React component) so the
 * classification logic is unit-testable without spinning up a React
 * renderer. Mirrors the conditional branching in ToolCallDisplay so the
 * two stay in sync; if the widget ever grows another rendering branch,
 * extend `AskPendingMode` here first and consume it in the component.
 *
 * The legacy textarea-only render (a bare `ask_user({ question })` call)
 * is the `"textarea"` mode; everything else is a Codex-parity surface.
 */

/**
 * Shape we accept — a structural subset of `ToolBubble["askPending"]`
 * and `PendingAskAnnotation`. Decoupled from those source types so the
 * helper can be reused by tests that don't want to pull in the full
 * SPA bubble type just to assert mode classification.
 */
export interface AskPendingShape {
  question: string;
  options?: string[];
  default?: string;
  timeoutSeconds?: number;
  allowCustom?: boolean;
  timeoutAt?: number;
}

/**
 * Discrete rendering modes the SPA needs to know about.
 *
 *   - `"textarea"`        — legacy: just a free-form text field.
 *   - `"buttons-only"`    — `options[]` present AND `allowCustom === false`.
 *                           The textarea is hidden; only the option
 *                           buttons can submit a reply.
 *   - `"buttons+text"`    — `options[]` present AND custom replies are
 *                           still allowed (default behavior, or
 *                           `allowCustom === true`). Buttons render
 *                           above the textarea; either can submit.
 */
export type AskPendingMode = "textarea" | "buttons-only" | "buttons+text";

/**
 * Resolve the rendering mode for a given pending ask.
 *
 * Rules:
 *   1. If `options` is missing or empty, the mode is always `"textarea"`
 *      regardless of `allowCustom` (an `allowCustom: false` without
 *      options would lock the user out of the conversation — we treat
 *      it as a no-op).
 *   2. If `options` is non-empty and `allowCustom === false`, the mode
 *      is `"buttons-only"`.
 *   3. Otherwise (options non-empty AND `allowCustom !== false`) the
 *      mode is `"buttons+text"` — the default when the model omits
 *      `allowCustom` alongside an `options` array.
 */
export function resolveAskPendingMode(p: AskPendingShape): AskPendingMode {
  const hasOptions = Array.isArray(p.options) && p.options.length > 0;
  if (!hasOptions) return "textarea";
  if (p.allowCustom === false) return "buttons-only";
  return "buttons+text";
}

/**
 * True when the widget should render a live "auto-reply in Xs"
 * countdown. Only meaningful when the model supplied `timeoutSeconds`.
 *
 * `timeoutAt` is the canonical deadline (set by the server when it
 * scheduled the auto-resolve timer); it's preferred over deriving the
 * deadline from `Date.now() + timeoutSeconds*1000` so a tab reloaded
 * mid-countdown shows the right remaining time.
 */
export function hasCountdown(p: AskPendingShape): boolean {
  return typeof p.timeoutSeconds === "number" && p.timeoutSeconds >= 1;
}

/**
 * Compute the seconds remaining until the auto-resolve timer fires.
 *
 * Returns `null` when there is no countdown (no `timeoutAt`). Clamps to
 * 0 — a negative remaining time means the timer is overdue (the server
 * may not have fired the resolver yet; the SPA should still show 0 so
 * the user doesn't see "Auto-reply in -3s").
 */
export function secondsRemaining(p: AskPendingShape, now: number): number | null {
  if (typeof p.timeoutAt !== "number") return null;
  return Math.max(0, Math.ceil((p.timeoutAt - now) / 1000));
}

/**
 * True when the widget should show the "Press Enter to use default: …"
 * hint underneath the textarea. Only meaningful when:
 *   - a `default` string is supplied, AND
 *   - the textarea is visible (i.e. mode is `"textarea"` or
 *     `"buttons+text"`).
 *
 * Returns false for `"buttons-only"` mode even when `default` is set —
 * the buttons themselves are the only submission surface there, so a
 * default hint would confuse the user.
 */
export function showsDefaultHint(p: AskPendingShape): boolean {
  if (p.default === undefined) return false;
  return resolveAskPendingMode(p) !== "buttons-only";
}
