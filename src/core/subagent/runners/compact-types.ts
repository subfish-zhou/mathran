/**
 * Compaction types — TODO-2 §4.1 / C1.
 *
 * Cross-cutting types for the goal-mode conversation compaction pipeline.
 * Mirrors codex's CompactionReason / CompactionPhase / CompactionTrigger
 * three-axis classification (codex-rs/core/src/compact.rs) and exposes
 * an explicit SummaryInjectionPolicy for the codex
 * "BeforeLastUserMessage vs DoNotInject" distinction.
 *
 * Pure types — no runtime behavior changes ship in this commit.
 */

import type { LLMMessage, LLMProvider } from "../../providers/llm.js";

/**
 * What kind of pressure triggered the compaction. Used in telemetry +
 * routing (different strategies may handle different reasons).
 */
export type CompactionReason =
  /** History total token count is above thresholdPct * contextWindow. */
  | "budget_exceeded"
  /** Mid-turn cumulative input tokens exceeded the mid-turn threshold. */
  | "token_limit"
  /** A single tool result is too large to fit. (Reserved — no trigger this round.) */
  | "tool_failure_too_large"
  /** User explicitly invoked /compact. */
  | "user_requested"
  /** Long-running goal hit a phase boundary. (Reserved — no trigger this round.) */
  | "phase_boundary";

/**
 * Where in the agent loop the compaction runs. Drives SummaryInjectionPolicy
 * — see codex's `InitialContextInjection` doc on compact.rs:51-64 for
 * the underlying rationale.
 */
export type CompactionPhase =
  /** At send() entry, before the new user message is pushed onto history. */
  | "pre_turn"
  /** Inside one turn, between LLM round-trips (tool-heavy workflows). */
  | "mid_turn"
  /** After a turn ends, cleanup. (Not implemented this round.) */
  | "post_turn"
  /** Triggered out-of-band (CLI `/compact`, API call). */
  | "standalone";

/** Who/what asked for the compaction. */
export type CompactionTrigger = "auto" | "manual" | "hook";

/**
 * Where the summary item lands in the rebuilt history.
 *
 * - `do_not_inject` — summary lands at the front (after the system block).
 *   Used for `pre_turn` and `standalone` phases, where the next send()
 *   will push fresh user input at the end anyway.
 *
 * - `before_last_user_message` — summary is spliced INSIDE the retained
 *   tail, just above the last *real* user message. Used for `mid_turn`,
 *   because the model has been trained on "summary appears just above
 *   the latest real user request" (codex compact.rs:57-59).
 */
export type SummaryInjectionPolicy =
  | "do_not_inject"
  | "before_last_user_message";

/** Terminal status of a compaction attempt. */
export type CompactionStatus =
  /** New history was produced and (caller) swapped in. */
  | "ok"
  /** Pre-compact hook returned stopped, or middle chunk was empty. */
  | "skipped"
  /** AbortSignal fired before or during the strategy run. */
  | "cancelled"
  /** Strategy failed after exhausting retry budget. */
  | "failed";

/**
 * Hook outcomes returned from PreCompact / PostCompact handlers.
 * Pre-compact may abort the run with a reason; post-compact may signal
 * `stopped` to abort the turn (mirroring codex `PreCompactHookOutcome`
 * / `PostCompactHookOutcome`).
 */
export type PreCompactHookOutcome =
  | { kind: "continue" }
  | { kind: "stopped"; reason: string };

export type PostCompactHookOutcome =
  | { kind: "continue" }
  | { kind: "stopped" };

/**
 * Optional hooks a caller can pass to compactV2 to observe/control the
 * compaction lifecycle. Plugin extension point — no hooks ship in this
 * series; reserved for future plugins.
 */
export interface CompactionHooks {
  pre?: (req: CompactionRequest) => Promise<PreCompactHookOutcome>;
  post?: (telemetry: CompactionTelemetry) => Promise<PostCompactHookOutcome>;
}

/**
 * Everything a strategy needs to compact a history. Built by ChatSession
 * before dispatching through pickStrategy().
 */
export interface CompactionRequest {
  /** Conversation/goal id for telemetry attribution (optional, no behavior). */
  conversationId?: string;
  /** The full history to compact. Strategy is read-only; caller swaps in result. */
  messages: LLMMessage[];
  /** What kind of pressure triggered this. */
  reason: CompactionReason;
  /** Where in the agent loop we are. */
  phase: CompactionPhase;
  /** Who/what asked for the compaction. */
  trigger: CompactionTrigger;
  /** Where to splice the summary item in the rebuilt history. */
  policy: SummaryInjectionPolicy;
  /** Number of recent user-rooted rounds to keep verbatim (strategy default applies if absent). */
  keepRecentRounds?: number;
  /** Effective context window for this model (used by mid-turn telemetry). */
  contextWindow?: number;
  /** Forwarded to the summarizer LLM call. */
  modelHint?: string;
  /** LLM provider the strategy uses to produce the summary. */
  llm: LLMProvider;
  /**
   * Abort signal observed by the strategy at each retry boundary AND
   * forwarded to the LLM call if the provider supports it. When the
   * signal aborts mid-run, the strategy MUST return ok=false / status:
   * "cancelled" without mutating any external state.
   */
  signal?: AbortSignal;
  /** Per-strategy retry budget (default 2 additional attempts). */
  retryBudget?: number;
  /** Optional pre/post hooks. */
  hooks?: CompactionHooks;
}

/**
 * Result of a compaction attempt. Always carries a CompactionTelemetry.
 * `newMessages` + `summaryText` are populated only when ok=true.
 */
export interface CompactionOutcome {
  /** True iff status === "ok" and newMessages is set. */
  ok: boolean;
  status: CompactionStatus;
  /** Caller swaps this into session messages when ok=true. */
  newMessages?: LLMMessage[];
  /** Raw summary text (without the COMPACT_SUMMARY_PREFIX). */
  summaryText?: string;
  /** Always present, even on failure. */
  telemetry: CompactionTelemetry;
  /** Human-readable reason for non-ok statuses. */
  error?: string;
}

/**
 * Per-attempt structured telemetry. Logged to daemon.log + surfaced via
 * SSE compaction-end event so observability tooling can reconstruct
 * what happened without parsing arbitrary log lines.
 */
export interface CompactionTelemetry {
  reason: CompactionReason;
  phase: CompactionPhase;
  trigger: CompactionTrigger;
  policy: SummaryInjectionPolicy;
  /** Name of the CompactionStrategyImpl that ran (e.g. "local"). */
  strategy: string;
  /** Epoch ms when strategy.run() started. */
  startedAtMs: number;
  /** Epoch ms when strategy.run() returned (success OR failure). */
  endedAtMs: number;
  /** Convenience: endedAtMs - startedAtMs. */
  durationMs: number;
  status: CompactionStatus;
  /** Token count of req.messages (input). Best-effort, never undefined. */
  originalTokens: number;
  /** Token count of newMessages (output). Equal to original on non-ok. */
  newTokens: number;
  /** How many user-rooted rounds were dropped from the middle. */
  droppedRoundCount: number;
  /** Token count of the summary message itself (when ok). */
  summaryTokens?: number;
  /** How many retries were spent (0 if first attempt succeeded). */
  retryAttempts: number;
  /** Outcomes of pre/post hooks if any ran. */
  hookOutcomes?: {
    pre?: "continue" | "stopped";
    post?: "continue" | "stopped";
  };
}
