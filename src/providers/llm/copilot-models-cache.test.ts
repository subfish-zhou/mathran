/**
 * Tests for copilot-models-cache — TODO-2 §9.1 / C7.
 *
 * Covers:
 *   - hardcoded fallback returns real /models values (snapshot 2026-06-24)
 *   - unknown model returns 200K default
 *   - provider prefix stripped before lookup
 *   - live cache override of hardcoded
 *   - live cache TTL (stale → fall back to hardcoded)
 *   - refreshCopilotModelsCacheFromResponse handles missing/malformed data
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  contextWindowForModel,
  maxOutputTokensForModel,
  refreshCopilotModelsCacheFromResponse,
  _resetCopilotModelsCacheForTest,
  _peekCopilotModelsCacheForTest,
} from "./copilot-models-cache.js";

beforeEach(() => {
  _resetCopilotModelsCacheForTest();
});

describe("contextWindowForModel — hardcoded fallback", () => {
  it("returns real cap from snapshot for known models", () => {
    expect(contextWindowForModel("gpt-5.5")).toBe(922_000);
    expect(contextWindowForModel("gpt-5-mini")).toBe(128_000);
    expect(contextWindowForModel("gpt-4o")).toBe(64_000);
    expect(contextWindowForModel("gpt-4o-mini")).toBe(12_288);
    expect(contextWindowForModel("gpt-4.1")).toBe(128_000);
    expect(contextWindowForModel("claude-opus-4.7")).toBe(936_000);
    expect(contextWindowForModel("claude-opus-4.5")).toBe(168_000);
    expect(contextWindowForModel("claude-sonnet-4.6")).toBe(936_000);
  });

  it("strips provider prefix before lookup", () => {
    expect(contextWindowForModel("copilot/gpt-5.5")).toBe(922_000);
    expect(contextWindowForModel("openrouter/claude-opus-4.7")).toBe(936_000);
    expect(contextWindowForModel("anything/gpt-4o-mini")).toBe(12_288);
  });

  it("returns 200K default for unknown models", () => {
    expect(contextWindowForModel("unknown-model-xyz")).toBe(200_000);
    expect(contextWindowForModel("copilot/never-shipped")).toBe(200_000);
  });
});

describe("maxOutputTokensForModel — hardcoded fallback", () => {
  it("returns real output cap from snapshot", () => {
    expect(maxOutputTokensForModel("gpt-5.5")).toBe(128_000);
    expect(maxOutputTokensForModel("gpt-4o")).toBe(16_384);
    expect(maxOutputTokensForModel("claude-opus-4.7")).toBe(64_000);
  });

  it("returns 4096 default for unknown models", () => {
    expect(maxOutputTokensForModel("unknown-model")).toBe(4_096);
  });
});

describe("refreshCopilotModelsCacheFromResponse — live cache", () => {
  it("populates live cache from a well-formed /models response", () => {
    refreshCopilotModelsCacheFromResponse({
      data: [
        { id: "gpt-5.5", capabilities: { limits: { max_prompt_tokens: 999_000, max_output_tokens: 200_000 } } },
        { id: "new-model", capabilities: { limits: { max_prompt_tokens: 500_000, max_output_tokens: 80_000 } } },
      ],
    });
    const peek = _peekCopilotModelsCacheForTest();
    expect(peek).not.toBeNull();
    expect(peek!["gpt-5.5"].contextWindow).toBe(999_000);
    expect(peek!["new-model"].contextWindow).toBe(500_000);
  });

  it("live cache overrides hardcoded fallback", () => {
    expect(contextWindowForModel("gpt-5.5")).toBe(922_000); // hardcoded
    refreshCopilotModelsCacheFromResponse({
      data: [
        { id: "gpt-5.5", capabilities: { limits: { max_prompt_tokens: 1_500_000, max_output_tokens: 200_000 } } },
      ],
    });
    expect(contextWindowForModel("gpt-5.5")).toBe(1_500_000); // live cache wins
  });

  it("live cache unknown model still falls through to hardcoded for OTHER known models", () => {
    refreshCopilotModelsCacheFromResponse({
      data: [
        { id: "gpt-5.5", capabilities: { limits: { max_prompt_tokens: 999_000, max_output_tokens: 200_000 } } },
        // intentionally no gpt-4o here
      ],
    });
    expect(contextWindowForModel("gpt-5.5")).toBe(999_000); // live cache
    expect(contextWindowForModel("gpt-4o")).toBe(64_000);   // hardcoded fallback
  });

  it("rejects malformed responses silently (no cache populated)", () => {
    refreshCopilotModelsCacheFromResponse(null);
    expect(_peekCopilotModelsCacheForTest()).toBeNull();

    refreshCopilotModelsCacheFromResponse({ data: "not-an-array" });
    expect(_peekCopilotModelsCacheForTest()).toBeNull();

    refreshCopilotModelsCacheFromResponse({ data: [{ id: "x" }] }); // no capabilities/limits
    expect(_peekCopilotModelsCacheForTest()).toBeNull();
  });

  it("missing max_output_tokens defaults to 4096", () => {
    refreshCopilotModelsCacheFromResponse({
      data: [
        { id: "weird-model", capabilities: { limits: { max_prompt_tokens: 100_000 } } },
      ],
    });
    expect(maxOutputTokensForModel("weird-model")).toBe(4_096);
  });

  it("live cache expires after TTL — peek returns null when stale", () => {
    // Populate live cache
    refreshCopilotModelsCacheFromResponse({
      data: [{ id: "x", capabilities: { limits: { max_prompt_tokens: 999, max_output_tokens: 99 } } }],
    });
    expect(_peekCopilotModelsCacheForTest()).not.toBeNull();

    // Fast-forward time past TTL using vitest fake timers
    const realNow = Date.now;
    const stub = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31 * 60 * 1000);
    try {
      expect(_peekCopilotModelsCacheForTest()).toBeNull(); // stale
      // contextWindowForModel falls back to hardcoded / default
      expect(contextWindowForModel("x")).toBe(200_000); // not in hardcoded → default
    } finally {
      stub.mockRestore();
    }
  });
});
