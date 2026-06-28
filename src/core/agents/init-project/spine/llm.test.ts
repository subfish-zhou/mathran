/**
 * Tests for spine/llm.ts retry + transient-error classification (fix #1).
 *
 * Focus: bounded retry on transient HTTP / network errors, immediate
 * surrender on hard-fail 4xx, exponential backoff timing.
 */

import { describe, it, expect, vi } from "vitest";
import { isTransientLLMError, callLLMWithRetry, type SpineLLM } from "./llm.js";

describe("isTransientLLMError", () => {
  it.each([
    "Copilot https://api.enterprise.githubcopilot.com/responses: HTTP 502 <!DOCTYPE html>",
    "openai: HTTP 503 service unavailable",
    "anthropic: HTTP 429 too many requests",
    "anthropic: HTTP 408 request timeout",
    "openai: HTTP 500 internal server error",
    "fetch failed",
    "ECONNRESET",
    "ETIMEDOUT during stream",
    "socket hang up",
    "Provider temporarily unavailable",
    "rate-limit exceeded",
    "stream aborted mid-flight",
    "model is overloaded right now",
  ])("classifies %s as transient", (msg) => {
    expect(isTransientLLMError(new Error(msg))).toBe(true);
  });

  it.each([
    "HTTP 400 bad request",
    "HTTP 401 unauthorized",
    "HTTP 403 forbidden",
    "HTTP 404 model not found",
    "invalid prompt format",
    "max_tokens must be a positive integer",
    "tool call malformed",
  ])("classifies %s as non-transient", (msg) => {
    expect(isTransientLLMError(new Error(msg))).toBe(false);
  });

  it("handles non-Error values without throwing", () => {
    expect(isTransientLLMError("HTTP 502 gateway")).toBe(true);
    expect(isTransientLLMError({ message: "HTTP 502" })).toBe(false); // not stringifying object
    expect(isTransientLLMError(null)).toBe(false);
  });
});

describe("callLLMWithRetry", () => {
  it("returns the result on the first successful call", async () => {
    const llm: SpineLLM = vi.fn().mockResolvedValue("ok");
    const out = await callLLMWithRetry(llm, "prompt");
    expect(out).toBe("ok");
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("retries on transient errors up to maxAttempts, then succeeds", async () => {
    let n = 0;
    const llm: SpineLLM = vi.fn().mockImplementation(async () => {
      n++;
      if (n < 3) throw new Error("Copilot HTTP 502 <html>...");
      return "recovered";
    });
    const logs: string[] = [];
    const out = await callLLMWithRetry(llm, "p", {}, { initialBackoffMs: 1, log: (m) => logs.push(m) });
    expect(out).toBe("recovered");
    expect(llm).toHaveBeenCalledTimes(3);
    expect(logs.length).toBe(2); // 2 retry log lines (attempts 1 and 2 logged before backoff)
    expect(logs[0]).toMatch(/attempt 1\/3/);
    expect(logs[1]).toMatch(/attempt 2\/3/);
  });

  it("throws on non-transient error WITHOUT retrying", async () => {
    const llm: SpineLLM = vi.fn().mockRejectedValue(new Error("HTTP 400 malformed prompt"));
    await expect(callLLMWithRetry(llm, "p", {}, { initialBackoffMs: 1 })).rejects.toThrow("HTTP 400");
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("throws the LAST transient error after exhausting maxAttempts", async () => {
    const llm: SpineLLM = vi.fn().mockRejectedValue(new Error("HTTP 502 third strike"));
    await expect(
      callLLMWithRetry(llm, "p", {}, { initialBackoffMs: 1, maxAttempts: 3 }),
    ).rejects.toThrow("HTTP 502 third strike");
    expect(llm).toHaveBeenCalledTimes(3);
  });

  it("honours custom maxAttempts", async () => {
    const llm: SpineLLM = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      callLLMWithRetry(llm, "p", {}, { initialBackoffMs: 1, maxAttempts: 5 }),
    ).rejects.toThrow();
    expect(llm).toHaveBeenCalledTimes(5);
  });

  it("uses exponential backoff between retries", async () => {
    let calls: number[] = [];
    const start = Date.now();
    let n = 0;
    const llm: SpineLLM = vi.fn().mockImplementation(async () => {
      calls.push(Date.now() - start);
      n++;
      if (n < 3) throw new Error("HTTP 503 service unavailable");
      return "ok";
    });
    await callLLMWithRetry(llm, "p", {}, { initialBackoffMs: 50 });
    // call 0 immediate, call 1 ~50ms later, call 2 ~150ms (50 + 100) later.
    expect(calls[0]).toBeLessThan(20);
    expect(calls[1]).toBeGreaterThanOrEqual(40);
    expect(calls[2]).toBeGreaterThanOrEqual(140);
  });

  it("forwards llmOpts (temperature, maxTokens) to the underlying LLM", async () => {
    const llm: SpineLLM = vi.fn().mockResolvedValue("ok");
    await callLLMWithRetry(llm, "prompt", { temperature: 0.7, maxTokens: 1234 });
    expect(llm).toHaveBeenCalledWith("prompt", { temperature: 0.7, maxTokens: 1234 });
  });
});
