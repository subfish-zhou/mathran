/**
 * Conversation Compaction (Phase 3.1 → commit 3/6 of mathub-ai-codex-upgrade)
 *
 * Token-aware compaction: when a conversation exceeds TOKEN_THRESHOLD tokens
 * or MESSAGE_COUNT_THRESHOLD messages, older messages are summarized by the
 * LLM into a single "summary" message. Original messages are marked
 * `is_compacted = true` but not deleted.
 *
 * Upgrade summary (2026-06-10, commit 3):
 *   - Hook integration via runPreCompactHooks / runPostCompactHooks.
 *     PreCompact may skip → status='skipped' telemetry, no DB write.
 *   - Cancel-friendly: optional AbortSignal forwarded to the strategy.
 *     A pre-write abort produces status='cancelled' telemetry, no DB write.
 *   - Independent retry budget inside LocalCompactionStrategy; does NOT
 *     share the main turn retry budget.
 *   - Reason / Phase / Trigger classification (see ./types.ts) feeds
 *     telemetry, hooks, and the injection policy chosen by
 *     ./compaction-injection.ts.
 *   - Legacy `maybeCompactConversation(channelId, topicId, assistantId)`
 *     API preserved verbatim — internally trampolines into
 *     compactConversationV2.
 *
 * Preserved Mathub-specific behavior (NOT to be lost):
 *   - is_compacted=true soft tombstone (no row deletion)
 *   - tiktoken (js-tiktoken) per-row口径 (rowTokens) matches loadChannelContext
 *   - Snap-forward turn boundary cut (snapToTurnStart)
 *   - Prior summary merge: include is_summary=true rows in transcript with
 *     [prior summary] label so the new summary folds them forward, keeping
 *     ≤ 1 live summary at all times.
 *   - Atomic transaction: mark-isCompacted + insert-summary commit together.
 */

import { getDb } from "@/server/db";
import { channelMessages } from "@/server/db/schema";
import { eq, and, asc, sql, inArray } from "drizzle-orm";
import { MESSAGE_CONTENT_SLICE } from "../constants";
import {
  CompactionReason,
  CompactionPhase,
  CompactionTrigger,
  TruncationPolicy,
  type CompactionTelemetry,
} from "./types";
import {
  ensureBuiltinStrategiesRegistered,
  pickStrategy,
  type CompactionRequest,
  type CompactionOutcome,
} from "./compaction-strategies";
import { injectionPolicyForPhase } from "./compaction-injection";
import {
  runPreCompactHooks,
  runPostCompactHooks,
} from "../hooks/runtime";

const TOKEN_THRESHOLD = 80_000;
const MESSAGE_COUNT_THRESHOLD = 50;
const TARGET_TOKEN_BUDGET = 40_000;

// Ensure builtin strategy registry is populated before first dispatch. Idempotent.
ensureBuiltinStrategiesRegistered();

// ---------- Token estimation ----------

let _encoder: { encode: (text: string) => number[] } | null = null;
let _encoderFailed = false;

function getEncoder() {
  if (_encoder) return _encoder;
  if (_encoderFailed) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { encodingForModel } = require("js-tiktoken") as typeof import("js-tiktoken");
    _encoder = encodingForModel("gpt-4o");
    return _encoder;
  } catch {
    _encoderFailed = true;
    return null;
  }
}

function countTokens(text: string): number {
  const enc = getEncoder();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      // fallback below
    }
  }
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total token count for an array of message-like objects.
 * Falls back to chars/4 if js-tiktoken is unavailable.
 *
 * NOTE: this counts ONLY the `content` column. For compaction-trigger parity
 * with what `loadChannelContext` actually feeds the LLM (tool rows serialize
 * `toolResult`, assistant rows append serialized `metadata.toolCalls`), use
 * {@link estimateRowTokens} / {@link rowTokens} instead. This helper is kept
 * for callers that only have a bare `content` (e.g. summary text).
 */
export function estimateTokens(items: { content?: string | null }[]): number {
  let total = 0;
  for (const item of items) {
    if (item.content) {
      total += countTokens(item.content);
    }
  }
  return total;
}

/** A `channel_messages` row in the shape the token estimator needs. */
type CompactionRow = {
  content: string | null;
  toolCallId: string | null;
  toolResult: unknown;
  metadata: unknown;
};

/**
 * Token cost of a SINGLE channel-message row, measured by the EXACT form the
 * row takes when `loadChannelContext` (chat-handler.ts) feeds it to the LLM.
 * (See compaction.ts history for the full口径 rationale.)
 */
export function rowTokens(row: CompactionRow): number {
  // Tool result row.
  if (row.toolCallId) {
    const toolContent =
      row.toolResult != null ? JSON.stringify(row.toolResult) : (row.content ?? "");
    return countTokens(toolContent);
  }

  // Assistant TEXT row with embedded tool calls.
  let total = countTokens(row.content ?? "");
  const meta = row.metadata as
    | { toolCalls?: Array<{ name?: string; args?: unknown; callId?: string }> }
    | null
    | undefined;
  if (meta?.toolCalls?.length) {
    for (const tc of meta.toolCalls) {
      const serialized = `${tc.callId ?? ""}${tc.name ?? ""}${JSON.stringify(tc.args ?? null)}`;
      total += countTokens(serialized);
    }
  }
  return total;
}

/** Sum {@link rowTokens} over a set of rows. */
export function estimateRowTokens(rows: CompactionRow[]): number {
  let total = 0;
  for (const row of rows) total += rowTokens(row);
  return total;
}

/**
 * Snap a backward-keep cut index FORWARD to the nearest turn boundary so the
 * compacted prefix `rows.slice(0, idx)` is always an integer number of whole
 * conversation turns (Phase 3.1 turn-atomicity guard). See compaction.ts
 * history for the full rationale.
 */
export function snapToTurnStart(
  rows: { role: string }[],
  idx: number,
): number {
  for (let j = idx; j < rows.length; j++) {
    if (rows[j]!.role === "user") return j;
  }
  return rows.length;
}

function authorKindToRole(kind: string): string {
  switch (kind) {
    case "user":
      return "user";
    case "assistant":
    case "bot":
      return "assistant";
    default:
      return kind;
  }
}

// ─── V2 entry point ────────────────────────────────────────────────

export interface CompactConversationV2Input {
  channelId: string;
  topicId: string;
  assistantId: string;
  reason: CompactionReason;
  phase: CompactionPhase;
  trigger: CompactionTrigger;
  /** Cancel-friendly: any in-flight LLM call is aborted; no DB write happens after abort. */
  signal?: AbortSignal;
  /** Per-strategy retry budget. Default 2. */
  retryBudget?: number;
}

export interface CompactConversationV2Result {
  /**
   * "ok": summary written + isCompacted flipped.
   * "skipped_threshold": no rows over threshold; nothing to do.
   * "skipped_short": after backward-keep + snap, < 5 rows would be compacted; skip.
   * "skipped_hook": PreCompact hook returned skip.
   * "skipped_empty_summary": LLM returned empty after retries.
   * "cancelled": AbortSignal aborted before write.
   * "failed": strategy returned ok=false (retries exhausted, not cancel).
   */
  status:
    | "ok"
    | "skipped_threshold"
    | "skipped_short"
    | "skipped_hook"
    | "skipped_empty_summary"
    | "cancelled"
    | "failed";
  telemetry?: CompactionTelemetry;
  skipReason?: string;
  errorMessage?: string;
}

export async function compactConversationV2(
  input: CompactConversationV2Input,
): Promise<CompactConversationV2Result> {
  const { channelId, topicId, assistantId, signal } = input;
  const db = getDb();

  // Step 1: load live rows from DB (unchanged behavior).
  const rows = await db
    .select({
      id: channelMessages.id,
      role: channelMessages.authorKind,
      content: channelMessages.content,
      toolCallId: channelMessages.toolCallId,
      toolResult: channelMessages.toolResult,
      metadata: channelMessages.metadata,
      isSummary: channelMessages.isSummary,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        eq(channelMessages.isCompacted, false),
      ),
    )
    .orderBy(asc(channelMessages.createdAt));

  const totalTokensPre = estimateRowTokens(rows);

  const shouldCompact =
    totalTokensPre > TOKEN_THRESHOLD || rows.length > MESSAGE_COUNT_THRESHOLD;
  if (!shouldCompact) {
    return { status: "skipped_threshold" };
  }

  // Step 2: backward-keep + snap to turn boundary (unchanged behavior).
  let keptTokens = 0;
  let keepFromIndex = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const msgTokens = rowTokens(rows[i]!);
    if (keptTokens + msgTokens > TARGET_TOKEN_BUDGET) break;
    keptTokens += msgTokens;
    keepFromIndex = i;
  }
  keepFromIndex = snapToTurnStart(rows, keepFromIndex);

  const toCompact = rows.slice(0, keepFromIndex);
  if (toCompact.length < 5) {
    return { status: "skipped_short" };
  }

  const compactedTokens = estimateRowTokens(toCompact);

  // Step 3: PreCompact hooks — may veto.
  const preGate = await runPreCompactHooks({
    conversationId: channelId,
    reason: input.reason,
    phase: input.phase,
    inputMessages: toCompact.length,
    inputTokens: compactedTokens,
  });
  if (!preGate.proceed) {
    return {
      status: "skipped_hook",
      skipReason: preGate.skipReason ?? "preCompactHook=skip",
    };
  }

  // Step 4: early abort check (caller may have cancelled while we hit DB).
  if (signal?.aborted) {
    return { status: "cancelled" };
  }

  // Step 5: build transcript (unchanged behavior).
  const transcript = toCompact
    .map((m) => {
      const label = m.isSummary ? "prior summary" : authorKindToRole(m.role);
      return `[${label}]: ${m.content?.slice(0, MESSAGE_CONTENT_SLICE) ?? ""}`;
    })
    .join("\n");

  const req: CompactionRequest = {
    conversationId: channelId,
    transcript,
    approxInputTokens: compactedTokens,
    inputMessages: toCompact.length,
    reason: input.reason,
    phase: input.phase,
    trigger: input.trigger,
    policy: TruncationPolicy.Compaction,
    signal,
    retryBudget: input.retryBudget,
  };

  // Step 6: dispatch to strategy.
  const outcome: CompactionOutcome = await pickStrategy(req).run(req);

  if (!outcome.ok) {
    // PostCompact hooks observe failures too (telemetry status='cancelled' or 'failed').
    await runPostCompactHooks({
      conversationId: channelId,
      telemetry: outcome.telemetry,
    });
    return {
      status: outcome.telemetry.status === "cancelled" ? "cancelled" : "failed",
      telemetry: outcome.telemetry,
      errorMessage: outcome.telemetry.errorMessage,
    };
  }

  // Step 7: post-LLM but pre-write abort check.
  if (signal?.aborted) {
    const cancelledTelemetry: CompactionTelemetry = {
      ...outcome.telemetry,
      status: "cancelled",
    };
    await runPostCompactHooks({
      conversationId: channelId,
      telemetry: cancelledTelemetry,
    });
    return { status: "cancelled", telemetry: cancelledTelemetry };
  }

  const summary = outcome.summary;
  if (!summary) {
    return { status: "skipped_empty_summary", telemetry: outcome.telemetry };
  }

  // Step 8: rebuild + atomic DB write (unchanged behavior).
  const totalTokensPost = keptTokens + countTokens(summary);
  const idsToCompact = toCompact.map((m) => m.id);
  const summaryWithStats = [
    summary,
    `\n[compaction: ${compactedTokens} tokens in ${toCompact.length} msgs → ${countTokens(summary)} token summary | context ${totalTokensPre} → ${totalTokensPost} tokens]`,
  ].join("");

  await db.transaction(async (tx) => {
    await tx
      .update(channelMessages)
      .set({ isCompacted: true })
      .where(
        and(
          eq(channelMessages.channelId, channelId),
          inArray(channelMessages.id, idsToCompact),
        ),
      );

    await tx.insert(channelMessages).values({
      id: sql`gen_random_uuid()::text`,
      channelId,
      topicId,
      authorKind: "assistant",
      authorAssistantId: assistantId,
      content: summaryWithStats,
      contentType: "markdown",
      isSummary: true,
    });
  });

  // Step 9: PostCompact hooks (success telemetry).
  // Note: injectionPolicyForPhase is recorded for future remote callers; the
  // DB-driven path doesn't splice in-memory, the next loadChannelContext picks
  // up the new summary row naturally.
  const injectionPolicy = injectionPolicyForPhase(input.phase);
  const successTelemetry: CompactionTelemetry = {
    ...outcome.telemetry,
    inputTokens: compactedTokens,
    inputMessages: toCompact.length,
  };
  await runPostCompactHooks({
    conversationId: channelId,
    telemetry: successTelemetry,
  });

  // Mark injectionPolicy referenced so the variable is not flagged as unused
  // (we still pass it through for future tracing / hook consumers).
  void injectionPolicy;

  return { status: "ok", telemetry: successTelemetry };
}

// ─── Legacy API (preserved) ────────────────────────────────────────

/**
 * Asynchronously compact a conversation if it exceeds token or message thresholds.
 * Safe to fire-and-forget after the agent loop finishes.
 *
 * @deprecated Prefer {@link compactConversationV2} for new call sites — it
 *   surfaces reason/phase/trigger classification, hook integration, and
 *   AbortSignal cancellation. This adapter is kept for backwards compatibility
 *   with chat-handler / fire-and-forget callers and existing tests.
 */
export async function maybeCompactConversation(
  channelId: string,
  topicId: string,
  assistantId: string,
): Promise<void> {
  await compactConversationV2({
    channelId,
    topicId,
    assistantId,
    reason: CompactionReason.BudgetExceeded,
    phase: CompactionPhase.PostTurn,
    trigger: CompactionTrigger.Auto,
  });
}
