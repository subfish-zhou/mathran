/**
 * Compaction strategy registry + LocalCompactionStrategy (the only ship
 * strategy in commit 3/6). Inspired by codex `compact_remote_v2.rs` plugin
 * surface, but adapted to Mathub's DB-driven compaction (no in-memory
 * `messages` array — the LLM input is a pre-built transcript string).
 *
 * The strategy contract is intentionally narrow:
 *
 *   • input  : transcript text + system instructions + abort signal
 *   • output : summary text + token accounting + telemetry skeleton
 *
 * Hook integration / DB writes / history rewrite happen in compaction.ts
 * around the strategy; the strategy itself owns *only* the LLM call.
 *
 * Ported: 2026-06-10 (commit 3/6 of mathub-ai-codex-upgrade).
 */

import {
  CompactionStrategy,
  CompactionTrigger,
  CompactionReason,
  CompactionPhase,
  TruncationPolicy,
  type CompactionTelemetry,
} from "./types";
import { getAzureClient, DEFAULT_AZURE_MODEL, logLLMUsage } from "../azure-llm";
import { COMPACTION_PROMPT_LIMIT } from "../constants";

export interface CompactionRequest {
  /** Optional conversation key for telemetry / hook routing. */
  conversationId?: string;
  /** Pre-built transcript text (caller is responsible for trimming). */
  transcript: string;
  /** Approximate input-side token count of `transcript`, for telemetry only. */
  approxInputTokens: number;
  /** Row count being compacted (telemetry only). */
  inputMessages: number;
  reason: CompactionReason;
  phase: CompactionPhase;
  trigger: CompactionTrigger;
  policy: TruncationPolicy;
  /** Cancel-friendly: passed to the LLM SDK request. */
  signal?: AbortSignal;
  /** Per-strategy retry budget, independent from main turn budget. Default 2. */
  retryBudget?: number;
  /** Optional cap on `max_completion_tokens` for the summarizer LLM call. Default 1024. */
  maxCompletionTokens?: number;
}

export interface CompactionSuccess {
  ok: true;
  summary: string;
  outputTokens: number;
  telemetry: CompactionTelemetry;
}

export interface CompactionFailure {
  ok: false;
  telemetry: CompactionTelemetry;
  error: unknown;
}

export type CompactionOutcome = CompactionSuccess | CompactionFailure;

export interface CompactionStrategyImpl {
  name: CompactionStrategy;
  supports(req: CompactionRequest): boolean;
  run(req: CompactionRequest): Promise<CompactionOutcome>;
}

const strategies: CompactionStrategyImpl[] = [];

export function registerCompactionStrategy(s: CompactionStrategyImpl): void {
  strategies.push(s);
}

export function pickStrategy(req: CompactionRequest): CompactionStrategyImpl {
  for (const s of strategies) if (s.supports(req)) return s;
  throw new Error(
    `no compaction strategy for reason=${req.reason} phase=${req.phase}`,
  );
}

/** Test-only. */
export function _resetStrategiesForTest(): void {
  strategies.length = 0;
}

// ─── LocalCompactionStrategy ────────────────────────────────────────

const SUMMARIZER_SYSTEM_PROMPT =
  "Summarize the following conversation excerpt concisely, preserving key facts, decisions, tool results, and user preferences. Output a single summary paragraph in the same language as the conversation.";

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function makeTelemetry(
  req: CompactionRequest,
  status: CompactionTelemetry["status"],
  extras: Partial<CompactionTelemetry> = {},
): CompactionTelemetry {
  return {
    trigger: req.trigger,
    reason: req.reason,
    phase: req.phase,
    strategy: CompactionStrategy.Local,
    policy: req.policy,
    inputTokens: req.approxInputTokens,
    outputTokens: 0,
    inputMessages: req.inputMessages,
    outputMessages: 0,
    durationMs: 0,
    status,
    conversationId: req.conversationId,
    retryCount: 0,
    ...extras,
  };
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ERR_ABORTED";
}

export class LocalCompactionStrategy implements CompactionStrategyImpl {
  readonly name = CompactionStrategy.Local;

  supports(_req: CompactionRequest): boolean {
    return true; // fallback strategy
  }

  async run(req: CompactionRequest): Promise<CompactionOutcome> {
    const start = Date.now();
    const budget = req.retryBudget ?? 2;
    const maxOut = req.maxCompletionTokens ?? 1024;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < budget; attempt++) {
      if (req.signal?.aborted) {
        return {
          ok: false,
          telemetry: makeTelemetry(req, "cancelled", {
            durationMs: Date.now() - start,
            retryCount: attempt,
          }),
          error: new Error("AbortSignal already aborted"),
        };
      }

      try {
        const client = getAzureClient(DEFAULT_AZURE_MODEL);
        const trimmed = req.transcript.slice(0, COMPACTION_PROMPT_LIMIT);
        const completion = await client.chat.completions.create(
          {
            model: DEFAULT_AZURE_MODEL,
            messages: [
              { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
              { role: "user", content: trimmed },
            ],
            max_completion_tokens: maxOut,
          },
          { signal: req.signal },
        );

        const summary = completion.choices?.[0]?.message?.content?.trim();

        if (completion.usage) {
          logLLMUsage({
            tracker: { module: "chat", operation: "compaction" },
            model: DEFAULT_AZURE_MODEL,
            promptTokens: completion.usage.prompt_tokens ?? 0,
            completionTokens: completion.usage.completion_tokens ?? 0,
            totalTokens: completion.usage.total_tokens ?? 0,
            latencyMs: Date.now() - start,
          });
        }

        if (!summary) {
          lastError = new Error("compaction LLM returned empty summary");
          continue; // retry
        }

        const outputTokens =
          completion.usage?.completion_tokens ?? approxTokens(summary);
        return {
          ok: true,
          summary,
          outputTokens,
          telemetry: makeTelemetry(req, "ok", {
            outputTokens,
            outputMessages: 1,
            durationMs: Date.now() - start,
            retryCount: attempt,
          }),
        };
      } catch (err) {
        if (isAbortError(err) || req.signal?.aborted) {
          return {
            ok: false,
            telemetry: makeTelemetry(req, "cancelled", {
              durationMs: Date.now() - start,
              retryCount: attempt,
              errorMessage:
                (err as Error)?.message ?? "compaction aborted by signal",
            }),
            error: err,
          };
        }
        lastError = err;
        // retry until budget exhausted
      }
    }

    return {
      ok: false,
      telemetry: makeTelemetry(req, "failed", {
        durationMs: Date.now() - start,
        retryCount: budget,
        errorMessage: (lastError as Error)?.message ?? String(lastError),
      }),
      error: lastError,
    };
  }
}

let _booted = false;
/** Register builtin strategies once at module-load. Idempotent. */
export function ensureBuiltinStrategiesRegistered(): void {
  if (_booted) return;
  _booted = true;
  registerCompactionStrategy(new LocalCompactionStrategy());
}

/** Test-only: clear the boot flag (call with _resetStrategiesForTest). */
export function _resetBuiltinStrategiesBootForTest(): void {
  _booted = false;
}
