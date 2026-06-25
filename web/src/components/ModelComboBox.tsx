/**
 * <ModelComboBox> — searchable combobox for the LLM model picker.
 *
 * Replaces the native `<input list=…>` + `<datalist>` pattern. The native
 * pattern has two failure modes on Chrome / Safari we hit in practice:
 *
 *   1. Once the input has a value (e.g. "copilot/gpt-5.5"), Chrome's
 *      datalist popup filters by **startsWith on the current value**,
 *      not by substring. So the popup ends up showing exactly one
 *      option — the input value itself — even though the underlying
 *      list has 30+ models. Users see "only gpt-5.5 is available".
 *
 *   2. There's no way to override that filter behaviour from JS, and
 *      no way to force the popup to show the whole list while keeping
 *      the input populated.
 *
 * This component fixes both:
 *   - The ▼ button (or focusing the input) opens a popup that ALWAYS
 *     shows the full list, regardless of the current input value.
 *   - Typing filters by substring (case-insensitive), so "opus"
 *     surfaces all four claude-opus variants even when the input
 *     starts with "copilot/".
 *   - The input remains free-form (the LLM router accepts any
 *     provider/model string, e.g. arbitrary "ollama/llama-3"), so
 *     selecting from the list is a convenience, not a constraint.
 */

import { useEffect, useRef, useState } from "react";

export interface ModelComboBoxProps {
  value: string;
  onChange: (next: string) => void;
  /** Bare model names returned by `/api/copilot/models` (no provider prefix). */
  options: string[];
  /** Provider prefix to prepend when the user clicks an option. */
  prefix?: string;
  placeholder?: string;
  /** Optional id for accessibility / form association. */
  id?: string;
  /** Optional className applied to the wrapping container. */
  className?: string;
  /** Disabled state, e.g. while a send is in flight. */
  disabled?: boolean;
}

export default function ModelComboBox({
  value,
  onChange,
  options,
  prefix = "copilot/",
  placeholder = "model (e.g. copilot/gpt-5.5)",
  id,
  className = "",
  disabled = false,
}: ModelComboBoxProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside-click. We listen at the document level (not on the
  // container) because the popup overflows it visually.
  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      const root = containerRef.current;
      if (root && !root.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Substring filter on the bare option name (not the prefixed version),
  // case-insensitive. When the input is empty, show the whole list.
  // When the input starts with the prefix, strip it before matching so
  // typing "claude" surfaces every claude- option even if the input
  // currently reads "copilot/claude-".
  const stripped = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  const needle = stripped.trim().toLowerCase();
  const filtered = needle
    ? options.filter((m) => m.toLowerCase().includes(needle))
    : options;

  const pick = (bare: string) => {
    onChange(`${prefix}${bare}`);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="flex items-center">
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full rounded-l-md border border-r-0 border-slate-300 px-2 py-1 text-xs font-mono outline-none focus:border-slate-500 disabled:bg-slate-100"
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled || options.length === 0}
          aria-label="Show model list"
          className="shrink-0 rounded-r-md border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ▼
        </button>
      </div>
      {open && filtered.length > 0 && (
        <ul
          role="listbox"
          className="absolute right-0 z-50 mt-1 max-h-64 w-full min-w-[16rem] overflow-y-auto rounded-md border border-slate-300 bg-white py-1 text-xs shadow-lg"
        >
          {filtered.map((bare) => {
            const full = `${prefix}${bare}`;
            const active = full === value;
            return (
              <li key={bare}>
                <button
                  type="button"
                  onClick={() => pick(bare)}
                  className={`block w-full cursor-pointer px-3 py-1 text-left font-mono hover:bg-slate-100 ${
                    active ? "bg-slate-50 font-semibold text-slate-900" : "text-slate-700"
                  }`}
                >
                  {full}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && filtered.length === 0 && (
        <div className="absolute right-0 z-50 mt-1 w-full min-w-[16rem] rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-500 shadow-lg">
          No models match "{stripped || value}"
        </div>
      )}
    </div>
  );
}
