import { describe, it, expect } from "vitest";
import {
  createOpenAITokenCounter,
  createAnthropicTokenCounter,
  createFallbackTokenCounter,
} from "./token-counter.js";
import type { LLMMessage } from "../providers/llm.js";

describe("createOpenAITokenCounter (o200k)", () => {
  const counter = createOpenAITokenCounter("gpt-5");

  it("counts a short string with envelope overhead", () => {
    const msg: LLMMessage = { role: "user", content: "Hello, world!" };
    const n = counter.countMessage(msg);
    // "Hello, world!" tokenizes to a small number (3-4 in o200k); +4 envelope.
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(12);
  });

  it("returns envelope-only for empty content", () => {
    const msg: LLMMessage = { role: "user", content: "" };
    expect(counter.countMessage(msg)).toBe(4); // PER_MESSAGE_OVERHEAD
  });

  it("includes tool_calls in count", () => {
    const plain: LLMMessage = { role: "assistant", content: "ok" };
    const withTools: LLMMessage = {
      role: "assistant",
      content: "ok",
      toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"/etc/hosts"}' }],
    };
    expect(counter.countMessage(withTools)).toBeGreaterThan(counter.countMessage(plain));
  });

  it("countMessages adds request-level overhead", () => {
    const msgs: LLMMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const sum = counter.countMessage(msgs[0]) + counter.countMessage(msgs[1]);
    expect(counter.countMessages(msgs)).toBeGreaterThan(sum);
  });

  it("handles long content without crashing", () => {
    const long = "x ".repeat(5000); // ~10KB
    const n = counter.countMessage({ role: "user", content: long });
    expect(n).toBeGreaterThan(1000);
  });

  it("returns 0 for empty message array", () => {
    expect(counter.countMessages([])).toBe(0);
  });
});

describe("createAnthropicTokenCounter", () => {
  const counter = createAnthropicTokenCounter();

  it("approximates ceil(length/3.5*1.2) plus envelope", () => {
    const msg: LLMMessage = { role: "user", content: "Hello, world!" };
    const expected = Math.ceil((13 / 3.5) * 1.2) + 4; // 14 + 4 = 18-ish
    expect(counter.countMessage(msg)).toBe(expected);
  });

  it("countMessages sums + request overhead", () => {
    const msgs: LLMMessage[] = [{ role: "user", content: "a" }];
    expect(counter.countMessages(msgs)).toBe(counter.countMessage(msgs[0]) + 3);
  });
});

describe("createFallbackTokenCounter", () => {
  const counter = createFallbackTokenCounter();

  it("uses chars/4 + envelope", () => {
    const msg: LLMMessage = { role: "user", content: "abcdefgh" }; // 8 chars
    expect(counter.countMessage(msg)).toBe(2 + 4); // ceil(8/4)=2, +4 envelope
  });

  it("returns 0 for empty array", () => {
    expect(counter.countMessages([])).toBe(0);
  });
});
