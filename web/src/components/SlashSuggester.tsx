/**
 * SlashSuggester — the Discord/Slack-style popup that floats above the chat
 * composer when the user types `/`. Presentational only: the parent
 * (`ChatPanel`) owns open-state, filtering, and keyboard navigation, and
 * passes the already-filtered `items` plus the highlighted index.
 *
 * Builtin commands render first; custom commands render after a `Custom`
 * divider (PLAN UI spec).
 */

import { useEffect, useRef } from "react";
import type { SuggesterItem } from "../lib/slash-commands.ts";

export interface SuggesterSections {
  builtin: SuggesterItem[];
  custom: SuggesterItem[];
}

/**
 * Split a flat (already-filtered) item list into the builtin/custom sections
 * the popup renders. Pure — unit-tested without a DOM.
 */
export function splitSuggesterSections(items: SuggesterItem[]): SuggesterSections {
  return {
    builtin: items.filter((i) => i.source === "builtin"),
    custom: items.filter((i) => i.source === "custom"),
  };
}

interface SlashSuggesterProps {
  items: SuggesterItem[];
  selectedIndex: number;
  onSelect: (item: SuggesterItem) => void;
  onHover: (index: number) => void;
}

export default function SlashSuggester({
  items,
  selectedIndex,
  onSelect,
  onHover,
}: SlashSuggesterProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the highlighted row scrolled into view as ↑/↓ moves through a long
  // list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  const { builtin, custom } = splitSuggesterSections(items);

  // Render a row; `globalIdx` is the index within the flat `items` array so
  // highlight + click map back to the parent's selection model.
  const renderRow = (item: SuggesterItem, globalIdx: number) => {
    const active = globalIdx === selectedIndex;
    return (
      <li
        key={`${item.source}:${item.name}`}
        data-idx={globalIdx}
        role="option"
        aria-selected={active}
        onMouseDown={(e) => {
          // mousedown (not click) so the textarea doesn't blur first.
          e.preventDefault();
          onSelect(item);
        }}
        onMouseEnter={() => onHover(globalIdx)}
        className={`flex cursor-pointer flex-col px-3 py-1.5 text-sm ${
          active ? "bg-slate-200" : "hover:bg-slate-100"
        }`}
      >
        <span className="font-mono text-slate-800">/{item.name}</span>
        <span className="truncate text-xs text-slate-500">{item.description}</span>
      </li>
    );
  };

  return (
    <div
      className="absolute bottom-full left-0 z-20 mb-1 w-full max-w-md overflow-hidden rounded-md border border-slate-300 bg-white shadow-lg"
      role="listbox"
      aria-label="Slash commands"
    >
      <ul ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {builtin.map((item) => renderRow(item, items.indexOf(item)))}
        {custom.length > 0 && (
          <li
            aria-hidden="true"
            className="border-t border-slate-200 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400"
          >
            Custom
          </li>
        )}
        {custom.map((item) => renderRow(item, items.indexOf(item)))}
      </ul>
    </div>
  );
}
