/**
 * PaperCard — inline card rendered in place of an arXiv/DOI link in
 * chat. Shows title + authors + year + abstract preview, plus four
 * reaction buttons (👍 / 👎 / ⭐ / 📝) that write to the user's
 * profile via /api/papers/:id/reactions.
 *
 * Design choices:
 *   - Cards render lazily (one fetch per unique paperId, shared via
 *     a module-level cache in lib/papers.ts) — a single bubble
 *     mentioning 5 different papers triggers 5 requests in parallel,
 *     not 5N when N copies of the same paper appear.
 *   - The "save" reaction is independent of like/dislike (you can
 *     save a paper you also like, or save without an opinion).
 *   - The "note" reaction is append-only — each click opens a tiny
 *     textarea, save creates a new note row, multiple notes on the
 *     same paper render as a stacked list under the card.
 *   - On `paperId` we use the local PaperNode id (the canonical
 *     workspace-graph id) so reactions are stable even if the user
 *     renames a paper or re-ingests it.
 *
 * 2026-06-26 (user-distillation Phase 2).
 */

import { useState } from "react";

import type { PaperRefScheme } from "../lib/paper-detector.ts";
import {
  useReactions,
  usePaperByRef,
  type PaperNode,
} from "../lib/papers.ts";

export interface PaperCardProps {
  scheme: PaperRefScheme;
  /** External id (arxiv or doi) — NOT the local node id. */
  id: string;
  /** Where in the chat we are — stored on the reaction for traceability. */
  conversationId?: string;
  bubbleIdx?: number;
  /** The raw matched text (`arXiv:2401.12345`, etc.) — fallback link label. */
  rawLabel?: string;
}

export function PaperCard(props: PaperCardProps): JSX.Element {
  const fetch = usePaperByRef(props.scheme, props.id);

  if (fetch.status === "loading") {
    return (
      <span className="my-2 inline-block rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        loading {props.rawLabel ?? `${props.scheme}:${props.id}`}…
      </span>
    );
  }
  if (fetch.status === "error") {
    // Soft fallback — render as a plain link so the user can still
    // click through to arxiv. Show the error in a tooltip.
    const href =
      props.scheme === "arxiv"
        ? `https://arxiv.org/abs/${props.id}`
        : `https://doi.org/${props.id}`;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`could not load paper metadata: ${fetch.error}`}
        className="text-amber-700 underline decoration-dotted"
      >
        {props.rawLabel ?? href}
      </a>
    );
  }

  return (
    <PaperCardBody
      paper={fetch.paper}
      conversationId={props.conversationId}
      bubbleIdx={props.bubbleIdx}
    />
  );
}

function PaperCardBody({
  paper,
  conversationId,
  bubbleIdx,
}: {
  paper: PaperNode;
  conversationId?: string;
  bubbleIdx?: number;
}): JSX.Element {
  const { state, toggleQuickReaction, addNote } = useReactions(paper.id);
  const [noting, setNoting] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [submittingReaction, setSubmittingReaction] = useState<string | null>(null);

  const has = (r: "like" | "dislike" | "save"): boolean =>
    state.reactions.some((x) => x.reaction === r);

  const notes = state.reactions.filter((r) => r.reaction === "note");

  const ctx = { conversationId, bubbleIdx };

  async function handleClick(r: "like" | "dislike" | "save"): Promise<void> {
    setSubmittingReaction(r);
    try {
      await toggleQuickReaction(r, ctx);
    } finally {
      setSubmittingReaction(null);
    }
  }

  async function handleSaveNote(): Promise<void> {
    const body = noteDraft.trim();
    if (!body) return;
    await addNote(body, ctx);
    setNoteDraft("");
    setNoting(false);
  }

  const authorsLine = paper.authors.length === 0
    ? null
    : paper.authors.length <= 3
    ? paper.authors.join(", ")
    : `${paper.authors.slice(0, 3).join(", ")}, …`;

  const externalUrl =
    paper.url ??
    (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : undefined) ??
    (paper.doi ? `https://doi.org/${paper.doi}` : undefined);

  return (
    <div className="my-2 rounded border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {externalUrl ? (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-slate-800 hover:underline"
            >
              {paper.title}
            </a>
          ) : (
            <span className="font-medium text-slate-800">{paper.title}</span>
          )}
          <p className="mt-0.5 text-xs text-slate-500">
            {authorsLine}
            {paper.year !== undefined && ` · ${paper.year}`}
            {paper.arxivId && ` · arXiv:${paper.arxivId}`}
            {paper.doi && !paper.arxivId && ` · doi:${paper.doi}`}
          </p>
          {paper.abstract && (
            <p className="mt-1 text-xs text-slate-600 line-clamp-3">
              {paper.abstract}
            </p>
          )}
        </div>
        <ReactionToolbar
          like={has("like")}
          dislike={has("dislike")}
          save={has("save")}
          submitting={submittingReaction}
          onLike={() => void handleClick("like")}
          onDislike={() => void handleClick("dislike")}
          onSave={() => void handleClick("save")}
          onNote={() => setNoting((v) => !v)}
          notingActive={noting}
        />
      </div>

      {noting && (
        <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2">
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            rows={2}
            placeholder="One-sentence note about this paper — what you found, your stance, an open question."
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
          />
          <div className="mt-1 flex justify-end gap-1">
            <button
              type="button"
              onClick={() => {
                setNoting(false);
                setNoteDraft("");
              }}
              className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveNote()}
              disabled={noteDraft.trim().length === 0}
              className="rounded bg-amber-600 px-2 py-0.5 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
            >
              Save note
            </button>
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2">
          {notes.map((n, i) => (
            <li
              key={`${n.timestamp}-${i}`}
              className="text-xs text-slate-600"
              title={n.timestamp}
            >
              📝 {n.body}
            </li>
          ))}
        </ul>
      )}

      {state.error && (
        <p className="mt-1 text-[10px] text-rose-600">{state.error}</p>
      )}
    </div>
  );
}

function ReactionToolbar({
  like,
  dislike,
  save,
  submitting,
  onLike,
  onDislike,
  onSave,
  onNote,
  notingActive,
}: {
  like: boolean;
  dislike: boolean;
  save: boolean;
  submitting: string | null;
  onLike: () => void;
  onDislike: () => void;
  onSave: () => void;
  onNote: () => void;
  notingActive: boolean;
}): JSX.Element {
  function btnClass(active: boolean, color: string): string {
    return (
      "rounded border px-1.5 py-0.5 text-sm hover:bg-slate-100 disabled:opacity-50 " +
      (active
        ? `border-${color}-400 bg-${color}-50`
        : "border-slate-300 bg-white")
    );
  }
  return (
    <div className="flex shrink-0 gap-1">
      <button
        type="button"
        onClick={onLike}
        disabled={submitting === "like"}
        className={btnClass(like, "emerald")}
        title="I like this paper"
      >
        👍
      </button>
      <button
        type="button"
        onClick={onDislike}
        disabled={submitting === "dislike"}
        className={btnClass(dislike, "rose")}
        title="Not useful / I disagree"
      >
        👎
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={submitting === "save"}
        className={btnClass(save, "amber")}
        title="Save / bookmark for later"
      >
        ⭐
      </button>
      <button
        type="button"
        onClick={onNote}
        className={btnClass(notingActive, "sky")}
        title="Attach a note"
      >
        📝
      </button>
    </div>
  );
}
