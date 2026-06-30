/**
 * Core types for the approval-policy subsystem (Approval Policy 矩阵).
 *
 * mathran historically ran every builtin tool silently (zero approval) —
 * `bash` could run anything, `write_file` / `edit_file` / `dispatch_subagent`
 * were ungated. This module introduces a Codex-style 4-level approval policy,
 * a per-tool {@link RiskClass} metadata field, and the request/decision data
 * the host (CLI readline / serve SSE) exchanges with the user when a tool call
 * needs sign-off.
 *
 * The types here are deliberately host-agnostic: the same {@link ApprovalRequest}
 * is rendered by the CLI readline prompt and the SPA `ApprovalDialog`, and the
 * same {@link ApprovalDecision} flows back through the broker regardless of UI.
 */

/**
 * Coarse risk bucket attached to every builtin tool. Drives the approval
 * matrix together with the active {@link ApprovalPolicy}.
 *
 *   - `read`  — sandbox-local reads (read_file, search, ask_user, …)
 *   - `write` — sandbox-local writes (write_file, edit_file, todo_write)
 *   - `exec`  — arbitrary execution (bash, lean_check, dispatch_subagent)
 *   - `net`   — network egress. RESERVED: mathran has no http_fetch builtin
 *               yet, but the enum value is wired so a follow-up PR can attach
 *               it without a breaking schema change.
 */
export type RiskClass = "read" | "write" | "exec" | "net";

/** All valid {@link RiskClass} values (runtime list for validation / tests). */
export const RISK_CLASSES: readonly RiskClass[] = [
  "read",
  "write",
  "exec",
  "net",
] as const;

/**
 * The four approval levels, from most-permissive to most-cautious in spirit
 * (though they are not a strict ordering — `on-failure` is orthogonal).
 *
 *   - `never`      — every tool runs silently (the legacy zero-approval
 *                    behaviour). Kept as an explicit escape hatch; it must be
 *                    chosen on purpose, it is never the fallback default.
 *   - `on-request` — DEFAULT. Every high-risk (write / exec / net) tool call
 *                    prompts for approval. (Codex `read-only` ≈ this.)
 *   - `untrusted`  — only prompts when the tool call touches untrusted content
 *                    (path outside the workspace, or a command carrying a
 *                    suspicious token). (Codex `auto-edit` ≈ this.)
 *   - `on-failure` — runs the tool first; only prompts ("retry or abandon")
 *                    after it fails. (mathran-specific, not in Codex.)
 */
export type ApprovalPolicy =
  | "never"
  | "on-request"
  | "untrusted"
  | "on-failure";

/** All valid {@link ApprovalPolicy} values. */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
  "never",
  "on-request",
  "untrusted",
  "on-failure",
] as const;

/** The DEFAULT policy applied when settings are missing or malformed. */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "on-request";

/**
 * A request surfaced to the user when a tool call needs sign-off. Built by the
 * broker, rendered by the host (CLI inline prompt / SPA modal).
 */
export interface ApprovalRequest {
  /** Stable id (uuid) — used to correlate the SSE event with the POST reply. */
  id: string;
  /** Tool name, e.g. `"bash"` / `"write_file"`. */
  tool: string;
  /** Risk bucket of the tool. */
  riskClass: RiskClass;
  /**
   * Why approval is being asked. `"policy"` = the policy matrix demands it;
   * `"untrusted"` = untrusted-context trigger fired; `"on-failure"` = the tool
   * already ran and failed, asking retry/abandon.
   */
  trigger: "policy" | "untrusted" | "on-failure";
  /** Human-readable preview: the command / path + a short snippet. */
  preview: string;
  /** Full parsed tool args, for transparency in the UI. */
  args: Record<string, unknown>;
  /**
   * Optional context the model emitted alongside the tool call (assistant
   * rationale), when the host can supply it.
   */
  rationale?: string;
}

/**
 * The outcome the user (or an auto-matched rule) returns for an
 * {@link ApprovalRequest}.
 *
 *   - `allow_once`    — run this single call, ask again next time.
 *   - `allow_session` — run, and auto-allow this tool for the rest of the
 *                       session (a session-scoped rule is recorded).
 *   - `allow_prefix`  — run, and auto-allow future calls whose command starts
 *                       with `prefix` (a prefix rule is recorded).
 *   - `deny`          — do not run; `reason` is written into the tool result.
 *   - `retry`         — (on-failure only) re-run the tool.
 *   - `abandon`       — (on-failure only) stop retrying; surface the failure.
 */
export interface ApprovalDecision {
  outcome:
    | "allow_once"
    | "allow_session"
    | "allow_prefix"
    | "deny"
    | "retry"
    | "abandon";
  /** Required when `outcome === "allow_prefix"`. */
  prefix?: string;
  /** Optional human reason; written into the tool result on deny. */
  reason?: string;
}

/**
 * Host-specific function that surfaces an {@link ApprovalRequest} to the user
 * and resolves with their {@link ApprovalDecision}.
 *
 *   - CLI REPL: readline inline prompt.
 *   - serve: register a pending promise + emit an `approval_request` SSE event;
 *     a `POST …/approval/:id` resolves it.
 *   - one-shot / goal: NO resolver is wired → the broker fails safe (deny).
 */
export type ApprovalResolver = (
  req: ApprovalRequest,
) => Promise<ApprovalDecision>;

/**
 * Optional host hook the broker calls when learning-mode wants to propose
 * upgrading a repeated decision into a standing rule. Returns whether the
 * user accepted. Hosts that cannot prompt (serve background, one-shot) may
 * omit it → no proposal is made.
 */
export type RuleProposalResolver = (proposal: {
  tool: string;
  prefix: string;
  count: number;
}) => Promise<boolean>;

/**
 * Granular approval channels — a second-layer override on top of the coarse
 * {@link ApprovalPolicy}. Inspired by Codex's `GranularApprovalConfig`, but
 * adapted to mathran's actual prompt surfaces (Codex's `sandbox_approval` /
 * `rules` / `skill_approval` / `request_permissions` / `mcp_elicitation`).
 *
 * Each channel is one of the orthogonal user-interaction paths that can
 * surface an approval prompt:
 *
 *   - `tool_execution`     — high-risk tool dispatch (write_file / edit_file /
 *                            bash / run_python / run_latex / dispatch_subagent
 *                            / git_commit / hook scripts …). This is the
 *                            channel the broker's {@link ApprovalBroker.preCheck}
 *                            / {@link ApprovalBroker.authorize} flow gates.
 *                            Setting it `false` short-circuits the policy
 *                            matrix to `pass` for this channel (effectively
 *                            "never" for tool execution while leaving other
 *                            channels gated).
 *   - `rule_proposal`      — the learning-mode prompt that asks the user to
 *                            upgrade a repeated decision into a standing
 *                            rule (consulted by the broker's internal
 *                            {@link RuleProposalResolver} dispatch).
 *   - `ask_user`           — the built-in `ask_user` tool round-trip that
 *                            pauses execution and surfaces a question to the
 *                            user. When `false` the tool returns the canned
 *                            non-interactive reply without prompting.
 *   - `request_permissions` — RESERVED. mathran has no `request_permissions`
 *                            tool yet (Codex parity slot); the channel is
 *                            wired so a follow-up PR can attach it without a
 *                            breaking schema change. Defaults to `true`.
 *   - `mcp_elicitation`    — RESERVED. mathran's MCP client does not yet
 *                            forward server-initiated elicitation prompts;
 *                            the channel is wired so a follow-up PR can
 *                            attach it without a breaking schema change.
 *                            Defaults to `true`.
 *
 * Default for every channel is `true` (prompt as usual) — this keeps the
 * surface 100% backward compatible with the pre-granular behaviour. The
 * coarse {@link ApprovalPolicy} still wins: when policy is `"never"` every
 * channel is forced `false` regardless of the granular config (granular
 * cannot make a `"never"` policy more permissive — only restrict further).
 */
export type GranularChannel =
  | "tool_execution"
  | "rule_proposal"
  | "ask_user"
  | "request_permissions"
  | "mcp_elicitation";

/** All valid {@link GranularChannel} values (runtime list for tests). */
export const GRANULAR_CHANNELS: readonly GranularChannel[] = [
  "tool_execution",
  "rule_proposal",
  "ask_user",
  "request_permissions",
  "mcp_elicitation",
] as const;

export interface GranularApprovalConfig {
  /** Tool dispatch gate (write/exec/net riskClass calls). */
  tool_execution: boolean;
  /** Learning-mode "upgrade this to a standing rule?" prompt. */
  rule_proposal: boolean;
  /** Built-in `ask_user` tool prompt. */
  ask_user: boolean;
  /** Reserved — Codex parity for a future request_permissions tool. */
  request_permissions: boolean;
  /** Reserved — MCP server-initiated elicitation prompts. */
  mcp_elicitation: boolean;
}

/**
 * Default granular config — every channel ON. This is the value used when
 * `settings.json` carries no `approval.granular` block, preserving the
 * pre-granular prompt surface byte-for-byte.
 */
export const DEFAULT_GRANULAR_APPROVAL_CONFIG: GranularApprovalConfig = {
  tool_execution: true,
  rule_proposal: true,
  ask_user: true,
  request_permissions: true,
  mcp_elicitation: true,
};

/**
 * Coerce a partial / untyped granular config from layered settings into a
 * fully-populated {@link GranularApprovalConfig}. Missing keys default to
 * `true`; non-boolean values are also treated as `true` (fail open — the
 * user only gets stricter behaviour when they explicitly write `false`).
 */
export function resolveGranularApprovalConfig(
  partial?: Partial<Record<GranularChannel, unknown>> | null,
): GranularApprovalConfig {
  const out: GranularApprovalConfig = { ...DEFAULT_GRANULAR_APPROVAL_CONFIG };
  if (!partial || typeof partial !== "object") return out;
  for (const ch of GRANULAR_CHANNELS) {
    const v = (partial as Record<string, unknown>)[ch];
    if (typeof v === "boolean") out[ch] = v;
  }
  return out;
}
