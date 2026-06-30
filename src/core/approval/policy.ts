/**
 * Approval policy matrix (Approval Policy 矩阵).
 *
 * Pure decision logic mapping `(policy × riskClass × context) → outcome`.
 * No I/O, no resolver calls — the broker layers rules/denylist/history on top
 * and drives the host interaction. Keeping this pure makes the matrix trivially
 * testable, which is where most of the policy's correctness guarantees live.
 *
 * Matrix:
 * ```
 *               read    write    exec/net
 *   never       pass    pass     pass
 *   on-request  pass    ask      ask
 *   untrusted   pass    ask*     ask*       (* only if untrusted context)
 *   on-failure  pass    run-then-ask-if-fail
 * ```
 */

import type {
  ApprovalPolicy,
  GranularApprovalConfig,
  GranularChannel,
  RiskClass,
} from "./types.js";

/**
 * The matrix verdict for a single tool call:
 *
 *   - `pass`           — run silently, no approval.
 *   - `ask`            — prompt the user BEFORE running.
 *   - `ask-on-failure` — run first; only prompt if the tool fails.
 */
export type PolicyOutcome = "pass" | "ask" | "ask-on-failure";

/**
 * Context inputs that the `untrusted` policy inspects. The broker fills these
 * from the resolved tool args (path-escape check, suspicious-token scan).
 */
export interface PolicyContext {
  /** True when the call touches a path that escapes the workspace root. */
  pathEscapesWorkspace?: boolean;
  /** True when the command carries a suspicious token (rm -rf, sudo, …). */
  suspiciousCommand?: boolean;
}

/** Risk classes that are considered "high risk" (gated by the matrix). */
const HIGH_RISK: ReadonlySet<RiskClass> = new Set<RiskClass>([
  "write",
  "exec",
  "net",
]);

/**
 * Suspicious-command detection for the `untrusted` policy. Two passes:
 *
 *   1. A denylist of patterns that are almost always dangerous.
 *   2. A blocklist of bare commands that warrant a prompt under `untrusted`
 *      even when they look benign in isolation.
 *
 * This is intentionally conservative — `untrusted` is the "trust the sandbox
 * but add defense-in-depth" tier, so we only flag genuinely notable tokens and
 * let everything else through.
 */
const SUSPICIOUS_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i, // rm -rf / rm -fr / rm -r -f
  /\brm\s+-[a-z]*f[a-z]*r\b/i,
  /\bsudo\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bdd\b/i,
  /\bmkfs\b/i,
  /\bchmod\s+777\b/i,
  />\s*\/etc\b/i, // redirect into /etc
  /\b(curl|wget)\b[^\n]*\|\s*(sh|bash)\b/i, // curl … | sh
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
] as const;

/**
 * Returns true when `command` contains a token the `untrusted` policy should
 * stop and ask about. Exported for the broker + tests.
 */
export function isSuspiciousCommand(command: string): boolean {
  if (!command) return false;
  return SUSPICIOUS_PATTERNS.some((re) => re.test(command));
}

/**
 * The pure matrix lookup. Given the active `policy`, the tool's `riskClass`,
 * and (for `untrusted`) the resolved `context`, return the matrix verdict.
 *
 * Notes:
 *   - `read` is ALWAYS `pass` (read-only tools never prompt).
 *   - `never` is ALWAYS `pass` (explicit escape hatch).
 *   - `on-request` asks for every high-risk call (bash always prompts — even
 *     `ls` — until the user teaches a rule via learning mode).
 *   - `untrusted` asks only when `context` flags untrusted content.
 *   - `on-failure` defers: run, then ask only if the tool failed.
 */
export function evaluatePolicy(
  policy: ApprovalPolicy,
  riskClass: RiskClass,
  context: PolicyContext = {},
): PolicyOutcome {
  // Read-only tools never gate, regardless of policy.
  if (riskClass === "read") return "pass";
  // Low-risk by exclusion: anything not high-risk passes.
  if (!HIGH_RISK.has(riskClass)) return "pass";

  switch (policy) {
    case "never":
      return "pass";
    case "on-request":
      return "ask";
    case "untrusted":
      return context.pathEscapesWorkspace || context.suspiciousCommand
        ? "ask"
        : "pass";
    case "on-failure":
      return "ask-on-failure";
    default: {
      // Unknown policy → fail safe to the default behaviour (ask). This keeps
      // a malformed settings value from silently degrading to zero-approval.
      return "ask";
    }
  }
}

/**
 * Granular-channel gate. Sits on top of the coarse policy matrix as a
 * SECOND filter: the channel must be enabled in `granular` for a prompt to
 * surface AT ALL — even if {@link evaluatePolicy} returned `"ask"`.
 *
 * Precedence (top wins):
 *
 *   1. `policy === "never"` → ALWAYS `false`. The coarse policy is the
 *      strongest signal; granular cannot make `"never"` more permissive.
 *   2. `granular[channel] === false` → `false`. The user has explicitly
 *      muted this channel. Note this is RELATIVE TO THE POLICY — for the
 *      `tool_execution` channel under `"on-request"` this effectively makes
 *      tool execution behave like `"never"`, while leaving other channels
 *      (rule_proposal / ask_user) still prompting.
 *   3. Otherwise → `true` (defer to the coarse policy / matrix for the
 *      actual ask vs pass decision; this function only answers "is this
 *      channel allowed to prompt at all?").
 *
 * Used by the broker (tool_execution / rule_proposal channels) and by the
 * `ask_user` tool wrapper (ask_user channel). The two reserved channels
 * (request_permissions / mcp_elicitation) follow the same precedence so
 * future wirings just plug in.
 */
export function shouldPromptFor(
  channel: GranularChannel,
  policy: ApprovalPolicy,
  granular: GranularApprovalConfig,
): boolean {
  // Policy "never" forces every channel off — the coarse setting wins.
  if (policy === "never") return false;
  // Channel explicitly muted by the user.
  if (granular[channel] === false) return false;
  return true;
}
