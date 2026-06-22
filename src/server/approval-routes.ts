// Approval Policy 矩阵 — serve-mode HTTP plumbing.
//
// In serve mode the approval prompt is driven by the ChatSession itself
// (yield-based): the session yields an `approval_request` ChatEvent (which the
// SSE pump forwards to the SPA), then awaits a session-level resolver. That
// resolver — {@link ApprovalRegistry.register} — parks a Promise keyed by
// `(conversationId, requestId)` and keeps the SSE stream open. When the user
// clicks a button in the SPA's `ApprovalDialog`, the SPA `POST`s the decision
// to `…/:conversationId/approval/:id`, which resolves the parked Promise; the
// session resumes and executes (or skips) the tool in-place — no re-run, no
// throw/resume placeholder dance.
//
// If a stream dies before the user decides (browser closed, network drop), the
// host calls {@link ApprovalRegistry.rejectPending} so the parked Promise
// settles as a fail-safe `deny` rather than hanging forever.

import type { Hono } from "hono";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../core/approval/types.js";

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

/** The valid `outcome` values a client may POST. */
const VALID_OUTCOMES = new Set([
  "allow_once",
  "allow_session",
  "allow_prefix",
  "deny",
  "retry",
  "abandon",
]);

/**
 * Per-server registry of in-flight approval prompts. One instance is shared by
 * the session factory (which registers prompts) and the HTTP route (which
 * resolves them).
 */
export class ApprovalRegistry {
  private byConversation = new Map<string, Map<string, PendingEntry>>();

  /**
   * Park a prompt and return a Promise that settles when the matching
   * `POST …/approval/:id` arrives (or the conversation's pending prompts are
   * rejected). Used as the ChatSession `approvalResolver` in serve mode.
   */
  register(
    conversationId: string,
    request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
    let bucket = this.byConversation.get(conversationId);
    if (!bucket) {
      bucket = new Map();
      this.byConversation.set(conversationId, bucket);
    }
    return new Promise<ApprovalDecision>((resolve) => {
      bucket!.set(request.id, { request, resolve });
    });
  }

  /**
   * Resolve a parked prompt. Returns `false` if no prompt with that id is
   * pending for the conversation (already resolved / unknown id / stale).
   */
  resolve(
    conversationId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): boolean {
    const bucket = this.byConversation.get(conversationId);
    const entry = bucket?.get(requestId);
    if (!bucket || !entry) return false;
    bucket.delete(requestId);
    if (bucket.size === 0) this.byConversation.delete(conversationId);
    entry.resolve(decision);
    return true;
  }

  /** The requests currently awaiting a decision for a conversation. */
  pending(conversationId: string): ApprovalRequest[] {
    const bucket = this.byConversation.get(conversationId);
    if (!bucket) return [];
    return [...bucket.values()].map((e) => e.request);
  }

  /**
   * Settle every parked prompt for a conversation as a fail-safe `deny`. Called
   * when a stream ends without the user deciding so the session never hangs.
   */
  rejectPending(conversationId: string, reason = "stream closed"): void {
    const bucket = this.byConversation.get(conversationId);
    if (!bucket) return;
    for (const entry of bucket.values()) {
      entry.resolve({ outcome: "deny", reason });
    }
    this.byConversation.delete(conversationId);
  }
}

/** Process-wide shared registry used by `mathran serve`. */
export const sharedApprovalRegistry = new ApprovalRegistry();

/**
 * Validate + normalise a POST body into an {@link ApprovalDecision}. Returns
 * `null` when the outcome is missing/invalid.
 */
export function parseApprovalDecision(body: unknown): ApprovalDecision | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const outcome = b.outcome;
  if (typeof outcome !== "string" || !VALID_OUTCOMES.has(outcome)) return null;
  const decision: ApprovalDecision = { outcome: outcome as ApprovalDecision["outcome"] };
  if (typeof b.prefix === "string") decision.prefix = b.prefix;
  if (typeof b.reason === "string") decision.reason = b.reason;
  return decision;
}

/**
 * Register `POST <basePath>/:conversationId/approval/:id` against `app`. The
 * handler resolves the matching parked prompt in `registry`. 404 when no such
 * prompt is pending; 400 on a malformed decision body.
 */
export function registerApprovalRoute(
  app: Hono,
  basePath: string,
  registry: ApprovalRegistry,
): void {
  app.post(`${basePath}/:conversationId/approval/:id`, async (c) => {
    const conversationId = c.req.param("conversationId");
    const requestId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const decision = parseApprovalDecision(body);
    if (!decision) {
      return c.json({ error: "invalid or missing approval outcome" }, 400);
    }
    const ok = registry.resolve(conversationId, requestId, decision);
    if (!ok) {
      return c.json({ error: "no pending approval with that id" }, 404);
    }
    return c.json({ ok: true, id: requestId, decision });
  });

  // GET <basePath>/:conversationId/approval  — list pending prompts (recovery
  // after a page reload while a prompt is in-flight).
  app.get(`${basePath}/:conversationId/approval`, async (c) => {
    const conversationId = c.req.param("conversationId");
    return c.json({ pending: registry.pending(conversationId) });
  });
}
