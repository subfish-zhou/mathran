// Approval Policy 矩阵 — SPA-side client for the serve-mode approval flow.
//
// The chat SSE stream emits an `approval_request` event (payload: an
// {@link ApprovalRequest}) when a tool call needs sign-off; the session then
// parks server-side awaiting a decision. The SPA renders an `ApprovalDialog`
// and `POST`s the user's {@link ApprovalDecision} back via
// {@link postApprovalDecision}, which resolves the parked promise and lets the
// stream resume (an `approval_resolved` event follows, then the tool runs).
//
// Types mirror `src/core/approval/types.ts`; kept local so the SPA bundle has
// no dependency on the server tree.

import { chatScopeBase, type ChatScopeSpec } from "./api.ts";

export type RiskClass = "read" | "write" | "exec" | "net";

export interface ApprovalRequest {
  id: string;
  tool: string;
  riskClass: RiskClass;
  trigger: "policy" | "untrusted" | "on-failure";
  preview: string;
  args: Record<string, unknown>;
  rationale?: string;
}

export type ApprovalOutcome =
  | "allow_once"
  | "allow_session"
  | "allow_prefix"
  | "deny"
  | "retry"
  | "abandon";

export interface ApprovalDecision {
  outcome: ApprovalOutcome;
  prefix?: string;
  reason?: string;
}

/** A button rendered in the {@link ApprovalDialog}, derived from a request. */
export interface ApprovalOption {
  outcome: ApprovalOutcome;
  label: string;
  /** Visual emphasis: `primary` = safe default, `danger` = deny/abandon. */
  tone: "primary" | "neutral" | "danger";
  /** Pre-filled prefix for `allow_prefix` (the command's first token). */
  prefix?: string;
}

/**
 * Derive the longest "obvious" prefix to offer for `allow_prefix`: the leading
 * run of the command up to (and including) the first whitespace-delimited
 * token, e.g. `"npm test src/"` → `"npm test"`. Falls back to the whole
 * command when it has a single token. Returns `undefined` for non-exec tools
 * (a path-glob rule is a follow-up; only command prefixes are offered today).
 */
export function suggestPrefix(req: ApprovalRequest): string | undefined {
  if (req.riskClass !== "exec") return undefined;
  const cmd = typeof req.args.command === "string" ? req.args.command.trim() : "";
  if (!cmd) return undefined;
  const tokens = cmd.split(/\s+/);
  if (tokens.length <= 1) return tokens[0];
  // Two tokens reads naturally as a prefix (e.g. `npm test`, `git status`);
  // anything longer we still cap at the first two so the rule stays broad.
  return tokens.slice(0, 2).join(" ");
}

/**
 * Build the ordered list of decision buttons for a request. `on-failure`
 * prompts (the tool already ran and failed) offer retry/abandon; every other
 * trigger offers the allow-* / deny set. `allow_prefix` only appears when a
 * sensible prefix can be derived.
 */
export function buildApprovalOptions(req: ApprovalRequest): ApprovalOption[] {
  if (req.trigger === "on-failure") {
    return [
      { outcome: "retry", label: "Retry", tone: "primary" },
      { outcome: "abandon", label: "Abandon", tone: "danger" },
    ];
  }
  const options: ApprovalOption[] = [
    { outcome: "allow_once", label: "Allow once", tone: "primary" },
    { outcome: "allow_session", label: "Allow for session", tone: "neutral" },
  ];
  const prefix = suggestPrefix(req);
  if (prefix) {
    options.push({
      outcome: "allow_prefix",
      label: `Always allow “${prefix}”`,
      tone: "neutral",
      prefix,
    });
  }
  options.push({ outcome: "deny", label: "Deny", tone: "danger" });
  return options;
}

/** Short human label for the risk badge. */
export function riskLabel(risk: RiskClass): string {
  switch (risk) {
    case "read":
      return "read";
    case "write":
      return "write";
    case "exec":
      return "execute";
    case "net":
      return "network";
  }
}

/**
 * POST a decision for a pending approval. Resolves once the server accepts it
 * (the resumed stream is driven by the caller's existing SSE pump, not here).
 * Throws on a non-2xx response so the dialog can surface the failure.
 */
export async function postApprovalDecision(
  scope: ChatScopeSpec,
  conversationId: string,
  requestId: string,
  decision: ApprovalDecision,
): Promise<void> {
  const url = `${chatScopeBase(scope)}/${encodeURIComponent(
    conversationId,
  )}/approval/${encodeURIComponent(requestId)}`;
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
    throw new Error(`approval decision failed (${res.status})${detail}`);
  }
}

/**
 * Fetch the approvals still awaiting a decision for a conversation. Used to
 * recover an in-flight prompt after a page reload (the server keeps the parked
 * promise alive until the stream's `finally` rejects it).
 */
export async function fetchPendingApprovals(
  scope: ChatScopeSpec,
  conversationId: string,
): Promise<ApprovalRequest[]> {
  const url = `${chatScopeBase(scope)}/${encodeURIComponent(
    conversationId,
  )}/approval`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const body = (await res.json()) as { pending?: ApprovalRequest[] };
  return body.pending ?? [];
}
