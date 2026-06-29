/**
 * Compact subagent runner (v0.2 §5).
 *
 * Strategy (Claude Code "safeguard" style):
 *   1. Keep the system message (index 0) verbatim.
 *   2. Walk backwards from the end of history to find the last K *complete*
 *      user/assistant rounds. A round boundary is a clean `role === "user"`
 *      message; any `tool`/`assistant`-with-toolCalls in between belong to the
 *      surrounding round (we never cut a `tool_use` from its `tool_result`).
 *   3. Everything between the system message and those K rounds is the
 *      "middle chunk". If empty → no-op.
 *   4. Ask the LLM to summarize the middle chunk; replace it with one
 *      `role:"system"` message of the form `"<Previous conversation
 *      summary>\n\n" + summary`.
 *   5. Persist the new message array to an artifact JSON; ChatSession.compact()
 *      swaps it into the live `messages` field.
 *
 * The runner itself NEVER mutates the parent session. It only returns the new
 * message array via the artifact.
 */

import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMStreamChunk,
} from "../../providers/llm.js";
import {
  createOpenAITokenCounter,
  createFallbackTokenCounter,
  type TokenCounter,
} from "../../chat/token-counter.js";
import type {
  SubagentContext,
  SubagentResult,
  SubagentRunner,
  SubagentTask,
} from "../types.js";

/** Default count of recent rounds to preserve verbatim. */
export const DEFAULT_KEEP_RECENT_ROUNDS = 5;
/** Default LLM context window (used by autoCompact threshold math). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Soft cap on the produced summary (in tokens, advisory only). */
export const DEFAULT_SUMMARY_TARGET_TOKENS = 1500;

/**
 * Compaction summary prompt — codex-parity handoff framing.
 *
 * Originally ours read "Summarize ... Key facts / Decisions / Current state /
 * Anything committed to. Keep under 1500 tokens. Use third-person past tense."
 * Codex (codex-rs/prompts/templates/compact/prompt.md) frames the same call
 * as a *handoff to another LLM that will resume the task* — this framing
 * empirically yields handoffs that the resuming model can pick up without
 * losing track of work-in-flight. We adopt their wording verbatim and tack
 * on the size hint that the older mathran prompt enforced.
 *
 * 2026-06-29: aligned with codex commit a7b6bae.
 */
export const COMPACT_PROMPT_HEADER =
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff " +
  "summary for another LLM that will resume the task.\n" +
  "\n" +
  "Include:\n" +
  "- Current progress and key decisions made\n" +
  "- Important context, constraints, or user preferences\n" +
  "- What remains to be done (clear next steps)\n" +
  "- Any critical data, examples, or references needed to continue\n" +
  "\n" +
  "Be concise, structured, and focused on helping the next LLM " +
  "seamlessly continue the work. Keep the summary under ~1500 tokens.";

export const COMPACT_SUMMARY_PREFIX =
  "<Previous conversation summary — another language model started this " +
  "task; use it to continue without duplicating work>\n\n";

export interface CompactRunnerInput {
  /** Full message history (including system). */
  messages: LLMMessage[];
  /** Provider context window (for the caller's threshold math; the runner
   *  itself just records it for downstream stats). */
  contextWindow?: number;
  /** Number of recent rounds to keep verbatim (default 5). */
  keepRecentRounds?: number;
  /** Optional model hint for the summary call (passed straight to LLMRequest). */
  modelHint?: string;
  /** Provider used to run the summary call. Injected by ChatSession.compact(). */
  llm?: LLMProvider;
}

export interface CompactedArtifact {
  /** Full replacement history. */
  newMessages: LLMMessage[];
  /** Token count of the original history (best-effort). */
  originalTokenCount: number;
  /** Token count of the new history (best-effort). */
  newTokenCount: number;
  /** Number of complete rounds dropped from the middle of history. */
  droppedRoundCount: number;
  /** The summary text the LLM produced (without the prefix). */
  summaryText: string;
  /** True when no-op (middle chunk was empty). */
  noop: boolean;
}

/**
 * Find the index where the last K *complete* user-rooted rounds start.
 *
 * A "round start" is a `role === "user"` message. We walk backwards through
 * `messages` (starting *after* any leading system message), counting user
 * messages; the K-th hit from the end is the start of the kept tail.
 *
 * Returns the *absolute* index into `messages`. If there are fewer than K
 * user messages, returns the index right after the system block (i.e. the
 * whole non-system history is kept).
 */
export function findKeepStartIndex(messages: LLMMessage[], keepRounds: number): number {
  if (keepRounds <= 0) return messages.length;
  // Skip leading system messages so we don't accidentally drop them.
  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem].role === "system") {
    firstNonSystem++;
  }
  let userSeen = 0;
  for (let i = messages.length - 1; i >= firstNonSystem; i--) {
    if (messages[i].role === "user") {
      userSeen++;
      if (userSeen === keepRounds) return i;
    }
  }
  // Fewer user messages than we want to keep → keep the entire non-system tail.
  return firstNonSystem;
}

/** Pick a TokenCounter for ad-hoc message accounting. The runner does NOT have
 *  provider context here, so we fall back to gpt-tokenizer/o200k_base. */
function makeCounter(modelHint?: string): TokenCounter {
  try {
    return createOpenAITokenCounter(modelHint);
  } catch {
    return createFallbackTokenCounter();
  }
}

/** Render the middle chunk as a single prompt the summarizer LLM can read. */
function renderMiddleAsPrompt(middle: LLMMessage[]): string {
  const lines: string[] = [];
  for (const m of middle) {
    const tag = m.role.toUpperCase();
    let body = m.content ?? "";
    if (m.toolCalls && m.toolCalls.length > 0) {
      const calls = m.toolCalls
        .map((c) => `→ ${c.name}(${c.arguments})`)
        .join("\n");
      body = body ? `${body}\n${calls}` : calls;
    }
    if (m.role === "tool" && m.name) {
      lines.push(`[${tag} ${m.name}]\n${body}`);
    } else {
      lines.push(`[${tag}]\n${body}`);
    }
  }
  return lines.join("\n\n");
}

/** Consume an LLMResponse stream and return the concatenated text. */
async function collectText(
  stream: AsyncIterable<LLMStreamChunk>,
): Promise<string> {
  let out = "";
  for await (const ch of stream) {
    if (ch.type === "text") out += ch.delta;
  }
  return out;
}

/**
 * Compute everything the artifact needs given a `messages` array + a
 * (possibly injected) summarizer LLM. Exported so unit tests can drive the
 * logic without touching the scheduler / artifact IO.
 */
export async function computeCompacted(
  input: CompactRunnerInput,
): Promise<CompactedArtifact> {
  const keepRounds = input.keepRecentRounds ?? DEFAULT_KEEP_RECENT_ROUNDS;
  const messages = input.messages;
  const counter = makeCounter(input.modelHint);
  const originalTokenCount = counter.countMessages(messages);

  // Split: leading system block + middle + tail.
  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem].role === "system") {
    firstNonSystem++;
  }
  const systemBlock = messages.slice(0, firstNonSystem);
  const keepStart = findKeepStartIndex(messages, keepRounds);
  const middle = messages.slice(firstNonSystem, keepStart);
  const tail = messages.slice(keepStart);

  if (middle.length === 0) {
    return {
      newMessages: messages.map((m) => ({ ...m })),
      originalTokenCount,
      newTokenCount: originalTokenCount,
      droppedRoundCount: 0,
      summaryText: "",
      noop: true,
    };
  }

  // Count complete user-rooted rounds inside the middle chunk.
  const droppedRoundCount = middle.reduce(
    (n, m) => n + (m.role === "user" ? 1 : 0),
    0,
  );

  // Ask the LLM to summarize.
  let summaryText = "";
  if (input.llm) {
    const prompt = `${COMPACT_PROMPT_HEADER}\n\n--- BEGIN HISTORY ---\n${renderMiddleAsPrompt(
      middle,
    )}\n--- END HISTORY ---`;
    const req: LLMRequest = {
      messages: [
        {
          role: "system",
          content:
            "You are a conversation summarizer. Output only the summary paragraph; no preamble, no headers.",
        },
        { role: "user", content: prompt },
      ],
      model: input.modelHint ?? "",
      maxTokens: DEFAULT_SUMMARY_TARGET_TOKENS,
    };
    const response = await input.llm.chat(req);
    summaryText = (await collectText(response.stream())).trim();
  }
  if (!summaryText) {
    // Fallback: best-effort deterministic skeleton if no LLM is wired.
    summaryText = `Earlier dialog covered ${droppedRoundCount} user turn(s); details elided.`;
  }

  const summaryMessage: LLMMessage = {
    role: "system",
    content: COMPACT_SUMMARY_PREFIX + summaryText,
  };

  // UX gap B — reasoning is the FIRST thing dropped on compaction: it is
  // helpful while live but disposable once a turn is in the historical tail.
  // Strip the `reasoning` field from every kept message so the compacted
  // context never spends tokens replaying old chains-of-thought.
  const stripReasoning = (m: LLMMessage): LLMMessage => {
    if (m.reasoning === undefined) return { ...m };
    const { reasoning: _drop, ...rest } = m;
    return { ...rest };
  };

  const newMessages: LLMMessage[] = [
    ...systemBlock.map(stripReasoning),
    summaryMessage,
    ...tail.map(stripReasoning),
  ];
  const newTokenCount = counter.countMessages(newMessages);

  return {
    newMessages,
    originalTokenCount,
    newTokenCount,
    droppedRoundCount,
    summaryText,
    noop: false,
  };
}

export const compactRunner: SubagentRunner = {
  type: "compact",
  async run(
    task: SubagentTask,
    ctx: SubagentContext,
  ): Promise<Omit<SubagentResult, "runId" | "type" | "stats">> {
    const input = task.input as unknown as CompactRunnerInput;
    if (!input || !Array.isArray(input.messages)) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "compact: task.input.messages must be an LLMMessage[]",
      };
    }
    if (ctx.signal.aborted) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "compact: aborted before start",
      };
    }

    let artifact: CompactedArtifact;
    try {
      artifact = await computeCompacted(input);
    } catch (err) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage:
          err instanceof Error ? err.message : `compact: ${String(err)}`,
      };
    }

    const artifactPath = await ctx.writeArtifact(
      "compacted.json",
      JSON.stringify(artifact, null, 2),
    );

    const summary = JSON.stringify({
      noop: artifact.noop,
      originalTokenCount: artifact.originalTokenCount,
      newTokenCount: artifact.newTokenCount,
      droppedRoundCount: artifact.droppedRoundCount,
      contextWindow: input.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    });

    return {
      status: "ok",
      summary,
      artifactPath,
    };
  },
};

// ====================================================================
// V2 path — TODO-2 §5.3 / C5
// ====================================================================
//
// Everything ABOVE this line is the v0.2 §5 legacy compactRunner: it stays
// byte-identical so the 18 existing compact.test.ts cases keep passing.
//
// Below: LocalCompactionStrategy — a strategy-shaped wrapper that adds
// the multi-strategy contract (AbortSignal, independent retry, Reason/
// Phase/Trigger awareness, 9-section structured prompt, rebuildHistory
// injection per phase). ChatSession.compactV2 (C6) will route requests
// through this; the daemon/goal-mode wiring (C7) will then enable it
// for every goal-driven turn.

import type {
  CompactionRequest,
  CompactionOutcome,
  CompactionTelemetry,
  CompactionStatus,
} from "./compact-types.js";
import { rebuildHistory } from "./compact-injection.js";
import {
  build9SectionPrompt,
  summarizationSystemPrompt,
} from "./compact-prompt.js";
import type { CompactionStrategyImpl } from "./compact-strategies.js";

/** Backoff delays in ms between retries (capped at the configured retryBudget). */
const RETRY_BACKOFFS_MS = [500, 1_500, 4_000];

/** Soft cap on the V2 summary (in tokens, advisory only — same as legacy). */
export const V2_SUMMARY_TARGET_TOKENS = DEFAULT_SUMMARY_TARGET_TOKENS;

/**
 * The built-in compaction strategy. Implements the full V2 contract:
 *   - Reason/Phase/Trigger aware via req fields.
 *   - SummaryInjectionPolicy applied via rebuildHistory (so mid-turn
 *     compactions land summary just above the last real user message,
 *     pre-turn lands at the front).
 *   - AbortSignal observed at every retry boundary; if the LLM call
 *     supports a signal it gets forwarded.
 *   - Independent retry budget (default 2 additional attempts) with
 *     exponential backoff, ISOLATED from the main turn retry budget so
 *     a 429 storm on the summarizer call does NOT eat the goal's
 *     retry headroom.
 *   - Never mutates req.messages.
 *   - Always populates a complete CompactionTelemetry, even on failure.
 *   - Failure returns ok=false; the caller (ChatSession.compactV2) is
 *     responsible for NOT mutating the live session when ok=false.
 */
export class LocalCompactionStrategy implements CompactionStrategyImpl {
  readonly name = "local";

  supports(_req: CompactionRequest): boolean {
    // Local strategy is always available; future remote / hierarchical
    // strategies can register with higher precedence.
    return true;
  }

  async run(req: CompactionRequest): Promise<CompactionOutcome> {
    const startedAtMs = Date.now();
    const baseTelemetry: CompactionTelemetryBase = {
      reason: req.reason,
      phase: req.phase,
      trigger: req.trigger,
      policy: req.policy,
      strategy: this.name,
      startedAtMs,
    };

    if (req.signal?.aborted) {
      return makeFailure(req, baseTelemetry, "cancelled", "aborted before start", 0);
    }

    const counter = makeCounter(req.modelHint);
    const originalTokens = counter.countMessages(req.messages);

    // Split [systemBlock] + middle + tail.
    let firstNonSystem = 0;
    while (
      firstNonSystem < req.messages.length &&
      req.messages[firstNonSystem].role === "system"
    ) {
      firstNonSystem++;
    }
    const systemBlock = req.messages.slice(0, firstNonSystem);
    const keepRounds = req.keepRecentRounds ?? DEFAULT_KEEP_RECENT_ROUNDS;
    const keepStart = findKeepStartIndex(req.messages, keepRounds);
    const middle = req.messages.slice(firstNonSystem, keepStart);
    const tail = req.messages.slice(keepStart);

    if (middle.length === 0) {
      // Nothing to compact — return the original history (cloned) as the
      // "newMessages" so the caller can no-op the swap. Status = "ok" +
      // droppedRoundCount = 0 is the noop signal.
      const endedAtMs = Date.now();
      return {
        ok: true,
        status: "ok",
        newMessages: req.messages.map((m) => ({ ...m })),
        summaryText: "",
        telemetry: {
          ...baseTelemetry,
          endedAtMs,
          durationMs: endedAtMs - startedAtMs,
          status: "ok",
          originalTokens,
          newTokens: originalTokens,
          droppedRoundCount: 0,
          retryAttempts: 0,
        },
      };
    }

    const droppedRoundCount = middle.reduce(
      (n, m) => n + (m.role === "user" ? 1 : 0),
      0,
    );

    // Run the summarizer with independent retry budget.
    const maxAttempts = (req.retryBudget ?? 2) + 1;
    let summaryText = "";
    let lastErr: unknown = null;
    let attemptsTried = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      attemptsTried = attempt + 1;
      if (req.signal?.aborted) {
        return makeFailure(req, baseTelemetry, "cancelled", `aborted during attempt ${attemptsTried}`, attemptsTried - 1, originalTokens);
      }
      try {
        summaryText = await this.callSummarizer(req, middle);
        if (summaryText.length > 0) break;
        lastErr = new Error("empty summary returned");
      } catch (err) {
        lastErr = err;
      }
      // Backoff before the next attempt (skip on the very last failure).
      if (attempt + 1 < maxAttempts) {
        const wait = RETRY_BACKOFFS_MS[Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)];
        const aborted = await sleepInterruptible(wait, req.signal);
        if (aborted) {
          return makeFailure(req, baseTelemetry, "cancelled", `aborted during backoff after attempt ${attemptsTried}`, attemptsTried, originalTokens);
        }
      }
    }

    if (!summaryText) {
      return makeFailure(
        req,
        baseTelemetry,
        "failed",
        `summarizer failed after ${attemptsTried} attempt(s): ${stringifyErr(lastErr)}`,
        attemptsTried,
        originalTokens,
      );
    }

    // Reassemble new history per the injection policy.
    const newMessages = rebuildHistory({
      systemBlock,
      tail,
      summary: summaryText,
      policy: req.policy,
    });
    const newTokens = counter.countMessages(newMessages);
    const summaryTokens = counter.countMessages([
      { role: "system", content: summaryText },
    ]);
    const endedAtMs = Date.now();

    return {
      ok: true,
      status: "ok",
      newMessages,
      summaryText,
      telemetry: {
        ...baseTelemetry,
        endedAtMs,
        durationMs: endedAtMs - startedAtMs,
        status: "ok",
        originalTokens,
        newTokens,
        droppedRoundCount,
        summaryTokens,
        retryAttempts: Math.max(0, attemptsTried - 1),
      },
    };
  }

  /**
   * Invoke the summarizer LLM with the 9-section prompt. Forwards
   * AbortSignal to the LLM call when the provider supports a signal
   * option (best-effort — older providers ignore it).
   */
  private async callSummarizer(
    req: CompactionRequest,
    middle: LLMMessage[],
  ): Promise<string> {
    const userPrompt = build9SectionPrompt(middle);
    const llmReq: LLMRequest = {
      messages: [
        { role: "system", content: summarizationSystemPrompt() },
        { role: "user", content: userPrompt },
      ],
      model: req.modelHint ?? "",
      maxTokens: V2_SUMMARY_TARGET_TOKENS,
    };
    // Best-effort signal forwarding: cast to access the (optional) second arg
    // some providers accept. Providers that ignore it simply don't observe
    // cancellation mid-stream; the next retry boundary will catch it.
    const llmAny = req.llm as LLMProvider & {
      chat(req: LLMRequest, opts?: { signal?: AbortSignal }): Promise<{ stream(): AsyncIterable<LLMStreamChunk> }>;
    };
    const response = await llmAny.chat(llmReq, { signal: req.signal });
    return (await collectText(response.stream())).trim();
  }
}

// ----- helpers (V2-private) -----

type CompactionTelemetryBase = Pick<
  CompactionTelemetry,
  "reason" | "phase" | "trigger" | "policy" | "strategy" | "startedAtMs"
>;

function makeFailure(
  req: CompactionRequest,
  base: CompactionTelemetryBase,
  status: Exclude<CompactionStatus, "ok">,
  error: string,
  attemptsTried: number,
  originalTokensOverride?: number,
): CompactionOutcome {
  const endedAtMs = Date.now();
  const originalTokens =
    originalTokensOverride ?? makeCounter(req.modelHint).countMessages(req.messages);
  return {
    ok: false,
    status,
    error,
    telemetry: {
      ...base,
      endedAtMs,
      durationMs: endedAtMs - base.startedAtMs,
      status,
      originalTokens,
      newTokens: originalTokens, // unchanged
      droppedRoundCount: 0,
      retryAttempts: Math.max(0, attemptsTried - 1),
    },
  };
}

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Sleep `ms` milliseconds but resolve early (returning `true`) if the
 * signal aborts during the wait. Returns `false` on natural timeout.
 */
function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
