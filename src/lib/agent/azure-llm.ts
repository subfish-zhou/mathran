/**
 * Azure OpenAI LLM provider — Calls Azure OpenAI REST API
 *
 * Supports deployment:
 *   - gpt-55       (GPT-5.5, default — general purpose + code)
 *   - gpt-54       (GPT-5.4, fallback)
 *
 * Configured via environment variables:
 *   AZURE_OPENAI_ENDPOINT  — Azure OpenAI endpoint URL
 *   AZURE_OPENAI_API_KEY   — API key (if using key-based auth)
 *   AZURE_OPENAI_API_VERSION — API version (default: 2025-01-01-preview)
 *   AZURE_OPENAI_DEPLOYMENT — Default deployment name (used when model is unspecified)
 *   AZURE_OPENAI_DEPLOYMENT_GPT55 — Deployment name for the gpt-55 model id
 *   AZURE_OPENAI_DEPLOYMENT_GPT54 — Deployment name for the gpt-54 model id
 */

import OpenAI, { APIError } from "openai";
// TODO(mathran-v0.1): import { type AIModelId, AI_MODELS, DEFAULT_AI_MODEL } from "@/lib/api-routes";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { llmUsageLog } from "@/server/db/schema/agents";
import { eq } from "drizzle-orm";

// ========== Types ==========

export type AzureModelId = AIModelId;

export interface AzureLLMOptions {
  model?: AzureModelId;
  timeoutMs?: number;
  maxTokens?: number;
}

// ========== Available Models (re-exported from api-routes) ==========

export const AZURE_MODELS = AI_MODELS;

export const DEFAULT_AZURE_MODEL = DEFAULT_AI_MODEL;

// ========== Client Cache (per-deployment) ==========

// IMPL [model-routing] One OpenAI client per Azure deployment (baseURL bakes
// the deployment into the path). UI model selection now actually changes
// which deployment serves the request. Per-model overrides also let
// different models live on different endpoints/API keys (e.g. gpt-55 on
// swedencentral, gpt-54 on the older mathub-api1 endpoint).

const _clientByDeployment = new Map<string, OpenAI>();

interface AzureModelEndpoint {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deployment: string;
}

/**
 * Resolve a UI-facing model id (e.g. "gpt-55") to its Azure deployment +
 * endpoint + key. Per-model env vars take precedence; otherwise we fall back
 * to the generic AZURE_OPENAI_* triple.
 *
 *   AZURE_OPENAI_DEPLOYMENT_GPT55=gpt55
 *   AZURE_OPENAI_ENDPOINT_GPT55=https://swedencentral.api.cognitive.microsoft.com/   (optional override)
 *   AZURE_OPENAI_API_KEY_GPT55=...                                                   (optional override)
 *   AZURE_OPENAI_API_VERSION_GPT55=2025-04-01-preview                                (optional override)
 */
function resolveModelEndpoint(model: AzureModelId): AzureModelEndpoint {
  const suffix = model.toUpperCase().replace(/-/g, "");

  const endpoint =
    process.env[`AZURE_OPENAI_ENDPOINT_${suffix}`] ??
    process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey =
    process.env[`AZURE_OPENAI_API_KEY_${suffix}`] ??
    process.env.AZURE_OPENAI_API_KEY;
  const apiVersion =
    process.env[`AZURE_OPENAI_API_VERSION_${suffix}`] ??
    process.env.AZURE_OPENAI_API_VERSION ??
    "2025-01-01-preview";
  const deployment =
    process.env[`AZURE_OPENAI_DEPLOYMENT_${suffix}`] ??
    process.env.AZURE_OPENAI_DEPLOYMENT ??
    model.replace(/-/g, "");

  if (!endpoint) {
    throw new Error(
      `AZURE_OPENAI_ENDPOINT (or AZURE_OPENAI_ENDPOINT_${suffix}) is not set for model ${model}.`,
    );
  }
  if (!apiKey) {
    throw new Error(
      `AZURE_OPENAI_API_KEY (or AZURE_OPENAI_API_KEY_${suffix}) is not set for model ${model}.`,
    );
  }

  return { endpoint, apiKey, apiVersion, deployment };
}

export function getAzureClient(model?: AzureModelId): OpenAI {
  return getClient(model);
}

function getClient(model?: AzureModelId): OpenAI {
  const m = (model ?? DEFAULT_AZURE_MODEL) as AzureModelId;
  const { endpoint, apiKey, apiVersion, deployment } = resolveModelEndpoint(m);

  // Cache key combines endpoint + deployment so two models on the same
  // deployment name but different endpoints don't share a client.
  const cacheKey = `${endpoint.replace(/\/+$/, "")}|${deployment}`;
  const cached = _clientByDeployment.get(cacheKey);
  if (cached) return cached;

  const client = new OpenAI({
    apiKey,
    baseURL: `${endpoint.replace(/\/+$/, "")}/openai/deployments/${deployment}`,
    defaultQuery: { "api-version": apiVersion },
    defaultHeaders: { "api-key": apiKey },
  });
  _clientByDeployment.set(cacheKey, client);
  return client;
}

// ========== Error Handling & Retry ==========

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2_000;

function classifyAndThrow(err: unknown): never {
  if (err instanceof APIError) {
    if (err.status === 401) {
      throw new Error(
        "Azure OpenAI returned 401 Unauthorized. Your API key may be invalid or expired — " +
          "please rotate the key in AZURE_OPENAI_API_KEY and restart the server."
      );
    }
    if (err.status === 429) {
      throw new Error(
        "Azure OpenAI returned 429 Too Many Requests after all retries. " +
          "You are being rate-limited — reduce request frequency or upgrade your Azure quota."
      );
    }
  }
  throw err;
}

function isTransientError(err: unknown): boolean {
  if (err instanceof APIError) {
    return [429, 500, 502, 503, 504].includes(err.status ?? 0);
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return /econnreset|etimedout|socket hang up|network|fetch failed/.test(msg);
  }
  return false;
}

// ========== Global Rate Limiter ==========
// Azure OpenAI: 80k tokens/min, 800 requests/min
// Space out heavy calls to avoid 429 storms
let lastCallTimestamp = 0;
const MIN_CALL_INTERVAL_MS = 500; // 0.5s between calls (lightweight spacing)

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTimestamp;
  if (elapsed < MIN_CALL_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_INTERVAL_MS - elapsed));
  }
  lastCallTimestamp = Date.now();
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await rateLimitWait();
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || attempt === MAX_RETRIES) break;
      // Respect Retry-After header from Azure if available
      let delay = BASE_DELAY_MS * 2 ** attempt;
      if (err instanceof APIError && err.headers) {
        const retryAfter = err.headers?.["retry-after"];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed) && parsed > 0) delay = Math.max(delay, parsed * 1000);
        }
      }
      // For 429, enforce minimum 10s backoff
      if (err instanceof APIError && err.status === 429) {
        delay = Math.max(delay, 30_000);
      }
      console.warn(`[withRetry] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (waiting ${Math.round(delay/1000)}s):`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  classifyAndThrow(lastError);
}

/**
 * Shared retry wrapper for LLM calls in agents.
 * Retries up to 2 times on any error with exponential backoff.
 * If `critical` is false, returns undefined on final failure instead of throwing.
 */
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  opts: { stepName: string; critical?: boolean } = { stepName: "llm-call" },
): Promise<T | undefined> {
  const maxRetries = 4;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      let delay = 2000 * 2 ** attempt;
      // For 429, enforce minimum 10s backoff
      if (err instanceof Error && err.message.includes("429")) {
        delay = Math.max(delay, 30_000);
      }
      console.warn(`[withLLMRetry] ${opts.stepName} attempt ${attempt + 1}/${maxRetries + 1} failed (waiting ${Math.round(delay/1000)}s):`, err instanceof Error ? err.message : err);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  if (opts.critical !== false) {
    throw lastError;
  }
  console.warn(`[withLLMRetry] ${opts.stepName} failed after all retries, returning undefined (non-critical)`);
  return undefined;
}

// ========== Token Usage Tracking ==========

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Cumulative token counter — tracks usage across multiple calls within a session. */
export class TokenCounter {
  private _prompt = 0;
  private _completion = 0;

  add(usage: TokenUsage): void {
    this._prompt += usage.promptTokens;
    this._completion += usage.completionTokens;
  }

  get promptTokens(): number { return this._prompt; }
  get completionTokens(): number { return this._completion; }
  get totalTokens(): number { return this._prompt + this._completion; }

  /** Returns true if total tokens exceed the given budget. */
  exceeds(budget: number): boolean { return this.totalTokens > budget; }

  toJSON(): TokenUsage {
    return {
      promptTokens: this._prompt,
      completionTokens: this._completion,
      totalTokens: this.totalTokens,
    };
  }
}

// ========== LLM Usage Tracking ==========

export interface LLMTrackerContext {
  module: string;
  operation: string;
  projectId?: string;
  programId?: string;
  userId?: string;
  agentRunId?: string;
}

const PRICING: Record<string, { input: number; output: number }> = {
  // Per 1M tokens — keep in sync with Azure OpenAI price list.
  // gpt-55 pricing TBD by Microsoft; using gpt-54 numbers as a placeholder so
  // cost tracking doesn't silently zero out. Update when official pricing lands.
  'gpt-55': { input: 2.50, output: 15.00 },
  'gpt-54': { input: 2.50, output: 15.00 },
};

function computeCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICING[model] ?? PRICING['gpt-55']!;
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
}

/**
 * Fire-and-forget insert into llm_usage_log. Returns the log ID.
 */
export function logLLMUsage(params: {
  tracker: LLMTrackerContext;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs?: number;
  wasRetry?: boolean;
  wasError?: boolean;
  errorMessage?: string;
  outputChars?: number;
  outputItems?: number;
}): string {
  const id = crypto.randomUUID();
  const cost = computeCost(params.model, params.promptTokens, params.completionTokens);
  const db = getDb();
  db.insert(llmUsageLog).values({
    id,
    module: params.tracker.module,
    operation: params.tracker.operation,
    model: params.model,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    totalTokens: params.totalTokens,
    costUsd: cost.toFixed(6),
    outputChars: params.outputChars,
    outputItems: params.outputItems,
    wasRetry: params.wasRetry ?? false,
    wasError: params.wasError ?? false,
    errorMessage: params.errorMessage,
    projectId: params.tracker.projectId,
    programId: params.tracker.programId,
    userId: params.tracker.userId,
    agentRunId: params.tracker.agentRunId,
    latencyMs: params.latencyMs,
  }).catch(console.error);
  return id;
}

/**
 * Update efficiency data (output chars/items) for a previously logged LLM call.
 */
export function reportLLMOutput(logId: string, data: { outputChars?: number; outputItems?: number }): void {
  const db = getDb();
  db.update(llmUsageLog)
    .set({
      outputChars: data.outputChars,
      outputItems: data.outputItems,
    })
    .where(eq(llmUsageLog.id, logId))
    .catch(console.error);
}

// ========== Global Daily Token Budget ==========

const DAILY_TOKEN_BUDGET = 2_000_000; // 2M tokens/day default
const BUDGET_WARNING_THRESHOLD = 0.8; // warn at 80%
const BUDGET_HARD_LIMIT_FACTOR = 1.5; // throw error at 150%

interface TokenBudget {
  date: string; // YYYY-MM-DD
  totalTokens: number;
}

let currentBudget: TokenBudget = { date: "", totalTokens: 0 };

function checkAndUpdateBudget(tokensUsed: number): void {
  const today = new Date().toISOString().slice(0, 10);
  if (currentBudget.date !== today) {
    currentBudget = { date: today, totalTokens: 0 };
  }
  currentBudget.totalTokens += tokensUsed;

  if (currentBudget.totalTokens > DAILY_TOKEN_BUDGET * BUDGET_HARD_LIMIT_FACTOR) {
    throw new Error(
      `[azure-llm] Daily token budget hard limit exceeded: ${currentBudget.totalTokens}/${DAILY_TOKEN_BUDGET} (>${Math.round(BUDGET_HARD_LIMIT_FACTOR * 100)}%). Blocking further LLM calls to prevent runaway costs.`
    );
  } else if (currentBudget.totalTokens > DAILY_TOKEN_BUDGET) {
    console.warn(`[azure-llm] Daily token budget exceeded: ${currentBudget.totalTokens}/${DAILY_TOKEN_BUDGET}`);
  } else if (currentBudget.totalTokens > DAILY_TOKEN_BUDGET * BUDGET_WARNING_THRESHOLD) {
    console.warn(`[azure-llm] Token budget at ${Math.round(currentBudget.totalTokens / DAILY_TOKEN_BUDGET * 100)}%`);
  }
}

export function getTokenBudgetStatus(): { date: string; used: number; limit: number; percentage: number } {
  const today = new Date().toISOString().slice(0, 10);
  if (currentBudget.date !== today) return { date: today, used: 0, limit: DAILY_TOKEN_BUDGET, percentage: 0 };
  return {
    date: currentBudget.date,
    used: currentBudget.totalTokens,
    limit: DAILY_TOKEN_BUDGET,
    percentage: Math.round(currentBudget.totalTokens / DAILY_TOKEN_BUDGET * 100),
  };
}

// ========== Core API ==========

export const DEFAULT_MATH_SYSTEM_PROMPT = 'You are a mathematical research assistant for Mathub, a collaborative mathematics research platform. Follow instructions precisely and output valid JSON when requested.';

/**
 * Call Azure OpenAI to generate text.
 * If a `tokenCounter` is provided, usage from this call is accumulated into it.
 * If a `tracker` is provided, usage is logged to llm_usage_log (fire-and-forget).
 */
export async function callAzureLLM(
  prompt: string,
  options?: AzureLLMOptions & { systemPrompt?: string; tokenCounter?: TokenCounter; tracker?: LLMTrackerContext }
): Promise<string> {
  const model = options?.model ?? DEFAULT_AZURE_MODEL;
  const maxTokens = options?.maxTokens ?? 128000;

  const client = getClient(model);
  const timeout = options?.timeoutMs ?? 1_800_000;

  const startMs = Date.now();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = options?.systemPrompt
    ? [{ role: "system" as const, content: options.systemPrompt }, { role: "user" as const, content: prompt }]
    : [{ role: "user" as const, content: prompt }];

  // End-to-end timeout using Promise.race so the overall call is bounded even
  // if retries stack up. The per-request AbortSignal uses the same `timeout`
  // — previously capped at 120_000ms, which silently aborted large-prompt
  // calls (spine node extraction passes 600_000ms) mid-response regardless
  // of what the caller asked for. Trust the caller's timeoutMs.
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`callAzureLLM timed out after ${timeout}ms`)), timeout)
  );
  const completionPromise = withRetry(() =>
    client.chat.completions.create(
      {
        model,
        messages,
        max_completion_tokens: maxTokens,
      },
      { signal: AbortSignal.timeout(timeout) },
    )
  );
  const completion = await Promise.race([completionPromise, timeoutPromise]);
  const latencyMs = Date.now() - startMs;

  const text = completion.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("Azure OpenAI returned an empty response");
  }

  // Track global daily token budget
  if (completion.usage) {
    checkAndUpdateBudget(completion.usage.total_tokens ?? 0);
  }

  // Track token usage
  if (options?.tokenCounter && completion.usage) {
    options.tokenCounter.add({
      promptTokens: completion.usage.prompt_tokens ?? 0,
      completionTokens: completion.usage.completion_tokens ?? 0,
      totalTokens: completion.usage.total_tokens ?? 0,
    });
  }

  // Log to llm_usage_log
  if (options?.tracker && completion.usage) {
    logLLMUsage({
      tracker: options.tracker,
      model,
      promptTokens: completion.usage.prompt_tokens ?? 0,
      completionTokens: completion.usage.completion_tokens ?? 0,
      totalTokens: completion.usage.total_tokens ?? 0,
      latencyMs,
      outputChars: text.length,
    });
  }

  return text;
}

/**
 * Stream text from Azure OpenAI.
 * If a `tracker` is provided, usage is logged after stream completes.
 */
export async function* streamAzureLLM(
  prompt: string,
  options?: AzureLLMOptions & { systemPrompt?: string; tracker?: LLMTrackerContext }
): AsyncIterable<string> {
  const model = (options?.model as AzureModelId) ?? DEFAULT_AZURE_MODEL;
  const maxTokens = options?.maxTokens ?? 128000;
  const client = getClient(model);

  const timeout = options?.timeoutMs ?? 1_800_000;

  const startMs = Date.now();
  const streamMessages: OpenAI.Chat.ChatCompletionMessageParam[] = options?.systemPrompt
    ? [{ role: "system" as const, content: options.systemPrompt }, { role: "user" as const, content: prompt }]
    : [{ role: "user" as const, content: prompt }];
  const stream = await withRetry(() =>
    client.chat.completions.create(
      {
        model,
        messages: streamMessages,
        max_completion_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: AbortSignal.timeout(timeout) },
    )
  );

  let totalChars = 0;
  let finalUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      totalChars += delta.length;
      yield delta;
    }
    if (chunk.usage) {
      finalUsage = chunk.usage;
    }
  }

  // Log usage after stream completes
  if (options?.tracker && finalUsage) {
    const latencyMs = Date.now() - startMs;
    logLLMUsage({
      tracker: options.tracker,
      model,
      promptTokens: finalUsage.prompt_tokens ?? 0,
      completionTokens: finalUsage.completion_tokens ?? 0,
      totalTokens: finalUsage.total_tokens ?? 0,
      latencyMs,
      outputChars: totalChars,
    });
  }
}

/**
 * Sanitize LLM-generated JSON that may contain illegal escape sequences
 * (e.g. \partial \int \upsilon from LaTeX) or control characters.
 *
 * `extractJSON` applies this automatically, so every `JSON.parse(extractJSON(raw))`
 * call site in the agent pipeline benefits without further changes. Previously
 * two hand-maintained copies lived in shared/build-efforts.ts and
 * spine/spine-builder.ts and silently drifted (the spine copy let any `\u…`
 * through, not just `\uXXXX`, crashing JSON.parse on tokens like `\upsilon`).
 */
export function sanitizeLLMJson(json: string): string {
  // Consume backslash sequences as single units so we don't double-escape a
  // `\` that's already part of a valid escape. A naive replace like
  // `/\\(?!…)/` scans char-by-char and, for already-valid input like
  // `"\\leq"` (4 chars \\ + leq), incorrectly rewrites the second `\` into
  // `\\` → `\\\\leq` → JSON.parse yields two backslashes instead of one.
  // Matching order: valid two-char / six-char escapes first, then bare `\X`.
  const sanitized = json.replace(
    /\\\\|\\["/bfnrt]|\\u[0-9a-fA-F]{4}|\\./g,
    (match) => (match.length === 2 && !/^\\["/bfnrt\\]$/.test(match) ? "\\" + match : match),
  );
  // Strip control characters that are not valid inside JSON string literals.
  // Keep \n (\x0A), \r (\x0D), \t (\x09) — those are valid.
  return sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/**
 * Extract JSON object from LLM response text.
 * Handles: raw JSON, markdown code blocks, text around JSON.
 * Also runs `sanitizeLLMJson` on the extracted payload so downstream
 * `JSON.parse` calls don't choke on LaTeX escapes.
 */
export function extractJSON(text: string): string {
  // Try markdown code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    return sanitizeLLMJson(codeBlockMatch[1]!.trim());
  }

  // Try to find a JSON object or array (match outermost braces/brackets, skip string contents)
  // Try array first if text contains [ before {
  const firstBracket = text.indexOf("[");
  const firstBrace = text.indexOf("{");
  const tryOrder: Array<[string, string]> = (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace))
    ? [["[", "]"], ["{", "}"]]
    : [["{", "}"], ["[", "]"]];
  for (const [open, close] of tryOrder) {
    let depth = 0;
    let start = -1;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") {
          i++; // skip escaped character
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"' && depth > 0) {
        inString = true;
      } else if (ch === open) {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0 && start !== -1) {
          return sanitizeLLMJson(text.slice(start, i + 1));
        }
      }
    }
  }

  return sanitizeLLMJson(text.trim());
}
