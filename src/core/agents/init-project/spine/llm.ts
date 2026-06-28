/**
 * LLM glue for the spine pipeline.
 *
 * mathub's spine modules call `callAzureLLM(prompt, opts)`; mathran is
 * provider-agnostic and DB-free, so we inject a `SpineLLM` — a thin
 * `(prompt) => Promise<string>` adapter over mathran's `LLMProvider`.
 */

import type { LLMProvider, LLMStreamChunk } from "../../../providers/llm.js";

export type SpineLLM = (
  prompt: string,
  opts?: { temperature?: number; maxTokens?: number },
) => Promise<string>;

async function collectText(stream: AsyncIterable<LLMStreamChunk>): Promise<string> {
  let out = "";
  for await (const ch of stream) {
    if (ch.type === "text") out += ch.delta;
  }
  return out;
}

/** Build a `SpineLLM` backed by a mathran `LLMProvider`. */
export function makeSpineLLM(llm: LLMProvider, model?: string): SpineLLM {
  return async (prompt, opts = {}) => {
    const resp = await llm.chat({
      model: model ?? "",
      messages: [{ role: "user", content: prompt }],
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    return collectText(resp.stream());
  };
}

/**
 * Scan `text` for the first complete, balanced JSON object or array and
 * return its `{ start, end }` byte offsets (end exclusive). Uses a brace/
 * bracket counter with a quote+escape state machine so that:
 *   - nested objects/arrays match their true closing delimiter, and
 *   - braces/brackets inside string literals (and escaped quotes) are
 *     ignored.
 * Returns `null` if no balanced value is found. This replaces a greedy
 * `indexOf('{') … lastIndexOf('}')` that mis-parses `{"ok":true} trailing }`.
 */
export function findJsonBoundary(text: string): { start: number; end: number } | null {
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  let start = -1;
  let open = "";
  let close = "";
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    open = "[";
    close = "]";
  } else if (firstObj !== -1) {
    start = firstObj;
    open = "{";
    close = "}";
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

/** Best-effort extraction of a JSON value (object or array) from an LLM reply. */
export function extractSpineJSON<T = unknown>(text: string): T | null {
  if (!text) return null;
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidate = fence[1].trim();

  const bounds = findJsonBoundary(candidate);
  if (!bounds) return null;
  try {
    return JSON.parse(candidate.slice(bounds.start, bounds.end)) as T;
  } catch {
    return null;
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decide whether an error is transient enough to be worth retrying.
 *
 * Conservative inclusion list — anything that looks like provider weather
 * (gateway / rate-limit / timeout / connection-reset) is transient. A
 * malformed-request 4xx (other than 408/429) or a clear "model not found"
 * error is NOT transient and bails immediately.
 *
 * Pre-fix: Run 13's build_spine extraction hit a single HTTP 502 from
 * Copilot, fell straight to shallowFallback, and the entire 32-node spine
 * came out missing year/authors. We never retried, even though Copilot's
 * own status page calls 502s "intermittent gateway hiccups, retry safely".
 */
export function isTransientLLMError(err: unknown): boolean {
  const msg = errMsg(err);
  // HTTP 408 (request timeout), 429 (rate limit), 5xx server-side.
  if (/HTTP\s*(408|429|5\d{2})\b/.test(msg)) return true;
  // Common Node fetch / undici / net-level conditions.
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed/i.test(msg)) return true;
  // Provider-side overload / quota / capacity / unavailable wording.
  if (/\b(overload(ed)?|temporarily unavailable|service unavailable|gateway|rate.?limit|too many requests)\b/i.test(msg)) return true;
  // Streaming / connection cut mid-flight.
  if (/stream (closed|aborted|interrupted)/i.test(msg)) return true;
  return false;
}

/**
 * Wrap a SpineLLM call with bounded retry + exponential backoff for
 * transient provider errors. Non-transient errors throw on the first
 * attempt (we don't want to mask a malformed-prompt 400 as flakiness).
 *
 * The `log` callback is invoked once per retry so the run report shows
 * which attempts hit which provider error and at what backoff.
 *
 * Default: 3 attempts, backoff 1s → 2s → 4s. Override via opts.
 */
export interface CallLLMWithRetryOpts {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Initial backoff in ms; doubles each attempt. Default 1000. */
  initialBackoffMs?: number;
  /** Logger for retry diagnostics. */
  log?: (msg: string) => void;
  /** A label identifying the call site, included in retry log lines. */
  label?: string;
}

export async function callLLMWithRetry(
  llm: SpineLLM,
  prompt: string,
  llmOpts: { temperature?: number; maxTokens?: number } = {},
  retryOpts: CallLLMWithRetryOpts = {},
): Promise<string> {
  const attempts = Math.max(1, retryOpts.maxAttempts ?? 3);
  const initial = Math.max(1, retryOpts.initialBackoffMs ?? 1000);
  const log = retryOpts.log ?? (() => {});
  const label = retryOpts.label ?? "llm";
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await llm(prompt, llmOpts);
    } catch (err) {
      lastErr = err;
      if (!isTransientLLMError(err) || attempt === attempts) {
        // Either the error is hard-fail, OR we're out of retries: throw with
        // the original error so the caller can surface the message verbatim.
        throw err;
      }
      const backoff = initial * Math.pow(2, attempt - 1);
      log(`[${label}] transient error on attempt ${attempt}/${attempts} (${errMsg(err).slice(0, 120)}) — retrying in ${backoff}ms`);
      await new Promise((res) => setTimeout(res, backoff));
    }
  }
  // Unreachable — the loop above always either returns or throws.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export type EmitFn = (e: import("./types.js").SpinePipelineEvent) => void;

export const noopEmit: EmitFn = () => {};
