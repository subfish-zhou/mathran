/**
 * Serve-mode escape signal for the approval flow (Approval Policy 矩阵).
 *
 * The serve host cannot block a chat round on a synchronous prompt the way the
 * CLI readline resolver does. Instead its {@link ApprovalResolver} throws an
 * {@link ApprovalPending} to bail out of the LLM loop — mirroring the
 * `AskUserPending` pattern. {@link ChatSession} detects it, keeps the message
 * history well-formed, emits an `approval_request` event so the SPA can render
 * the modal, and ends the SSE stream. A `POST …/approval/:id` resolves the
 * decision and a re-run continues the round.
 */

import type { ApprovalRequest } from "./types.js";

export class ApprovalPending extends Error {
  public readonly request: ApprovalRequest;
  public readonly callId: string;
  constructor(input: { request: ApprovalRequest; callId: string }) {
    super(`approval pending: ${input.request.tool}`);
    this.name = "ApprovalPending";
    this.request = input.request;
    this.callId = input.callId;
  }
}

/** Cross-bundle-safe type guard for {@link ApprovalPending}. */
export function isApprovalPending(err: unknown): err is ApprovalPending {
  if (err instanceof ApprovalPending) return true;
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ApprovalPending"
  );
}

/**
 * Placeholder content stamped into the `tool` message slot for a tool call
 * paused on approval, so message history stays well-formed (every assistant
 * tool_call must be paired with a tool message). The resume endpoint patches
 * it once the decision is known.
 */
export const APPROVAL_PENDING_PLACEHOLDER =
  "[pending: awaiting approval decision]";
