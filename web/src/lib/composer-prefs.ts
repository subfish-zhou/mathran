/**
 * Composer preferences — TODO-3 UI #2 (style toggle).
 *
 * Client-side preference for how the chat composer surfaces slash
 * commands. Persisted in localStorage so it survives a refresh; no
 * backend changes needed.
 *
 *   "selector"  (default): typing `/` opens a Discord/copilot-CLI style
 *                          popup with all matching commands. Arrow
 *                          keys + Enter to choose; Tab to autocomplete.
 *                          This is the existing mathran UX.
 *
 *   "slash"               : popup is suppressed. The user types the
 *                          full `/cmd args` and presses Enter; the
 *                          composer treats it as plain text until
 *                          submitted. This is the openclaw / claude-code
 *                          CLI style — non-intrusive while typing.
 *
 * Settings → "Composer" lets the user flip between them.
 */

const KEY = "mathran.composer.commandStyle";
const REASONING_KEY = "mathran.composer.reasoningDisplay";

export type CommandStyle = "selector" | "slash";

export const DEFAULT_COMMAND_STYLE: CommandStyle = "selector";

/**
 * reasoningDisplay — how the SPA renders the chain-of-thought / thinking
 * panel that streams alongside each assistant turn.
 *
 * Reasoning models (claude-opus `thinking`, gpt-5.x / o-series
 * `reasoning_content`) emit one reasoning chunk before every tool call,
 * which historically rendered as a 💭 chip per call — for a long
 * iteration with 30 tool calls that's 30 chips, badly cluttering the
 * conversation. Default `"hidden"` strips reasoning from the UI entirely
 * while still persisting it to the conversation jsonl so it can be
 * recovered later by flipping the toggle. `"collapsed"` shows the
 * existing 💭 chip (click to expand). `"inline"` is reserved for a future
 * full-text inline mode.
 */
export type ReasoningDisplay = "hidden" | "collapsed" | "inline";

export const DEFAULT_REASONING_DISPLAY: ReasoningDisplay = "hidden";

export function loadCommandStyle(): CommandStyle {
  if (typeof window === "undefined") return DEFAULT_COMMAND_STYLE;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === "slash" || raw === "selector") return raw;
  } catch {
    // ignore corrupted / unavailable localStorage
  }
  return DEFAULT_COMMAND_STYLE;
}

export function saveCommandStyle(style: CommandStyle): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, style);
    // Broadcast so other open tabs / mounted components react without
    // a page refresh.
    window.dispatchEvent(new CustomEvent("mathran:commandStyle", { detail: style }));
  } catch {
    // ignore
  }
}

export function subscribeCommandStyle(cb: (style: CommandStyle) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (ev: Event) => {
    const ce = ev as CustomEvent<CommandStyle>;
    if (ce.detail === "slash" || ce.detail === "selector") cb(ce.detail);
  };
  // Cross-tab sync via 'storage' too.
  const storage = (ev: StorageEvent) => {
    if (ev.key === KEY && (ev.newValue === "slash" || ev.newValue === "selector")) {
      cb(ev.newValue);
    }
  };
  window.addEventListener("mathran:commandStyle", handler);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener("mathran:commandStyle", handler);
    window.removeEventListener("storage", storage);
  };
}

// ───── reasoningDisplay (UX gap B follow-up — clutter cleanup 2026-06-25) ─────

const REASONING_VALUES: ReadonlySet<string> = new Set(["hidden", "collapsed", "inline"]);

function isReasoningDisplay(v: unknown): v is ReasoningDisplay {
  return typeof v === "string" && REASONING_VALUES.has(v);
}

export function loadReasoningDisplay(): ReasoningDisplay {
  if (typeof window === "undefined") return DEFAULT_REASONING_DISPLAY;
  try {
    const raw = window.localStorage.getItem(REASONING_KEY);
    if (isReasoningDisplay(raw)) return raw;
  } catch {
    // ignore
  }
  return DEFAULT_REASONING_DISPLAY;
}

export function saveReasoningDisplay(value: ReasoningDisplay): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REASONING_KEY, value);
    window.dispatchEvent(
      new CustomEvent("mathran:reasoningDisplay", { detail: value }),
    );
  } catch {
    // ignore
  }
}

export function subscribeReasoningDisplay(
  cb: (value: ReasoningDisplay) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (ev: Event) => {
    const ce = ev as CustomEvent<ReasoningDisplay>;
    if (isReasoningDisplay(ce.detail)) cb(ce.detail);
  };
  const storage = (ev: StorageEvent) => {
    if (ev.key === REASONING_KEY && isReasoningDisplay(ev.newValue)) {
      cb(ev.newValue);
    }
  };
  window.addEventListener("mathran:reasoningDisplay", handler);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener("mathran:reasoningDisplay", handler);
    window.removeEventListener("storage", storage);
  };
}
