/**
 * Hooks v1 — Claude Code-style hook config + JSON I/O schemas.
 *
 * This is a NEW subsystem that lives alongside the legacy filename-prefix hook
 * system (`src/core/hooks/loader.ts` + `executor.ts`). The two coexist:
 *
 *   - legacy: `.mathran/hooks/<type>-*.sh` files, no config, runs on every match.
 *   - v1:     `hooks.json` config with explicit matcher + command, JSON stdin/
 *             stdout, Claude Code-compatible event names + matcher aliases.
 *
 * v1 supports 5 events (`PreToolUse` / `PostToolUse` / `SessionStart` /
 * `PreCompact` / `PostCompact`) and one handler type only (shell) — exec'd via
 * `execFile` (NOT a shell), with a stdin JSON payload + stdout JSON response.
 *
 * Matcher syntax mirrors Claude Code:
 *
 *   - `"*"` or empty / omitted → matches any input
 *   - `"Bash"` → exact match
 *   - `"Edit|Write"` → exact match against any pipe-split alternative
 *   - anything else → JS regex against the input
 *
 * Claude Code alias compat: callers can pass `aliases: ["Write", "Edit", …]`
 * alongside the canonical tool name, and a hook configured with matcher
 * `"Write"` matches a mathran `write_file` call. See `aliases.ts`.
 *
 * Stdin payload (one line of JSON) is event-specific; stdout payload is the
 * hook's response. v1 currently understands the following stdout shapes:
 *
 *   { "decision": "block", "reason": "..."          }  → block + reason
 *   { "decision": "allow", "updated_input": {...} } → allow w/ rewritten input
 *   { "hookSpecificOutput": { ... } }                → Claude Code passthrough
 *   anything else / empty                            → allow
 *
 * Plus exit-code rules:
 *
 *   exit 0 → allow (stdout JSON may still rewrite/inject context)
 *   exit 2 → block (stderr text becomes block reason)
 *   any other non-zero → block ("hook exited with code N")
 *
 * Timeout (default 30 s) → block with a timeout reason. Block reasons are
 * surfaced to the LLM as the failing tool's `ok: false, content: ...` result
 * so the model can react.
 */

/** The 5 v1 event names. Names are case-sensitive (Claude Code-compatible). */
export type HookV1Event =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "PreCompact"
  | "PostCompact";

export const HOOK_V1_EVENTS: ReadonlyArray<HookV1Event> = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "PreCompact",
  "PostCompact",
];

/** One configured hook entry. `command` is the absolute path to a script. */
export interface HookV1Entry {
  /** Event this hook listens to. */
  event: HookV1Event;
  /** Matcher syntax: `*`, `""`, exact, `A|B`, or regex. Optional → matches all. */
  matcher?: string;
  /** Absolute path to the hook script (resolved at load time). */
  command: string;
  /** Per-hook timeout override in seconds (default 30 s). */
  timeoutSec?: number;
  /** Source layer for diagnostics. */
  source: "user" | "workspace";
  /** Origin path of the hooks.json this entry came from (for warnings). */
  sourcePath: string;
}

/** Raw on-disk shape of `hooks.json`. Both top-level keys are optional. */
export interface HookV1ConfigFile {
  /** Per-event arrays of `{ matcher, hooks: [{ command, timeout? }, ...] }`. */
  hooks?: {
    [event in HookV1Event]?: HookV1MatcherGroup[];
  };
}

export interface HookV1MatcherGroup {
  matcher?: string;
  hooks: HookV1HandlerConfig[];
}

export interface HookV1HandlerConfig {
  /** Always `"command"` for v1 (shell hook only). */
  type?: "command";
  /** Absolute or relative path to the hook script. */
  command: string;
  /** Per-hook timeout in seconds (default 30 s). */
  timeout?: number;
}

// ────────────────────────────────────────────────────────────────────────
// stdin payloads (one JSON object per event, written to the hook's stdin)
// ────────────────────────────────────────────────────────────────────────

interface HookV1BaseInput {
  hookEventName: HookV1Event;
  /** Workspace root (absolute). */
  cwd: string;
  /** Session id. */
  sessionId?: string;
}

export interface PreToolUseInput extends HookV1BaseInput {
  hookEventName: "PreToolUse";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
}

export interface PostToolUseInput extends HookV1BaseInput {
  hookEventName: "PostToolUse";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: { ok: boolean; content: string };
  toolUseId?: string;
}

export interface SessionStartInput extends HookV1BaseInput {
  hookEventName: "SessionStart";
  /** "startup" | "resume" | other caller-supplied tag. */
  source?: string;
}

export interface PreCompactInput extends HookV1BaseInput {
  hookEventName: "PreCompact";
  /** "pre_turn" / "mid_turn" / etc. */
  phase?: string;
  reason?: string;
}

export interface PostCompactInput extends HookV1BaseInput {
  hookEventName: "PostCompact";
  phase?: string;
  reason?: string;
  status?: string;
  droppedRoundCount?: number;
}

export type HookV1Input =
  | PreToolUseInput
  | PostToolUseInput
  | SessionStartInput
  | PreCompactInput
  | PostCompactInput;

// ────────────────────────────────────────────────────────────────────────
// stdout payload (parsed from the hook's stdout, optional)
// ────────────────────────────────────────────────────────────────────────

/** Parsed shape of a hook's stdout JSON response. All fields optional. */
export interface HookV1Output {
  /** Legacy / shorthand: `"block"` = deny, `"allow"` = allow. */
  decision?: "block" | "allow";
  /** Block reason (when `decision === "block"`). */
  reason?: string;
  /** Rewritten tool input (PreToolUse only). */
  updated_input?: Record<string, unknown>;
  /** Additional context for the model (any event). */
  additionalContext?: string;
  /** Claude Code-style nested payload. */
  hookSpecificOutput?: {
    hookEventName?: HookV1Event;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
}

// ────────────────────────────────────────────────────────────────────────
// invocation outcome (what the invoker hands the call site)
// ────────────────────────────────────────────────────────────────────────

/** Per-hook execution result. */
export interface HookV1RunResult {
  entry: HookV1Entry;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  parsed?: HookV1Output;
  parseError?: string;
  /** True when this single hook decided to block. */
  blocked: boolean;
  blockReason?: string;
  /** Updated tool input contributed by THIS hook (PreToolUse). */
  updatedInput?: Record<string, unknown>;
  /** Additional context contributed by THIS hook. */
  additionalContext?: string;
}

/** Aggregate outcome across every matched hook for one event/call. */
export interface HookV1Outcome {
  /** Per-hook results in configured order (user first, then workspace). */
  results: HookV1RunResult[];
  /** True when ANY matched hook produced a block. */
  blocked: boolean;
  /** First block reason (configured order). */
  blockReason?: string;
  /** Last non-empty updated_input wins (PreToolUse, when not blocked). */
  updatedInput?: Record<string, unknown>;
  /** All additional contexts, in configured order. */
  additionalContexts: string[];
}

/** Empty outcome (no matching hooks). */
export const EMPTY_OUTCOME: HookV1Outcome = Object.freeze({
  results: [],
  blocked: false,
  additionalContexts: [],
});
