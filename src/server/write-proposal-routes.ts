// UX gap A — Diff preview before file write: serve-mode HTTP plumbing.
//
// Mirrors approval-routes.ts. In serve mode the ChatSession yields a
// `propose-write` ChatEvent (the SSE pump forwards it to the SPA), then awaits
// a session-level resolver — {@link WriteProposalRegistry.register} — which
// parks a Promise keyed by `(conversationId, toolCallId)` and keeps the SSE
// stream open. When the user clicks Accept / Decline (or Accept after editing)
// in the SPA's `DiffPreviewModal`, the SPA `POST`s the decision to
// `…/:conversationId/write-proposal/:id`, which resolves the parked Promise;
// the session resumes and runs (or skips) the write in-place.
//
// If the stream dies before the user decides, the host calls
// {@link WriteProposalRegistry.rejectPending} so the parked Promise settles as
// a fail-safe `decline` rather than hanging forever.

import type { Hono } from "hono";
import type { WriteProposal, WriteProposalDecision } from "../core/approval/diff-preview.js";

interface PendingEntry {
  proposal: WriteProposal;
  resolve: (decision: WriteProposalDecision) => void;
}

/**
 * Per-server registry of in-flight write proposals. One instance is shared by
 * the session factory (which registers proposals) and the HTTP route (which
 * resolves them).
 */
export class WriteProposalRegistry {
  private byConversation = new Map<string, Map<string, PendingEntry>>();

  /**
   * Park a proposal and return a Promise that settles when the matching
   * `POST …/write-proposal/:id` arrives (or the conversation's pending
   * proposals are rejected). Used as the ChatSession `writeProposalResolver`.
   */
  register(
    conversationId: string,
    proposal: WriteProposal,
  ): Promise<WriteProposalDecision> {
    let bucket = this.byConversation.get(conversationId);
    if (!bucket) {
      bucket = new Map();
      this.byConversation.set(conversationId, bucket);
    }
    return new Promise<WriteProposalDecision>((resolve) => {
      bucket!.set(proposal.toolCallId, { proposal, resolve });
    });
  }

  /**
   * Resolve a parked proposal. Returns `false` if no proposal with that id is
   * pending for the conversation (already resolved / unknown id / stale).
   */
  resolve(
    conversationId: string,
    toolCallId: string,
    decision: WriteProposalDecision,
  ): boolean {
    const bucket = this.byConversation.get(conversationId);
    const entry = bucket?.get(toolCallId);
    if (!bucket || !entry) return false;
    bucket.delete(toolCallId);
    if (bucket.size === 0) this.byConversation.delete(conversationId);
    entry.resolve(decision);
    return true;
  }

  /** The proposals currently awaiting a decision for a conversation. */
  pending(conversationId: string): WriteProposal[] {
    const bucket = this.byConversation.get(conversationId);
    if (!bucket) return [];
    return [...bucket.values()].map((e) => e.proposal);
  }

  /**
   * Settle every parked proposal for a conversation as a fail-safe `decline`.
   * Called when a stream ends without the user deciding so the session never
   * hangs.
   */
  rejectPending(conversationId: string): void {
    const bucket = this.byConversation.get(conversationId);
    if (!bucket) return;
    for (const entry of bucket.values()) {
      entry.resolve({ outcome: "decline" });
    }
    this.byConversation.delete(conversationId);
  }
}

/** Process-wide shared registry used by `mathran serve`. */
export const sharedWriteProposalRegistry = new WriteProposalRegistry();

/**
 * Validate + normalise a POST body into a {@link WriteProposalDecision}.
 * Returns `null` when the outcome is missing/invalid.
 */
export function parseWriteProposalDecision(
  body: unknown,
): WriteProposalDecision | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const outcome = b.outcome;
  if (outcome !== "accept" && outcome !== "decline") return null;
  const decision: WriteProposalDecision = { outcome };
  if (outcome === "accept" && typeof b.editedContent === "string") {
    decision.editedContent = b.editedContent;
  }
  return decision;
}

/**
 * Register `POST <basePath>/:conversationId/write-proposal/:id` (resolve a
 * parked proposal) and `GET <basePath>/:conversationId/write-proposal` (list
 * pending, for reload recovery) against `app`.
 */
export function registerWriteProposalRoute(
  app: Hono,
  basePath: string,
  registry: WriteProposalRegistry,
): void {
  app.post(`${basePath}/:conversationId/write-proposal/:id`, async (c) => {
    const conversationId = c.req.param("conversationId");
    const toolCallId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const decision = parseWriteProposalDecision(body);
    if (!decision) {
      return c.json({ error: "invalid or missing write-proposal outcome" }, 400);
    }
    const ok = registry.resolve(conversationId, toolCallId, decision);
    if (!ok) {
      return c.json({ error: "no pending write proposal with that id" }, 404);
    }
    return c.json({ ok: true, id: toolCallId, decision });
  });

  app.get(`${basePath}/:conversationId/write-proposal`, async (c) => {
    const conversationId = c.req.param("conversationId");
    return c.json({ pending: registry.pending(conversationId) });
  });
}
