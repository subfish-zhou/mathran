/**
 * Hook taxonomy. Mirrors codex `HookEventName` (codex-rs/protocol/src/protocol.rs).
 *
 * 10 hook points cover the full agent lifecycle. Mathub will start with all
 * of them defined, but only 4 are actually wired in this PR series (commits
 * 3-5):
 *
 *   - PreCompact / PostCompact  (commit 3, executor compaction path)
 *   - PreToolUse / PostToolUse  (commit 4, executor tool-call path)
 *   - SubagentStart / SubagentStop (commit 4, session-manager terminal path)
 *
 * SessionStart / UserPromptSubmit / PermissionRequest / Stop are exposed for
 * future use; their registries exist but no builtin handlers ship yet.
 *
 * Ported: 2026-06-10 (commit 1/6 of mathub-ai-codex-upgrade).
 */

import type {
  CompactionTelemetry,
  CompactionPhase,
  CompactionReason,
} from "../context/types";

export const HookEventName = {
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  PermissionRequest: "permission_request",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
} as const;
export type HookEventName = (typeof HookEventName)[keyof typeof HookEventName];

/** Common metadata in every hook event payload. */
export interface HookEventContext {
  hookId: string; // uuid v4, traces one hook execution
  conversationId?: string;
  userId?: string;
  agentRole?: string; // see agent-roles.ts
  turnId?: string;
  iteration?: number; // 0-indexed executor iteration within this turn
  emittedAtMs: number;
}

// ─── Per-hook payloads ────────────────────────────────────────────────

export interface PreToolUseEvent extends HookEventContext {
  event: typeof HookEventName.PreToolUse;
  toolName: string;
  toolCallId: string;
  input: unknown; // raw OpenAI function-call arguments (JSON object)
}

export interface PostToolUseEvent extends HookEventContext {
  event: typeof HookEventName.PostToolUse;
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown; // tool result body
  durationMs: number;
  success: boolean;
  errorMessage?: string;
}

export interface PermissionRequestEvent extends HookEventContext {
  event: typeof HookEventName.PermissionRequest;
  permission: string; // e.g. "fs.write", "exec.shell"
  resource?: string;
  reason?: string;
}

export interface PreCompactEvent extends HookEventContext {
  event: typeof HookEventName.PreCompact;
  reason: CompactionReason;
  phase: CompactionPhase;
  inputMessages: number;
  inputTokens: number;
}

export interface PostCompactEvent extends HookEventContext {
  event: typeof HookEventName.PostCompact;
  telemetry: CompactionTelemetry;
}

export interface SessionStartEvent extends HookEventContext {
  event: typeof HookEventName.SessionStart;
  scope: "personal" | "project" | "program" | "thread";
  scopeId?: string;
  initialMessageCount: number;
}

export interface UserPromptSubmitEvent extends HookEventContext {
  event: typeof HookEventName.UserPromptSubmit;
  messageId: string;
  textPreview: string; // first 500 chars
  attachmentCount: number;
}

export interface SubagentStartEvent extends HookEventContext {
  event: typeof HookEventName.SubagentStart;
  childSessionId: string;
  parentSessionId?: string;
  agentName?: string;
  agentRole?: string;
  depth: number;
}

export interface SubagentStopEvent extends HookEventContext {
  event: typeof HookEventName.SubagentStop;
  childSessionId: string;
  status: "completed" | "failed" | "cancelled" | "orphaned";
  durationMs: number;
  totalTokens?: number;
  resultPreview?: string;
}

export interface StopEvent extends HookEventContext {
  event: typeof HookEventName.Stop;
  reason: "user" | "completion" | "budget" | "error" | "timeout" | "no_progress";
}

export type HookEvent =
  | PreToolUseEvent
  | PostToolUseEvent
  | PermissionRequestEvent
  | PreCompactEvent
  | PostCompactEvent
  | SessionStartEvent
  | UserPromptSubmitEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | StopEvent;

// ─── Outcome shapes ──────────────────────────────────────────────────

/** PreToolUse can short-circuit / mutate input / inject context. */
export type PreToolUseOutcome =
  | { kind: "continue"; updatedInput?: unknown }
  | { kind: "blocked"; reason: string }
  | { kind: "injectContext"; additionalContext: string };

export type PostToolUseOutcome =
  | { kind: "continue"; updatedOutput?: unknown }
  | { kind: "injectContext"; additionalContext: string };

/** PreCompact can veto compaction (e.g. lock is held by another caller). */
export type PreCompactOutcome =
  | { kind: "continue" }
  | { kind: "skip"; reason: string };

/** Generic "observe-only" outcome for events that cannot mutate. */
export type ObserveOutcome = { kind: "ack" };

// ─── Hook handler signatures ────────────────────────────────────────

export interface PreToolUseHook {
  name: string;
  priority: number; // lower = earlier; default 100
  run(ev: PreToolUseEvent): Promise<PreToolUseOutcome>;
}

export interface PostToolUseHook {
  name: string;
  priority: number;
  run(ev: PostToolUseEvent): Promise<PostToolUseOutcome>;
}

export interface PreCompactHook {
  name: string;
  priority: number;
  run(ev: PreCompactEvent): Promise<PreCompactOutcome>;
}

export interface PostCompactHook {
  name: string;
  priority: number;
  run(ev: PostCompactEvent): Promise<ObserveOutcome>;
}

export interface SessionStartHook {
  name: string;
  priority: number;
  run(ev: SessionStartEvent): Promise<ObserveOutcome>;
}

export interface UserPromptSubmitHook {
  name: string;
  priority: number;
  run(ev: UserPromptSubmitEvent): Promise<ObserveOutcome>;
}

export interface SubagentLifecycleHook {
  name: string;
  priority: number;
  runStart?(ev: SubagentStartEvent): Promise<ObserveOutcome>;
  runStop?(ev: SubagentStopEvent): Promise<ObserveOutcome>;
}

export interface StopHook {
  name: string;
  priority: number;
  run(ev: StopEvent): Promise<ObserveOutcome>;
}

export type AnyHook =
  | PreToolUseHook
  | PostToolUseHook
  | PreCompactHook
  | PostCompactHook
  | SessionStartHook
  | UserPromptSubmitHook
  | SubagentLifecycleHook
  | StopHook;
