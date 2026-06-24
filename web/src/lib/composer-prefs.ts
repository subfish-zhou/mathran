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

export type CommandStyle = "selector" | "slash";

export const DEFAULT_COMMAND_STYLE: CommandStyle = "selector";

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
