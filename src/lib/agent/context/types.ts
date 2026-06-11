/**
 * Compaction taxonomy. Mirrors codex `CompactionTrigger/Reason/Phase/Strategy`
 * defined in codex-rs/core/src/compact.rs (HEAD 2026-06-10).
 *
 * Used to classify each compaction run for telemetry, hook routing, and
 * prompt selection. Replaces the existing magic-string stopKind / reason
 * fields scattered across compaction.ts and chat-handler.ts.
 *
 * - Trigger : who asked
 * - Reason  : why now
 * - Phase   : where in the turn lifecycle
 * - Strategy: which backend did the work
 *
 * Ported: 2026-06-10 (commit 1/6 of mathub-ai-codex-upgrade).
 */

export const CompactionTrigger = {
  Auto: "auto", // executor auto-triggered (size-based)
  Manual: "manual", // user /compact or explicit API call
} as const;
export type CompactionTrigger =
  (typeof CompactionTrigger)[keyof typeof CompactionTrigger];

export const CompactionReason = {
  UserRequested: "user_requested",
  BudgetExceeded: "budget_exceeded", // tokens-per-turn budget gate
  TokenLimit: "token_limit", // approached provider context window
  ContextWindow: "context_window", // hard ceiling, must compact now
  ToolFailureTooLarge: "tool_failure_too_large", // huge tool result blew the budget
  MidTurnPreflight: "mid_turn_preflight", // pre-call estimate would overflow
} as const;
export type CompactionReason =
  (typeof CompactionReason)[keyof typeof CompactionReason];

export const CompactionPhase = {
  PreTurn: "pre_turn", // before send; no in-flight assistant turn
  MidTurn: "mid_turn", // mid-stream; must inject summary before last user msg
  PostTurn: "post_turn", // after assistant finishes; opportunistic
  StandaloneTurn: "standalone_turn", // user explicitly fired /compact as its own turn
} as const;
export type CompactionPhase =
  (typeof CompactionPhase)[keyof typeof CompactionPhase];

export const CompactionStrategy = {
  Local: "local", // single LLM call, in-process
  // (codex has remote_v1 / remote_v2 — Azure OpenAI does not expose a remote
  //  /compact endpoint, so we only ship Local. Future: dispatch to background
  //  goal-run job as RemoteAgent strategy.)
} as const;
export type CompactionStrategy =
  (typeof CompactionStrategy)[keyof typeof CompactionStrategy];

/**
 * Where to inject the freshly-built summary back into history.
 *
 * Mirrors codex `InitialContextInjection`. Mid-turn compaction MUST inject
 * *before* the last user message because the model's training distribution
 * assumes the summary precedes the live user request; injecting after the
 * user message causes hallucinated continuations.
 */
export const SummaryInjectionPolicy = {
  BeforeLastUserMessage: "before_last_user_message",
  DoNotInject: "do_not_inject", // pre-turn / standalone; next turn re-injects
} as const;
export type SummaryInjectionPolicy =
  (typeof SummaryInjectionPolicy)[keyof typeof SummaryInjectionPolicy];

export const TruncationPolicy = {
  Compaction: "compaction", // replace older messages with summary item
  Pruning: "pruning", // hard-drop oldest, no summary
} as const;
export type TruncationPolicy =
  (typeof TruncationPolicy)[keyof typeof TruncationPolicy];

/** Telemetry record emitted after every compaction run. Persist + log. */
export interface CompactionTelemetry {
  trigger: CompactionTrigger;
  reason: CompactionReason;
  phase: CompactionPhase;
  strategy: CompactionStrategy;
  policy: TruncationPolicy;
  inputTokens: number;
  outputTokens: number;
  inputMessages: number;
  outputMessages: number;
  durationMs: number;
  status: "ok" | "cancelled" | "failed" | "skipped";
  errorMessage?: string;
  conversationId?: string;
  retryCount: number;
}
