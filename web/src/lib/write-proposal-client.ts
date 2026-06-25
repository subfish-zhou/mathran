// UX gap A — Diff preview before file write: SPA-side client.
//
// The chat SSE stream emits a `propose-write` event (payload: a
// {@link WriteProposal}) when an authorised write_file / edit_file call's
// matching rule set `requireDiffPreview`. The session parks server-side awaiting
// a decision. The SPA renders a {@link DiffPreviewModal} and `POST`s the user's
// {@link WriteProposalDecision} via {@link postWriteProposalDecision}, which
// resolves the parked promise and lets the stream resume (a
// `propose-write-resolved` event follows, then the write runs or is skipped).
//
// Types mirror `src/core/approval/diff-preview.ts`; kept local so the SPA bundle
// has no dependency on the server tree.

import { chatScopeBase, type ChatScopeSpec } from "./api.ts";

export type DiffMode = "create" | "modify";

export interface WriteProposal {
  toolCallId: string;
  path: string;
  oldContent: string;
  newContent: string;
  diffText: string;
  mode: DiffMode;
}

export interface WriteProposalDecision {
  outcome: "accept" | "decline";
  /** Full user-edited new content (accept only). Replaces the model's. */
  editedContent?: string;
}

/**
 * POST a decision for a pending write proposal. Resolves once the server accepts
 * it (the resumed stream is driven by the caller's existing SSE pump, not here).
 * Throws on a non-2xx response so the modal can surface the failure.
 */
export async function postWriteProposalDecision(
  scope: ChatScopeSpec,
  conversationId: string,
  toolCallId: string,
  decision: WriteProposalDecision,
): Promise<void> {
  const url = `${chatScopeBase(scope)}/${encodeURIComponent(
    conversationId,
  )}/write-proposal/${encodeURIComponent(toolCallId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(decision),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error ? `: ${body.error}` : "";
    } catch {
      /* ignore */
    }
    throw new Error(`write-proposal decision failed (${res.status})${detail}`);
  }
}

/**
 * Fetch the write proposals still awaiting a decision for a conversation. Used
 * to recover an in-flight prompt after a page reload.
 */
export async function fetchPendingWriteProposals(
  scope: ChatScopeSpec,
  conversationId: string,
): Promise<WriteProposal[]> {
  const url = `${chatScopeBase(scope)}/${encodeURIComponent(
    conversationId,
  )}/write-proposal`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const body = (await res.json()) as { pending?: WriteProposal[] };
  return body.pending ?? [];
}
