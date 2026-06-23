/**
 * ReferenceLinksInput — chip-list editor for seed references.
 *
 * Replaces the free-form seed-references textarea: the user types an arXiv id,
 * DOI, or URL, hits Add (or Enter), and each accepted reference shows as a chip
 * with a parsed-type badge and a remove (×) button. No metadata auto-fetch —
 * classification is purely local (`classifyReference`).
 */
import { useRef, useState } from "react";

import { classifyReference, isValidReference, type ReferenceType } from "./reference-helpers.ts";

export interface ReferenceLinksInputProps {
  links: string[];
  onAdd: (link: string) => void;
  onRemove: (index: number) => void;
}

const TYPE_BADGE: Record<ReferenceType, string> = {
  arxiv: "bg-red-50 text-red-600 border-red-200",
  doi: "bg-blue-50 text-blue-600 border-blue-200",
  url: "bg-green-50 text-green-600 border-green-200",
  unknown: "bg-slate-100 text-slate-500 border-slate-200",
};

export default function ReferenceLinksInput({ links, onAdd, onRemove }: ReferenceLinksInputProps) {
  const [input, setInput] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleAdd() {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (!isValidReference(trimmed)) {
      setWarning(`Unrecognized reference: ${trimmed}`);
      return;
    }
    if (links.includes(trimmed)) {
      setWarning("Reference already added");
      return;
    }
    onAdd(trimmed);
    setInput("");
    setWarning(null);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-slate-700">Seed references</span>
      <span className="text-xs text-slate-400">
        arXiv id (e.g. 2301.10828), DOI (e.g. 10.1xxx/…), or http(s) URL.
      </span>

      {links.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {links.map((link, index) => {
            const { type } = classifyReference(link);
            return (
              <li
                key={`${link}-${index}`}
                className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5"
              >
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${TYPE_BADGE[type]}`}
                >
                  {type}
                </span>
                <span className="flex-1 truncate font-mono text-xs text-slate-600">{link}</span>
                <button
                  type="button"
                  aria-label={`Remove ${link}`}
                  onClick={() => onRemove(index)}
                  className="shrink-0 rounded px-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (warning) setWarning(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder="arXiv ID, DOI, or URL"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-slate-500"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={!input.trim()}
          className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {warning && <span className="text-xs text-amber-600">{warning}</span>}
    </div>
  );
}
