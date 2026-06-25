/**
 * FallbackLLMProvider — NEW-F3.
 *
 * Wraps a primary LLMProvider plus an ordered chain of fallback
 * providers. When the primary throws a *transient* error (rate limit,
 * 5xx, network), the wrapper transparently retries the call against
 * each fallback in order, returning the first success.
 *
 * Goals:
 *   - mathran goals never fail just because copilot's session token
 *     expired or the provider's edge had a 502 — the daemon keeps
 *     going on the next provider in the chain.
 *   - Non-transient errors (4xx model semantics, bad arguments) are
 *     NOT retried — they propagate immediately so the caller sees the
 *     real bug instead of cascading through providers and confusing
 *     the audit log.
 *   - Streaming semantics preserved: the consumer gets a single
 *     LLMResponse with a single `stream()`. If the primary fails BEFORE
 *     emitting any chunks, we fail over silently. If it fails MID-stream
 *     (after emitting one or more chunks) we DO NOT retry — replaying
 *     half-streamed assistants would duplicate tool calls and break
 *     the runner's strict event model.
 *
 * The router decides which model maps to which provider; this wrapper
 * is provider-agnostic and sits one layer above the router. Goal /
 * chat code can opt in by replacing `new ModelRouter(cfg)` with
 * `wrapWithFallback(new ModelRouter(cfg), [...])`.
 */

import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMMessage,
} from "../../core/providers/llm.js";

/** A single entry in a fallback chain. */
export interface FallbackProviderEntry {
  /** Human-readable label for logging — e.g. "openai", "anthropic-haiku". */
  label: string;
  /** Concrete provider — typically a ModelRouter or a single-adapter wrapper. */
  provider: LLMProvider;
  /** Optional model override forwarded to this provider's `chat({model})`. */
  model?: string;
}

/**
 * Classify an error thrown by `provider.chat()` (or by the stream
 * consumption that immediately follows the await). Transient errors
 * are eligible for fallback; everything else propagates.
 *
 * Heuristics (intentionally loose — we'd rather fall back on a
 * borderline case than expose a flapping endpoint):
 *   - network / DNS / fetch-failed / ECONNRESET / ETIMEDOUT → transient
 *   - HTTP 408 / 429 / 500 / 502 / 503 / 504 → transient
 *   - HTTP 401 (token expired) → transient (often resolved by next
 *     provider in chain with separate auth)
 *   - HTTP 400 / 403 / 404 / 422 / model-specific → NOT transient
 *   - JSON-parse / schema errors → NOT transient
 */
export function isTransientLlmError(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as Error)?.message ?? err);
  const lower = msg.toLowerCase();
  // Network primitives
  if (/fetch failed|econnreset|etimedout|enotfound|econnrefused|socket hang up|network error/i.test(msg)) {
    return true;
  }
  // HTTP status hints embedded by adapters
  if (/\b(408|429|500|502|503|504)\b/.test(msg)) return true;
  // Auth refresh — token expired counts as transient because the next
  // provider in the chain typically has independent auth.
  if (/\b401\b|unauthorized|token expired/i.test(lower)) return true;
  // Rate-limit / quota wording
  if (/rate limit|too many requests|quota/i.test(lower)) return true;
  return false;
}

/**
 * Wrap a primary provider with an ordered fallback chain. The result
 * looks like any other `LLMProvider`; callers don't need to know about
 * the fallback machinery.
 */
export function wrapWithFallback(
  primary: LLMProvider,
  fallbacks: readonly FallbackProviderEntry[],
  opts: { onFallback?: (info: { from: string; to: string; error: unknown }) => void } = {},
): LLMProvider {
  return new FallbackLLMProvider(primary, fallbacks, opts.onFallback);
}

export class FallbackLLMProvider implements LLMProvider {
  constructor(
    private readonly primary: LLMProvider,
    private readonly fallbacks: readonly FallbackProviderEntry[],
    private readonly onFallback?: (info: { from: string; to: string; error: unknown }) => void,
  ) {}

  async describe() {
    return this.primary.describe();
  }

  get supportsVision(): boolean {
    return this.primary.supportsVision === true;
  }

  countTokens(messages: LLMMessage[]): number {
    return this.primary.countTokens?.(messages) ?? 0;
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const tried: { label: string; error: unknown }[] = [];
    // 1. Primary attempt.
    try {
      const res = await this.primary.chat(req);
      // We can't validate that the stream will eventually fail-fast — so
      // we wrap the iterator to emit a peek of the first chunk before
      // committing to "the primary worked".
      return wrapStreamWithPrimaryPeek(res, async () => {
        // If the primary's stream throws BEFORE producing any chunks, we
        // can still fall back. After the first chunk we commit and
        // propagate errors as-is (see file-level comment).
        // The actual fallback fires from inside wrapStreamWithPrimaryPeek.
        return null;
      }, this.fallbacks, req, this.onFallback, "primary", tried);
    } catch (err) {
      if (!isTransientLlmError(err)) throw err;
      tried.push({ label: "primary", error: err });
      // 2. Fallback chain — same retry semantics for each link.
      for (const f of this.fallbacks) {
        this.onFallback?.({ from: tried[tried.length - 1]!.label, to: f.label, error: err });
        try {
          const useReq = f.model ? { ...req, model: f.model } : req;
          const res = await f.provider.chat(useReq);
          return res;
        } catch (innerErr) {
          if (!isTransientLlmError(innerErr)) throw innerErr;
          tried.push({ label: f.label, error: innerErr });
        }
      }
      // Exhausted — re-throw the last transient error with a
      // chain-aware message so debugging surfaces every attempted hop.
      const chain = tried.map((t) => `${t.label}: ${String((t.error as Error)?.message ?? t.error)}`).join(" | ");
      throw new Error(`LLM fallback chain exhausted (${tried.length} attempt(s)): ${chain}`);
    }
  }
}

/**
 * Wrap an LLMResponse so the stream's FIRST chunk decides whether we
 * commit (real chunks → keep going) or fall back (sync error thrown
 * before any chunk → try the chain). Mid-stream failures (after the
 * first chunk lands) are propagated unchanged so we never replay
 * already-emitted assistant text.
 */
function wrapStreamWithPrimaryPeek(
  primaryRes: LLMResponse,
  _hookUnused: () => Promise<null>,
  fallbacks: readonly FallbackProviderEntry[],
  req: LLMRequest,
  onFallback: ((info: { from: string; to: string; error: unknown }) => void) | undefined,
  primaryLabel: string,
  tried: { label: string; error: unknown }[],
): LLMResponse {
  return {
    stream(): AsyncIterable<LLMStreamChunk> {
      return {
        async *[Symbol.asyncIterator]() {
          let primaryIter: AsyncIterator<LLMStreamChunk> | null = null;
          let peek: IteratorResult<LLMStreamChunk> | null = null;
          try {
            primaryIter = primaryRes.stream()[Symbol.asyncIterator]();
            peek = await primaryIter.next();
          } catch (err) {
            // Primary stream failed BEFORE emitting any chunk — fall back.
            if (!isTransientLlmError(err)) throw err;
            tried.push({ label: primaryLabel, error: err });
            yield* runFallbackChain(fallbacks, req, onFallback, tried);
            return;
          }
          if (peek.done) return;
          // Commit to primary: emit the peek, drain the rest as-is.
          yield peek.value;
          while (true) {
            const next = await primaryIter.next();
            if (next.done) return;
            yield next.value;
          }
        },
      };
    },
  };
}

async function* runFallbackChain(
  fallbacks: readonly FallbackProviderEntry[],
  req: LLMRequest,
  onFallback: ((info: { from: string; to: string; error: unknown }) => void) | undefined,
  tried: { label: string; error: unknown }[],
): AsyncGenerator<LLMStreamChunk> {
  for (const f of fallbacks) {
    const prev = tried[tried.length - 1]!.label;
    onFallback?.({ from: prev, to: f.label, error: tried[tried.length - 1]!.error });
    try {
      const useReq = f.model ? { ...req, model: f.model } : req;
      const res = await f.provider.chat(useReq);
      for await (const ch of res.stream()) {
        yield ch;
      }
      return;
    } catch (err) {
      if (!isTransientLlmError(err)) throw err;
      tried.push({ label: f.label, error: err });
    }
  }
  const chain = tried.map((t) => `${t.label}: ${String((t.error as Error)?.message ?? t.error)}`).join(" | ");
  throw new Error(`LLM fallback chain exhausted (${tried.length} attempt(s)): ${chain}`);
}
