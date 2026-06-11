/**
 * Summary injection helpers. After a compaction run produces a `summary`
 * string, the caller must decide *where* that summary lands in the message
 * stream feeding the next LLM turn.
 *
 * Mathub keeps its compaction state in the DB (`channel_messages.is_summary`),
 * so the "rebuild" form here is a thin in-memory helper used by V2 callers
 * that need to splice a summary into an ad-hoc message array (e.g. dreaming,
 * goal summarizer). DB-driven callers (`maybeCompactConversation`) keep
 * inserting a `is_summary=true` row and `injectionPolicyForPhase` is only
 * consulted to record telemetry.
 *
 * Inspired by codex `compact.rs::InitialContextInjection`. Mid-turn flows
 * MUST inject *before* the last user message — injecting after it puts the
 * model out of training distribution and produces hallucinated continuations.
 *
 * Ported: 2026-06-10 (commit 3/6 of mathub-ai-codex-upgrade).
 */

import type OpenAI from "openai";
import { SummaryInjectionPolicy, CompactionPhase } from "./types";

/** Pick injection policy from compaction phase. */
export function injectionPolicyForPhase(
  phase: CompactionPhase,
): SummaryInjectionPolicy {
  switch (phase) {
    case "mid_turn":
      return SummaryInjectionPolicy.BeforeLastUserMessage;
    case "pre_turn":
    case "post_turn":
    case "standalone_turn":
    default:
      return SummaryInjectionPolicy.DoNotInject;
  }
}

/** Wrap a raw summary string as a system-role message item. */
export function summaryToMessage(
  summary: string,
): OpenAI.Chat.ChatCompletionMessageParam {
  return {
    role: "system",
    content: `[conversation summary]\n${summary}`,
  };
}

/**
 * In-memory history rebuild. Inserts the summary at the point dictated by
 * policy. `do_not_inject` returns retained unchanged (caller will splice the
 * summary in on the *next* turn boundary).
 */
export function rebuildHistory(args: {
  retained: OpenAI.Chat.ChatCompletionMessageParam[];
  summary: string;
  policy: SummaryInjectionPolicy;
}): OpenAI.Chat.ChatCompletionMessageParam[] {
  const { retained, summary, policy } = args;
  if (policy === SummaryInjectionPolicy.DoNotInject) return retained;

  const summaryItem = summaryToMessage(summary);
  // Find last user-role index by scanning from the tail.
  let lastUserIdx = -1;
  for (let i = retained.length - 1; i >= 0; i--) {
    if (retained[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) {
    // No user message — put summary at the head.
    return [summaryItem, ...retained];
  }
  return [
    ...retained.slice(0, lastUserIdx),
    summaryItem,
    ...retained.slice(lastUserIdx),
  ];
}
