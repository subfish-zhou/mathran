/**
 * LLM Router — routes model requests to the correct provider based on
 * model prefix and supports automatic fallback on failure.
 *
 * Features:
 *   - Retry with exponential backoff (429/500/502/503)
 *   - Rate limit awareness (x-ratelimit-remaining, retry-after)
 *   - Improved fallback (retry exhausted before switching)
 *   - Provider health tracking with cooldown
 *   - Per-call logging (provider, model, latency, tokens, success/fail)
 *
 * Routing rules:
 *   "azure/<model>"     → AzureOpenAIProvider (model = part after prefix)
 *   "anthropic/<model>" → AnthropicProvider   (model = part after prefix)
 *   no prefix           → OpenAIProvider       (or Azure if LLM_PRIMARY_MODEL unset)
 *
 * Configuration (env vars):
 *   LLM_PRIMARY_MODEL   — default model string, e.g. "azure/gpt-55"
 *   LLM_FALLBACK_MODEL  — optional fallback, e.g. "anthropic/claude-sonnet-4-20250514"
 */

import {
  type LLMProvider,
  type LLMProviderParams,
  type ChatChunk,
  AzureOpenAIProvider,
  OpenAIProvider,
  AnthropicProvider,
} from "./llm-provider";
import { log } from "@/lib/observability/logger";

// ========== Provider singletons ==========

const providers = {
  azure: new AzureOpenAIProvider(),
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
} as const;

type ProviderKey = keyof typeof providers;

interface ParsedModel {
  providerKey: ProviderKey;
  modelName: string;
}

function parseModelString(modelStr: string): ParsedModel {
  const idx = modelStr.indexOf("/");
  if (idx === -1) {
    // No prefix — bare model name; route to Azure for backward compat
    return { providerKey: "azure", modelName: modelStr };
  }
  const prefix = modelStr.slice(0, idx).toLowerCase();
  const modelName = modelStr.slice(idx + 1);

  if (prefix === "azure") return { providerKey: "azure", modelName };
  if (prefix === "anthropic") return { providerKey: "anthropic", modelName };
  if (prefix === "openai") return { providerKey: "openai", modelName };

  // Unknown prefix — treat entire string as model name and route to OpenAI
  return { providerKey: "openai", modelName: modelStr };
}

function getProvider(key: ProviderKey): LLMProvider {
  return providers[key];
}

// ========== Rate Limit State ==========

interface RateLimitState {
  remaining: number | null;
  retryAfterMs: number | null;
  lastUpdated: number;
}

const rateLimitMap = new Map<ProviderKey, RateLimitState>();

function getRateLimitState(key: ProviderKey): RateLimitState {
  let state = rateLimitMap.get(key);
  if (!state) {
    state = { remaining: null, retryAfterMs: null, lastUpdated: 0 };
    rateLimitMap.set(key, state);
  }
  return state;
}

/**
 * If remaining < 5, proactively delay before the next request.
 */
async function applyRateLimitDelay(key: ProviderKey): Promise<void> {
  const state = getRateLimitState(key);
  // If we got a retry-after that hasn't expired, wait for it
  if (state.retryAfterMs !== null && state.lastUpdated > 0) {
    const elapsed = Date.now() - state.lastUpdated;
    const waitMs = state.retryAfterMs - elapsed;
    if (waitMs > 0) {
            log.info("llm_router.rate_limit_wait", { key, waitMs, kind: "retry-after" });
      await new Promise((r) => setTimeout(r, waitMs));
    }
    state.retryAfterMs = null;
  }
  // Proactive delay when remaining is low
  if (state.remaining !== null && state.remaining < 5) {
    const delayMs = 1000;
        log.info("llm_router.rate_limit_delay", { key, remaining: state.remaining, delayMs });
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

function updateRateLimitFromError(key: ProviderKey, err: unknown): void {
  const state = getRateLimitState(key);
  state.lastUpdated = Date.now();

  // Try to extract retry-after from error
  if (err && typeof err === "object" && "headers" in err) {
    const headers = (err as { headers?: Record<string, string> }).headers;
    if (headers) {
      const retryAfter = headers["retry-after"];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed) && parsed > 0) {
          state.retryAfterMs = parsed * 1000;
        }
      }
      const remaining = headers["x-ratelimit-remaining"];
      if (remaining) {
        const parsed = parseInt(remaining, 10);
        if (!isNaN(parsed)) {
          state.remaining = parsed;
        }
      }
    }
  }
}

// ========== Provider Health ==========

interface ProviderHealth {
  consecutiveFailures: number;
  unhealthySince: number | null; // timestamp when marked unhealthy
}

const HEALTH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const UNHEALTHY_THRESHOLD = 3;

const healthMap = new Map<ProviderKey, ProviderHealth>();

function getHealth(key: ProviderKey): ProviderHealth {
  let h = healthMap.get(key);
  if (!h) {
    h = { consecutiveFailures: 0, unhealthySince: null };
    healthMap.set(key, h);
  }
  return h;
}

function isHealthy(key: ProviderKey): boolean {
  const h = getHealth(key);
  if (h.unhealthySince === null) return true;
  // Check if cooldown has elapsed
  if (Date.now() - h.unhealthySince >= HEALTH_COOLDOWN_MS) {
    return true; // allow retry after cooldown
  }
  return false;
}

function recordSuccess(key: ProviderKey): void {
  const h = getHealth(key);
  h.consecutiveFailures = 0;
  h.unhealthySince = null;
}

function recordFailure(key: ProviderKey): void {
  const h = getHealth(key);
  h.consecutiveFailures++;
  if (h.consecutiveFailures >= UNHEALTHY_THRESHOLD && h.unhealthySince === null) {
    h.unhealthySince = Date.now();
    console.warn(`[LLMRouter] Provider "${key}" marked unhealthy after ${h.consecutiveFailures} consecutive failures`);
  }
}

// ========== Retry Logic ==========

const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);

/**
 * In-place stream retries on the FIRST (primary) attempt for transient errors
 * that fail before any token is emitted (429 / 5xx / connection / TLS). This
 * closes the gap where the primary streaming path previously did zero retries
 * and a single transient blip crashed the whole agent turn. Fallback attempts
 * use their own `callWithRetry` budget on top of this.
 */
const FIRST_ATTEMPT_RETRIES = 2;

/**
 * Azure OpenAI content-filter / Responsible-AI rejection.
 *
 * Surfaces two distinct failure modes under one type so callers (executor,
 * goal-run job) can recognize them and degrade gracefully instead of treating
 * the run as a hard crash:
 *
 *   - "prompt"     — the *request* was filtered (Azure returns HTTP 400 with
 *                    code "content_filter"). This is DETERMINISTIC: retrying the
 *                    same prompt is futile, so we do not blind-retry; we try a
 *                    cross-provider fallback once (if configured) and otherwise
 *                    raise this error.
 *   - "completion" — the *response* tripped the filter mid-stream
 *                    (finish_reason === "content_filter"). The stream ends with
 *                    truncated content; the executor flags this rather than
 *                    pretending the turn completed normally.
 */
export class ContentFilterError extends Error {
  readonly kind = "content_filter" as const;
  readonly stage: "prompt" | "completion";
  readonly providerKey: string;
  readonly model: string;
  readonly cause?: unknown;

  constructor(opts: {
    stage: "prompt" | "completion";
    providerKey: string;
    model: string;
    message?: string;
    cause?: unknown;
  }) {
    super(
      opts.message ??
        `Request blocked by ${opts.providerKey} content-management policy (${opts.stage}).`,
    );
    this.name = "ContentFilterError";
    this.stage = opts.stage;
    this.providerKey = opts.providerKey;
    this.model = opts.model;
    this.cause = opts.cause;
  }
}

/**
 * Detect an Azure OpenAI request-level content-filter rejection.
 *
 * The openai SDK lifts `code`/`param`/`message` to top-level APIError props
 * (see node_modules/openai/src/core/error.ts). Azure returns HTTP 400 with
 * `code: "content_filter"`; we also match on the policy message text and the
 * ResponsibleAI innererror as a defensive fallback in case the code field
 * shifts across API versions.
 */
export function isContentFilterError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    code?: string | null;
    message?: string;
  };
  if (e.status !== 400) return false;
  if (e.code === "content_filter") return true;
  const msg = (e.message ?? "").toLowerCase();
  return (
    msg.includes("content management policy") ||
    msg.includes("content_filter") ||
    msg.includes("responsibleai") ||
    msg.includes("jailbreak")
  );
}

/**
 * Classify whether an error is worth retrying. Transient infra failures
 * (429 / 500 / 502 / 503 and network/connection errors) are retryable;
 * deterministic ones (content-filter, 400 bad-request, 401/403 auth, user
 * aborts) are not. Exported for unit testing.
 */
export function isRetryableError(err: unknown): boolean {
  if (err && typeof err === "object") {
    // Content-filter rejections are deterministic — never blind-retry them.
    if (isContentFilterError(err)) return false;
    // Check for status property (APIError from openai/anthropic SDKs)
    const status = (err as { status?: number }).status;
    if (status !== undefined) {
      return RETRYABLE_STATUS.has(status);
    }
    // Network / connection errors. Covers raw Node errno strings and the
    // openai SDK's wrapped connection errors (APIConnectionError /
    // APIConnectionTimeoutError → "Connection error." / "Request timed out.").
    // Deliberately does NOT match user aborts ("Request was aborted.").
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (/\baborted\b/.test(msg)) return false; // user/caller cancellation — never retry
      return /econnreset|etimedout|econnrefused|econnaborted|enetunreach|eai_again|epipe|socket hang up|network|fetch failed|connection error|request timed out|und_err/.test(
        msg,
      );
    }
  }
  return false;
}

function getErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    return (err as { status?: number }).status;
  }
  return undefined;
}

/**
 * Collect all chunks from a provider call, with retry on retryable errors.
 * Returns collected chunks array on success.
 */
async function callWithRetry(
  provider: LLMProvider,
  params: LLMProviderParams,
  providerKey: ProviderKey,
  maxRetries: number,
): Promise<ChatChunk[]> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await applyRateLimitDelay(providerKey);
      const chunks: ChatChunk[] = [];
      for await (const chunk of provider.chatCompletion(params)) {
        chunks.push(chunk);
      }
      return chunks;
    } catch (err) {
      lastError = err;
      updateRateLimitFromError(providerKey, err);

      if (!isRetryableError(err) || attempt === maxRetries) {
        break;
      }

      // Exponential backoff: 1s, 2s, 4s
      let delayMs = 1000 * 2 ** attempt;

      // For 429, respect retry-after header
      const status = getErrorStatus(err);
      if (status === 429) {
        const state = getRateLimitState(providerKey);
        if (state.retryAfterMs !== null) {
          delayMs = Math.max(delayMs, state.retryAfterMs);
        }
      }

      console.warn(
        `[LLMRouter] Retry ${attempt + 1}/${maxRetries} for ${providerKey}/${params.model}` +
        ` (status=${status ?? "network"}, wait=${Math.round(delayMs / 1000)}s):`,
        err instanceof Error ? err.message : err,
      );

      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastError;
}

// ========== LLMRouter ==========

export class LLMRouter {
  private primaryModel: string;
  private fallbackModel: string | null;

  constructor(opts?: { primaryModel?: string; fallbackModel?: string | null }) {
    this.primaryModel =
      opts?.primaryModel ?? process.env.LLM_PRIMARY_MODEL ?? "azure/gpt-55";
    this.fallbackModel =
      opts?.fallbackModel !== undefined
        ? opts.fallbackModel
        : (process.env.LLM_FALLBACK_MODEL ?? null);
  }

  /**
   * Stream chat completion chunks from the appropriate provider.
   * Retries on transient errors before falling back. Logs each call.
   */
  async *chatCompletion(
    params: Omit<LLMProviderParams, "model"> & { model?: string },
  ): AsyncIterable<ChatChunk> {
    const modelStr = params.model ?? this.primaryModel;
    const parsed = parseModelString(modelStr);

    // Determine order: if primary is unhealthy and fallback is healthy, swap
    const attempts: Array<{ parsed: ParsedModel; modelStr: string; maxRetries: number }> = [];

    const primaryHealthy = isHealthy(parsed.providerKey);
    const hasFallback = this.fallbackModel !== null;

    if (!primaryHealthy && hasFallback) {
      const fb = parseModelString(this.fallbackModel!);
      if (isHealthy(fb.providerKey)) {
        // Prefer fallback first since primary is unhealthy
        attempts.push({ parsed: fb, modelStr: this.fallbackModel!, maxRetries: 2 });
        attempts.push({ parsed, modelStr, maxRetries: 3 });
      } else {
        // Both unhealthy, try primary first
        attempts.push({ parsed, modelStr, maxRetries: 3 });
        attempts.push({ parsed: fb, modelStr: this.fallbackModel!, maxRetries: 2 });
      }
    } else {
      attempts.push({ parsed, modelStr, maxRetries: 3 });
      if (hasFallback) {
        const fb = parseModelString(this.fallbackModel!);
        attempts.push({ parsed: fb, modelStr: this.fallbackModel!, maxRetries: 2 });
      }
    }

    let lastError: unknown;
    // Track a content-filter rejection so we can surface a structured
    // ContentFilterError after exhausting providers (instead of the raw
    // SDK APIError). Content-filter is deterministic per prompt, so the only
    // recovery worth attempting is a *different* provider/deployment — which
    // the normal fallback loop already does.
    let cfInfo: { providerKey: string; model: string; message: string } | null = null;

    for (let ai = 0; ai < attempts.length; ai++) {
      const { parsed: p, modelStr: mStr, maxRetries } = attempts[ai]!;
      const provider = getProvider(p.providerKey);
      const startMs = Date.now();
      const isFirstAttempt = ai === 0;

      try {
        if (isFirstAttempt) {
          // First attempt: stream directly for real-time token delivery.
          //
          // Transient-error retry WITHOUT losing streaming: we retry the same
          // model in-place, but ONLY while we haven't yielded any chunk yet.
          // Request-level transients (429 / 5xx / connection refused / TLS
          // handshake) reject inside create()/first-next() before any token is
          // emitted, so this covers them. Once a chunk has been yielded, a
          // mid-stream break can't be retried (it would duplicate already-sent
          // tokens) — we rethrow and let the fallback/error path handle it.
          let streamYieldedAny = false;
          let streamErr: unknown;
          for (let sa = 0; sa <= FIRST_ATTEMPT_RETRIES; sa++) {
            try {
              await applyRateLimitDelay(p.providerKey);
              const stream = provider.chatCompletion({ ...params, model: p.modelName });
              let usage: ChatChunk["usage"] | undefined;
              for await (const chunk of stream) {
                streamYieldedAny = true;
                if (chunk.usage) usage = chunk.usage;
                yield chunk;
              }
              recordSuccess(p.providerKey);
              const latencyMs = Date.now() - startMs;
              log.info("llm_router.success", {
                providerKey: p.providerKey, modelName: p.modelName, latencyMs,
                totalTokens: usage?.total_tokens ?? null, mode: "stream",
              });
              return;
            } catch (err) {
              streamErr = err;
              updateRateLimitFromError(p.providerKey, err);
              // Content-filter is deterministic — never retry; hand off to the
              // outer catch which records it for a structured throw.
              if (isContentFilterError(err)) throw err;
              // Can't safely retry once tokens were emitted, or if the error
              // isn't transient, or if we're out of retries.
              if (streamYieldedAny || !isRetryableError(err) || sa === FIRST_ATTEMPT_RETRIES) {
                throw err;
              }
              let delayMs = 1000 * 2 ** sa;
              const status = getErrorStatus(err);
              if (status === 429) {
                const state = getRateLimitState(p.providerKey);
                if (state.retryAfterMs !== null) delayMs = Math.max(delayMs, state.retryAfterMs);
              }
              console.warn(
                `[LLMRouter] Stream retry ${sa + 1}/${FIRST_ATTEMPT_RETRIES} for ${p.providerKey}/${p.modelName}` +
                ` (status=${status ?? "network"}, wait=${Math.round(delayMs / 1000)}s):`,
                err instanceof Error ? err.message : err,
              );
              await new Promise((r) => setTimeout(r, delayMs));
            }
          }
          // Unreachable in practice (loop either returns or throws), but keep
          // TS happy and fail loud if control ever falls through.
          throw streamErr ?? new Error("LLMRouter: stream retry loop exited unexpectedly");
        } else {
          // Fallback attempts: buffer + retry (already failed streaming once)
          const chunks = await callWithRetry(
            provider,
            { ...params, model: p.modelName },
            p.providerKey,
            maxRetries,
          );
          recordSuccess(p.providerKey);
          const latencyMs = Date.now() - startMs;
          const usage = chunks.find((c) => c.usage)?.usage;
          log.info("llm_router.success", {
            providerKey: p.providerKey, modelName: p.modelName, latencyMs,
            totalTokens: usage?.total_tokens ?? null, mode: "buffer",
          });
          for (const chunk of chunks) {
            yield chunk;
          }
          return;
        }
      } catch (err) {
        lastError = err;
        const latencyMs = Date.now() - startMs;

        if (isContentFilterError(err)) {
          // Deterministic rejection — NOT a provider-health problem, so don't
          // count it toward the unhealthy-provider circuit breaker. Record it
          // so we can throw a structured ContentFilterError if every attempt
          // (including cross-provider fallback) is filtered.
          cfInfo = {
            providerKey: p.providerKey,
            model: p.modelName,
            message: err instanceof Error ? err.message : String(err),
          };
          console.warn(
            `[LLMRouter] ⚠ ${p.providerKey}/${p.modelName} ${latencyMs}ms CONTENT-FILTER (prompt):`,
            cfInfo.message,
          );
          if (ai < attempts.length - 1) {
            console.warn(
              `[LLMRouter] Content-filter on "${mStr}" — trying next provider/deployment (filter config may differ)`,
            );
          }
          continue;
        }

        recordFailure(p.providerKey);
        console.error(
          `[LLMRouter] ✗ ${p.providerKey}/${p.modelName} ${latencyMs}ms FAIL:`,
          err instanceof Error ? err.message : err,
        );

        if (ai < attempts.length - 1) {
          console.warn(
            `[LLMRouter] Provider "${mStr}" failed, falling back to next provider`,
          );
        }
      }
    }

    // Every attempt failed. If a content-filter rejection was the cause,
    // surface a structured error so the executor / goal-run job can degrade
    // gracefully (tell the user it was blocked) rather than crash as a generic
    // failure. A non-content-filter error takes precedence only if it was the
    // last thing we saw without any content-filter in the mix.
    if (cfInfo) {
      throw new ContentFilterError({
        stage: "prompt",
        providerKey: cfInfo.providerKey,
        model: cfInfo.model,
        message: cfInfo.message,
        cause: lastError,
      });
    }

    throw lastError;
  }

  /** Returns the resolved primary model string */
  get defaultModel(): string {
    return this.primaryModel;
  }
}
