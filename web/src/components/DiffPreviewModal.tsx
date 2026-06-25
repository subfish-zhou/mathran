// UX gap A — Diff preview before file write.
//
// Rendered by ChatPanel when a `propose-write` SSE event arrives. Shows the
// unified diff for an authorised write_file / edit_file call and lets the user:
//   - Accept  — run the write as proposed,
//   - Edit    — tweak the full new content in a textarea, then accept that,
//   - Decline — skip the write (the model is told it was rejected).
// The chosen decision is handed back to the host, which POSTs it via
// {@link postWriteProposalDecision} and closes the modal.

import { useState } from "react";
import type {
  WriteProposal,
  WriteProposalDecision,
} from "../lib/write-proposal-client.ts";

export interface DiffPreviewModalProps {
  proposal: WriteProposal;
  /** Called with the user's decision; the host POSTs it and closes the modal. */
  onDecide: (decision: WriteProposalDecision) => void;
  /** Set while the decision POST is in flight (buttons disabled). */
  pending?: boolean;
  /** Non-fatal error from a failed POST, surfaced inline for a retry. */
  error?: string | null;
}

/** Classify a unified-diff line by its leading marker (pure; unit-tested). */
export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context";
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

const KIND_CLASS: Record<DiffLineKind, string> = {
  meta: "text-slate-500",
  hunk: "text-cyan-700 bg-cyan-50",
  add: "text-emerald-800 bg-emerald-50",
  del: "text-red-800 bg-red-50",
  context: "text-slate-700",
};

/** Colour a single unified-diff line by its leading marker. */
function lineClass(line: string): string {
  return KIND_CLASS[classifyDiffLine(line)];
}

const MODE_BADGE: Record<WriteProposal["mode"], string> = {
  create: "border-emerald-300 bg-emerald-50 text-emerald-800",
  modify: "border-amber-300 bg-amber-50 text-amber-800",
};

export function DiffPreviewModal({
  proposal,
  onDecide,
  pending = false,
  error = null,
}: DiffPreviewModalProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.newContent);

  function accept(): void {
    if (pending) return;
    if (editing && draft !== proposal.newContent) {
      onDecide({ outcome: "accept", editedContent: draft });
    } else {
      onDecide({ outcome: "accept" });
    }
  }

  function decline(): void {
    if (pending) return;
    onDecide({ outcome: "decline" });
  }

  const diffLines = proposal.diffText.split("\n");
  const badge = MODE_BADGE[proposal.mode];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Review file write"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
        <header className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            📝 Review write
            <span className="font-mono text-sm text-slate-600">
              {proposal.path}
            </span>
          </h2>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badge}`}
          >
            {proposal.mode}
          </span>
        </header>

        <p className="mb-3 text-xs text-slate-600">
          This write requires your review before it lands. Accept it as-is, edit
          the content first, or decline.
        </p>

        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={pending}
            spellCheck={false}
            className="mb-3 h-72 w-full resize-y overflow-auto rounded border border-slate-300 p-2 font-mono text-xs text-slate-800 focus:border-emerald-500 focus:outline-none"
          />
        ) : (
          <pre className="mb-3 max-h-72 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs leading-relaxed">
            {diffLines.map((line, i) => (
              <div key={i} className={lineClass(line)}>
                {line || " "}
              </div>
            ))}
          </pre>
        )}

        {error ? (
          <div className="mb-3 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800">
            {error}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => setEditing((v) => !v)}
            className="rounded border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {editing ? "Preview diff" : "Edit"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={decline}
            className="rounded border border-red-400 bg-red-100 px-3 py-1 text-sm text-red-900 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Decline
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={accept}
            className="rounded border border-emerald-500 bg-emerald-100 px-3 py-1 text-sm text-emerald-900 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {editing && draft !== proposal.newContent ? "Accept edited" : "Accept"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DiffPreviewModal;
