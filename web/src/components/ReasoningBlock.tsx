/**
 * <ReasoningBlock> — collapsed chain-of-thought panel (UX gap B).
 *
 * Reasoning models (Anthropic claude-opus `thinking`, OpenAI / Copilot
 * `reasoning_content`) stream their internal deliberation on a side channel
 * separate from the user-visible answer. Codex and Claude Code both surface
 * this as a collapsed panel the user can expand; Mathran used to throw the
 * chunks away, so long iterations looked like "60s of silence → 27 tool
 * calls". This component renders the accumulated reasoning text as a
 * collapsed-by-default disclosure:
 *
 *   ▸ 💭 1234 reasoning chars (click to expand)
 *
 * Expanding reveals the raw chain-of-thought in a muted monospace block.
 * Purely presentational — the parent owns accumulation + persistence.
 */

import { useState } from "react";

/**
 * Build the collapsed-panel summary label. Pure + exported so it can be unit
 * tested without a DOM renderer (the SPA has no jsdom test infra). Mirrors the
 * "💭 N reasoning chars (click to expand)" affordance Codex / Claude Code use.
 */
export function reasoningSummary(charCount: number, streaming: boolean): string {
  if (streaming) return `💭 thinking… ${charCount} chars`;
  return `💭 ${charCount} reasoning ${charCount === 1 ? "char" : "chars"} (click to expand)`;
}

interface ReasoningBlockProps {
  /** Accumulated reasoning / chain-of-thought text. */
  reasoning: string;
  /** True while the owning assistant turn is still streaming. */
  streaming?: boolean;
}

export function ReasoningBlock({ reasoning, streaming = false }: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(false);
  if (!reasoning) return null;

  const summary = reasoningSummary(reasoning.length, streaming);

  return (
    <div className="mb-1.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 transition hover:bg-violet-100"
      >
        <span
          aria-hidden="true"
          className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        <span>{summary}</span>
      </button>
      {expanded ? (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-violet-100 bg-violet-50/40 px-3 py-2 text-xs leading-relaxed text-slate-600">
          {reasoning}
        </pre>
      ) : null}
    </div>
  );
}
