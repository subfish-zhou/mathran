/**
 * Copilot models cache — TODO-2 §5.6 / C7.
 *
 * Resolves the *real* per-model context window for copilot-served models
 * by querying the `/models` endpoint at copilot session-token refresh
 * time. Mathran previously hard-coded gpt-4o/gpt-5 to 128_000 in
 * src/server/serve.ts:1448, which is wrong both ways:
 *   - gpt-4o ACTUAL: 64,000 (mathran overestimated 2x → would overflow)
 *   - gpt-4o-mini ACTUAL: 12,288 (overestimated 10x → would overflow fast)
 *   - gpt-5.5 ACTUAL: 922,000 (underestimated 7.2x → wasted capacity)
 *   - claude-opus-4.7/4.8 ACTUAL: 936,000 (no mapping at all → fall through to 200K)
 *
 * Resolution order in contextWindowForModel():
 *   1. Live cache from /models (TTL = 30 min, same as session token).
 *   2. Hardcoded fallback table (snapshot 2026-06-24).
 *   3. 200_000 default for unknown models (sensible mid-range default).
 *
 * The cache is best-effort — every failure (network error, parse error,
 * non-200 status) is swallowed and we fall back to the hardcoded table.
 * This keeps mathran responsive even when copilot is degraded.
 */

const HARDCODED_FALLBACK: Record<string, { contextWindow: number; maxOutput: number }> = {
  // === gpt-5 family ===
  "gpt-5.5":               { contextWindow: 922_000, maxOutput: 128_000 },
  // 2026-06-29 — Mathub's Azure GPT-5.5 deployment is exposed as bare
  // model name `gpt55` (no dot). We cap mathran's view of it at 256K
  // even though the deployment's raw cap is 922K (verified via probe),
  // because subfish wants compaction to trigger at 256K active context
  // — past that the recall quality of GPT-5.5 drops noticeably and the
  // OpenAI 272K soft-cap also kicks in 2x input / 1.5x output pricing.
  // Setting contextWindow=256K + autoCompact threshold at 100% of cap
  // (codex-style absolute threshold) means "compact when active ctx
  // hits 256K" — which is what we want.
  "gpt55":                 { contextWindow: 256_000, maxOutput: 128_000 },
  "gpt-5.4":               { contextWindow: 922_000, maxOutput: 128_000 },
  "gpt-5.4-mini":          { contextWindow: 272_000, maxOutput: 128_000 },
  "gpt-5.3-codex":         { contextWindow: 272_000, maxOutput: 128_000 },
  "gpt-5-mini":            { contextWindow: 128_000, maxOutput: 64_000 },
  // === gpt-4 family ===
  "gpt-4.1":               { contextWindow: 128_000, maxOutput: 16_384 },
  "gpt-4.1-2025-04-14":    { contextWindow: 128_000, maxOutput: 16_384 },
  "gpt-4o":                { contextWindow:  64_000, maxOutput: 16_384 },
  "gpt-4o-2024-05-13":     { contextWindow:  64_000, maxOutput:  4_096 },
  "gpt-4o-2024-08-06":     { contextWindow:  64_000, maxOutput: 16_384 },
  "gpt-4o-2024-11-20":     { contextWindow:  64_000, maxOutput: 16_384 },
  "gpt-4o-mini":           { contextWindow:  12_288, maxOutput:  4_096 },
  "gpt-4o-mini-2024-07-18":{ contextWindow:  12_288, maxOutput:  4_096 },
  // === claude family ===
  "claude-opus-4.5":       { contextWindow: 168_000, maxOutput: 32_000 },
  "claude-opus-4.6":       { contextWindow: 936_000, maxOutput: 64_000 },
  "claude-opus-4.7":       { contextWindow: 936_000, maxOutput: 64_000 },
  "claude-opus-4.8":       { contextWindow: 936_000, maxOutput: 64_000 },
  "claude-sonnet-4.5":     { contextWindow: 168_000, maxOutput: 32_000 },
  "claude-sonnet-4.6":     { contextWindow: 936_000, maxOutput: 64_000 },
  // === gemini family ===
  "gemini-2.5-pro":        { contextWindow: 128_000, maxOutput: 64_000 },
  "gemini-3-flash-preview":{ contextWindow: 128_000, maxOutput: 64_000 },
  "gemini-3.1-pro-preview":{ contextWindow: 936_000, maxOutput: 64_000 },
  "gemini-3.5-flash":      { contextWindow: 936_000, maxOutput: 64_000 },
};

const DEFAULT_CONTEXT_WINDOW_UNKNOWN_MODEL = 200_000;
const LIVE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — matches copilot session token TTL

let _liveCache: Record<string, { contextWindow: number; maxOutput: number }> | null = null;
let _liveCacheAt = 0;

/**
 * Try to refresh `_liveCache` from a copilot `/models` endpoint response.
 * Best-effort — on any error returns silently so callers fall through
 * to HARDCODED_FALLBACK. Called from the copilot token resolver each
 * time the session token is refreshed (so cache stays roughly in sync
 * with the token lifecycle: 30 min TTL).
 *
 * `responseBody` is the parsed JSON from `GET ${baseUrl}/models`.
 * Caller is responsible for the fetch + JSON parse; this function only
 * extracts the model→limits mapping.
 */
export function refreshCopilotModelsCacheFromResponse(
  responseBody: unknown,
): void {
  try {
    const body = responseBody as {
      data?: Array<{
        id?: string;
        capabilities?: {
          limits?: {
            max_prompt_tokens?: number;
            max_output_tokens?: number;
          };
        };
      }>;
    };
    if (!body || !Array.isArray(body.data)) return;
    const next: Record<string, { contextWindow: number; maxOutput: number }> = {};
    for (const m of body.data) {
      const id = m.id;
      const limits = m.capabilities?.limits;
      if (!id || typeof limits?.max_prompt_tokens !== "number") continue;
      next[id] = {
        contextWindow: limits.max_prompt_tokens,
        maxOutput: typeof limits.max_output_tokens === "number" ? limits.max_output_tokens : 4_096,
      };
    }
    if (Object.keys(next).length > 0) {
      _liveCache = next;
      _liveCacheAt = Date.now();
    }
  } catch {
    // silent — fallback to hardcoded
  }
}

/**
 * Fetch /models from a copilot baseUrl, parse it, and refresh the cache.
 * Best-effort: returns true on success, false on any failure.
 * Caller (copilot.ts) invokes this once per session token refresh.
 */
export async function refreshCopilotModelsCacheFromBaseUrl(
  baseUrl: string,
  token: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Editor-Version": "vscode/1.107.0",
        "Copilot-Integration-Id": "vscode-chat",
      },
    });
    if (!res.ok) return false;
    const body = await res.json();
    refreshCopilotModelsCacheFromResponse(body);
    return _liveCache !== null && Object.keys(_liveCache).length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a model's effective context window. Resolution order:
 *   1. live cache (if not stale)
 *   2. hardcoded fallback table
 *   3. DEFAULT_CONTEXT_WINDOW_UNKNOWN_MODEL (200K)
 *
 * `model` may include a provider prefix (e.g. "copilot/gpt-5.5",
 * "anthropic/claude-opus-4.7"). The prefix is stripped before lookup.
 */
export function contextWindowForModel(model: string): number {
  const bare = stripProviderPrefix(model);
  if (_liveCache && Date.now() - _liveCacheAt < LIVE_CACHE_TTL_MS) {
    const v = _liveCache[bare];
    if (v) return v.contextWindow;
  }
  const fb = HARDCODED_FALLBACK[bare];
  if (fb) return fb.contextWindow;
  return DEFAULT_CONTEXT_WINDOW_UNKNOWN_MODEL;
}

/**
 * Same as contextWindowForModel but returns the max output tokens.
 * Useful for clamping `maxTokens` on LLM requests.
 */
export function maxOutputTokensForModel(model: string): number {
  const bare = stripProviderPrefix(model);
  if (_liveCache && Date.now() - _liveCacheAt < LIVE_CACHE_TTL_MS) {
    const v = _liveCache[bare];
    if (v) return v.maxOutput;
  }
  const fb = HARDCODED_FALLBACK[bare];
  if (fb) return fb.maxOutput;
  return 4_096;
}

function stripProviderPrefix(model: string): string {
  const idx = model.indexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/** Test-only: clear the live cache. */
export function _resetCopilotModelsCacheForTest(): void {
  _liveCache = null;
  _liveCacheAt = 0;
}

/** Test-only: inspect the live cache (returns null when stale). */
export function _peekCopilotModelsCacheForTest(): Record<string, { contextWindow: number; maxOutput: number }> | null {
  if (!_liveCache) return null;
  if (Date.now() - _liveCacheAt >= LIVE_CACHE_TTL_MS) return null;
  return { ..._liveCache };
}

/**
 * The hardcoded fallback model-name list — used by `/api/copilot/models`
 * when the live cache is cold and we couldn't warm it (offline / copilot
 * down / no token). Exposed as a separate named export so the server can
 * surface "we don't know what models you actually have, here's our best
 * snapshot" without exposing the contextWindow / maxOutput numbers.
 */
export const HARDCODED_FALLBACK_MODEL_NAMES: readonly string[] = Object.freeze(
  Object.keys(HARDCODED_FALLBACK).sort(),
);
