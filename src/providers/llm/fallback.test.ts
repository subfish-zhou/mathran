/**
 * Tests for FallbackLLMProvider — NEW-F3.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMMessage,
} from "../../core/providers/llm.js";
import {
  FallbackLLMProvider,
  isTransientLlmError,
  wrapWithFallback,
} from "./fallback.js";

// Minimal fake provider that yields the given chunks or throws on chat.
function fakeProvider(
  name: string,
  behaviour:
    | { kind: "stream"; chunks: LLMStreamChunk[] }
    | { kind: "chat-throws"; error: Error }
    | { kind: "stream-throws"; error: Error },
): LLMProvider {
  return {
    async describe() {
      return { name };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      if (behaviour.kind === "chat-throws") throw behaviour.error;
      return {
        stream(): AsyncIterable<LLMStreamChunk> {
          if (behaviour.kind === "stream-throws") {
            return (async function* () {
              throw behaviour.error;
            })();
          }
          return (async function* () {
            for (const c of behaviour.chunks) yield c;
          })();
        },
      };
    },
    countTokens(_m: LLMMessage[]) {
      return 1;
    },
  };
}

const req: LLMRequest = { messages: [{ role: "user", content: "hi" }], model: "test-model" };

const doneChunk: LLMStreamChunk = { type: "done", finishReason: "stop" };
const textChunk = (s: string): LLMStreamChunk => ({ type: "text", delta: s });

async function collect(res: LLMResponse): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const c of res.stream()) out.push(c);
  return out;
}

describe("isTransientLlmError", () => {
  it("classifies network errors as transient", () => {
    expect(isTransientLlmError(new Error("fetch failed"))).toBe(true);
    expect(isTransientLlmError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientLlmError(new Error("ETIMEDOUT reading"))).toBe(true);
    expect(isTransientLlmError(new Error("getaddrinfo ENOTFOUND"))).toBe(true);
  });

  it("classifies 5xx + 429 + 408 as transient", () => {
    expect(isTransientLlmError(new Error("HTTP 502"))).toBe(true);
    expect(isTransientLlmError(new Error("HTTP 503"))).toBe(true);
    expect(isTransientLlmError(new Error("HTTP 429"))).toBe(true);
    expect(isTransientLlmError(new Error("status: 408"))).toBe(true);
  });

  it("classifies 401 / unauthorized / token expired as transient", () => {
    expect(isTransientLlmError(new Error("HTTP 401"))).toBe(true);
    expect(isTransientLlmError(new Error("unauthorized"))).toBe(true);
    expect(isTransientLlmError(new Error("token expired"))).toBe(true);
  });

  it("classifies rate limit / quota wording as transient", () => {
    expect(isTransientLlmError(new Error("rate limit reached"))).toBe(true);
    expect(isTransientLlmError(new Error("Too many requests"))).toBe(true);
    expect(isTransientLlmError(new Error("quota exceeded"))).toBe(true);
  });

  it("does NOT classify 4xx model semantics as transient", () => {
    expect(isTransientLlmError(new Error("HTTP 400 invalid model"))).toBe(false);
    expect(isTransientLlmError(new Error("HTTP 403 forbidden"))).toBe(false);
    expect(isTransientLlmError(new Error("HTTP 404 not found"))).toBe(false);
    expect(isTransientLlmError(new Error("HTTP 422 unprocessable"))).toBe(false);
  });

  it("does NOT classify JSON / schema parse errors as transient", () => {
    expect(isTransientLlmError(new Error("Unexpected token < in JSON"))).toBe(false);
    expect(isTransientLlmError(new Error("schema validation failed"))).toBe(false);
  });

  it("returns false for null / undefined", () => {
    expect(isTransientLlmError(null)).toBe(false);
    expect(isTransientLlmError(undefined)).toBe(false);
  });
});

describe("FallbackLLMProvider", () => {
  it("uses primary when it succeeds", async () => {
    const primary = fakeProvider("primary", { kind: "stream", chunks: [textChunk("hi"), doneChunk] });
    const fallback = fakeProvider("fallback", { kind: "chat-throws", error: new Error("should not be hit") });
    const fp = new FallbackLLMProvider(primary, [{ label: "fallback", provider: fallback }]);
    const res = await fp.chat(req);
    const chunks = await collect(res);
    expect(chunks).toEqual([textChunk("hi"), doneChunk]);
  });

  it("falls back when primary throws transient (chat() phase)", async () => {
    const primary = fakeProvider("primary", { kind: "chat-throws", error: new Error("HTTP 502 bad gateway") });
    const fallback = fakeProvider("fallback", { kind: "stream", chunks: [textChunk("from-fb"), doneChunk] });
    const onFallback = vi.fn();
    const fp = wrapWithFallback(primary, [{ label: "fallback", provider: fallback }], { onFallback });
    const res = await fp.chat(req);
    const chunks = await collect(res);
    expect(chunks).toEqual([textChunk("from-fb"), doneChunk]);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback.mock.calls[0][0].from).toBe("primary");
    expect(onFallback.mock.calls[0][0].to).toBe("fallback");
  });

  it("falls back when primary throws transient at stream-peek phase", async () => {
    const primary = fakeProvider("primary", { kind: "stream-throws", error: new Error("ECONNRESET") });
    const fallback = fakeProvider("fallback", { kind: "stream", chunks: [textChunk("from-fb"), doneChunk] });
    const fp = new FallbackLLMProvider(primary, [{ label: "fallback", provider: fallback }]);
    const res = await fp.chat(req);
    const chunks = await collect(res);
    expect(chunks).toEqual([textChunk("from-fb"), doneChunk]);
  });

  it("does NOT fall back on non-transient errors", async () => {
    const primary = fakeProvider("primary", {
      kind: "chat-throws",
      error: new Error("HTTP 400 invalid model name"),
    });
    const fallback = fakeProvider("fallback", { kind: "stream", chunks: [textChunk("nope"), doneChunk] });
    const fp = new FallbackLLMProvider(primary, [{ label: "fallback", provider: fallback }]);
    await expect(fp.chat(req)).rejects.toThrow(/HTTP 400/);
  });

  it("walks a multi-step chain (primary → fb1 transient → fb2 success)", async () => {
    const primary = fakeProvider("primary", { kind: "chat-throws", error: new Error("HTTP 503") });
    const fb1 = fakeProvider("fb1", { kind: "chat-throws", error: new Error("rate limit") });
    const fb2 = fakeProvider("fb2", { kind: "stream", chunks: [textChunk("final"), doneChunk] });
    const fp = new FallbackLLMProvider(primary, [
      { label: "fb1", provider: fb1 },
      { label: "fb2", provider: fb2 },
    ]);
    const res = await fp.chat(req);
    const chunks = await collect(res);
    expect(chunks).toEqual([textChunk("final"), doneChunk]);
  });

  it("throws chain-aware error when ALL providers fail transiently", async () => {
    const primary = fakeProvider("primary", { kind: "chat-throws", error: new Error("HTTP 503 a") });
    const fb1 = fakeProvider("fb1", { kind: "chat-throws", error: new Error("HTTP 502 b") });
    const fp = new FallbackLLMProvider(primary, [{ label: "fb1", provider: fb1 }]);
    await expect(fp.chat(req)).rejects.toThrow(/fallback chain exhausted/);
  });

  it("does NOT re-stream after primary emits a chunk and then crashes mid-stream", async () => {
    // Primary yields one good chunk then throws — we must not replay.
    const flaky: LLMProvider = {
      async describe() { return { name: "flaky" }; },
      async chat(): Promise<LLMResponse> {
        return {
          stream(): AsyncIterable<LLMStreamChunk> {
            return (async function* () {
              yield textChunk("partial");
              throw new Error("ECONNRESET mid-stream");
            })();
          },
        };
      },
    };
    const fb = fakeProvider("fb", { kind: "stream", chunks: [textChunk("would-double"), doneChunk] });
    const fp = new FallbackLLMProvider(flaky, [{ label: "fb", provider: fb }]);
    const chunks: LLMStreamChunk[] = [];
    let thrown: unknown = null;
    try {
      const res = await fp.chat(req);
      for await (const c of res.stream()) chunks.push(c);
    } catch (e) {
      thrown = e;
    }
    expect(chunks).toEqual([textChunk("partial")]);
    expect(String((thrown as Error).message)).toMatch(/ECONNRESET/);
  });

  it("countTokens delegates to primary", () => {
    const primary = fakeProvider("primary", { kind: "stream", chunks: [doneChunk] });
    const fp = new FallbackLLMProvider(primary, []);
    expect(fp.countTokens([{ role: "user", content: "hi" }])).toBe(1);
  });

  it("describe() delegates to primary", async () => {
    const primary = fakeProvider("primary-named", { kind: "stream", chunks: [doneChunk] });
    const fp = new FallbackLLMProvider(primary, []);
    expect((await fp.describe()).name).toBe("primary-named");
  });
});
