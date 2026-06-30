/**
 * Capability-flag tests for the LLMProvider interface (audit §6 bug #190).
 *
 * The contract under test:
 *   1. Every shipped provider declares the four capability flags with the
 *      correct truth value for its wire protocol.
 *   2. The ModelRouter emits a `console.warn` (NOT a silent no-op) when the
 *      caller sets `req.effort` against a provider that declares
 *      `supportsReasoning = false`.
 *   3. The Copilot adapter emits a `console.warn` when a Gemini-routed model
 *      is paired with `req.effort` / `req.tools` / image content parts, even
 *      though the static class flag says `supportsReasoning = true` (the
 *      class can't know the route until call time).
 *   4. The Anthropic message builder emits a `console.warn` when image parts
 *      land on a system turn (Anthropic silently drops them on the wire).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIAdapter } from "../../providers/llm/openai.js";
import { AnthropicAdapter, toAnthropicMessages } from "../../providers/llm/anthropic.js";
import { AzureOpenAIAdapter } from "../../providers/llm/azure.js";
import { OllamaAdapter } from "../../providers/llm/ollama.js";
import {
  CopilotAdapter,
  isGeminiCopilotRoute,
} from "../../providers/llm/copilot-adapter.js";
import { ModelRouter, type MathranConfig } from "../../providers/llm/router.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "./llm.js";

/* ─── helpers ────────────────────────────────────────────────────────────── */

function makeMockProvider(
  caps: Partial<Pick<LLMProvider, "supportsVision" | "supportsToolUse" | "supportsReasoning" | "supportsStreamingTools">>,
  name = "mock",
): LLMProvider {
  return {
    async describe() {
      return { name };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
    ...caps,
  };
}

async function drain(res: LLMResponse): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const c of res.stream()) out.push(c);
  return out;
}

/* ─── per-provider flag table ────────────────────────────────────────────── */

describe("LLMProvider capability flags (audit §6 bug #190)", () => {
  it("Anthropic: vision=true, toolUse=true, reasoning=true, streamingTools=true", () => {
    const a = new AnthropicAdapter({ apiKey: "test", defaultModel: "claude-x" });
    expect(a.supportsVision).toBe(true);
    expect(a.supportsToolUse).toBe(true);
    expect(a.supportsReasoning).toBe(true);
    expect(a.supportsStreamingTools).toBe(true);
  });

  it("OpenAI: vision=true, toolUse=true, reasoning=true, streamingTools=true", () => {
    const o = new OpenAIAdapter({ apiKey: "test", defaultModel: "gpt-x" });
    expect(o.supportsVision).toBe(true);
    expect(o.supportsToolUse).toBe(true);
    expect(o.supportsReasoning).toBe(true);
    expect(o.supportsStreamingTools).toBe(true);
  });

  it("Azure: vision=true, toolUse=true, reasoning=FALSE, streamingTools=true", () => {
    // Azure adapter routes through chat-completions only and never calls
    // applyOpenAIEffort, so the effort field is silently dropped on the
    // wire. supportsReasoning MUST be false so the router warns.
    const az = new AzureOpenAIAdapter({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-4o",
      apiVersion: "2024-08-01-preview",
    });
    expect(az.supportsVision).toBe(true);
    expect(az.supportsToolUse).toBe(true);
    expect(az.supportsReasoning).toBe(false);
    expect(az.supportsStreamingTools).toBe(true);
  });

  it("Copilot: vision=true, toolUse=true, reasoning=true (per-call warn for Gemini), streamingTools=true", () => {
    const c = new CopilotAdapter({ defaultModel: "gpt-5.5" });
    expect(c.supportsVision).toBe(true);
    expect(c.supportsToolUse).toBe(true);
    expect(c.supportsReasoning).toBe(true);
    expect(c.supportsStreamingTools).toBe(true);
  });

  it("Ollama: vision=FALSE, toolUse=true, reasoning=FALSE, streamingTools=true", () => {
    const ol = new OllamaAdapter({ defaultModel: "llama3" });
    expect(ol.supportsVision).toBe(false);
    expect(ol.supportsToolUse).toBe(true);
    expect(ol.supportsReasoning).toBe(false);
    expect(ol.supportsStreamingTools).toBe(true);
  });
});

/* ─── router: unsupported reasoning emits a warn ─────────────────────────── */

describe("ModelRouter warns on unsupported reasoning (audit §6)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const cfg: MathranConfig = {
    defaultModel: "ollama/llama3",
    providers: {
      ollama: { kind: "ollama" },
      anthropic: { kind: "anthropic", apiKey: "test" },
    },
  };

  it("warns when req.effort is set against a provider with supportsReasoning=false", async () => {
    const r = new ModelRouter(cfg, {
      adapterFactory: (key) =>
        key === "ollama"
          ? makeMockProvider({ supportsReasoning: false }, "ollama")
          : makeMockProvider({ supportsReasoning: true }, "anthropic"),
    });

    await drain(await r.chat({ model: "ollama/llama3", messages: [], effort: "high" }));
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("reasoning effort 'high' ignored by provider 'ollama'");
    expect(msg).toContain("no native reasoning support");
  });

  it("does NOT warn when req.effort is set against a supportsReasoning=true provider", async () => {
    const r = new ModelRouter(cfg, {
      adapterFactory: () => makeMockProvider({ supportsReasoning: true }, "anthropic"),
    });
    await drain(
      await r.chat({ model: "anthropic/claude-x", messages: [], effort: "high" }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT warn when req.effort is absent", async () => {
    const r = new ModelRouter(cfg, {
      adapterFactory: () => makeMockProvider({ supportsReasoning: false }, "ollama"),
    });
    await drain(await r.chat({ model: "ollama/llama3", messages: [] }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when tools[] is set against a supportsToolUse=false provider", async () => {
    const r = new ModelRouter(cfg, {
      adapterFactory: () => makeMockProvider({ supportsToolUse: false }, "text-only"),
    });
    await drain(
      await r.chat({
        model: "ollama/text-only",
        messages: [],
        tools: [{ name: "t", parameters: {} }],
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("tools[]");
    expect(msg).toContain("no tool-use support");
  });

  it("routeSupportsReasoning reflects the resolved adapter flag", () => {
    const r = new ModelRouter(cfg, {
      adapterFactory: (key) =>
        key === "ollama"
          ? makeMockProvider({ supportsReasoning: false })
          : makeMockProvider({ supportsReasoning: true }),
    });
    expect(r.routeSupportsReasoning("ollama/llama3")).toBe(false);
    expect(r.routeSupportsReasoning("anthropic/claude-x")).toBe(true);
  });
});

/* ─── Copilot Gemini route warn ──────────────────────────────────────────── */

describe("CopilotAdapter Gemini-route warns (audit §6 bug #146)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("isGeminiCopilotRoute classifies the three routes", () => {
    expect(isGeminiCopilotRoute("gpt-5.5")).toBe(false);
    expect(isGeminiCopilotRoute("o3-mini")).toBe(false);
    expect(isGeminiCopilotRoute("claude-opus-4-5")).toBe(false);
    expect(isGeminiCopilotRoute("gemini-2.5-pro")).toBe(true);
    expect(isGeminiCopilotRoute("unknown-model")).toBe(true);
    expect(isGeminiCopilotRoute("")).toBe(false);
  });

  it("warns about effort on a Gemini model", async () => {
    const adapter = new CopilotAdapter({
      defaultModel: "gemini-2.5-pro",
      chatFn: async () =>
        ({
          text: "ok",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: { input: 0, output: 0 },
          raw: {},
        }) as any,
    });

    await drain(
      await adapter.chat({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        effort: "high",
      }),
    );
    const calls = warn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("reasoning effort 'high'"))).toBe(true);
    expect(calls.some((m) => m.includes("Gemini route"))).toBe(true);
  });

  it("warns about tools on a Gemini model", async () => {
    const adapter = new CopilotAdapter({
      defaultModel: "gemini-2.5-pro",
      chatFn: async () =>
        ({
          text: "ok",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: { input: 0, output: 0 },
          raw: {},
        }) as any,
    });

    await drain(
      await adapter.chat({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "t", parameters: {} }],
      }),
    );
    const calls = warn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("tools[]") && m.includes("Gemini route"))).toBe(true);
  });

  it("does NOT warn for a GPT model", async () => {
    const adapter = new CopilotAdapter({
      defaultModel: "gpt-5.5",
      chatFn: async () =>
        ({
          text: "ok",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: { input: 0, output: 0 },
          raw: {},
        }) as any,
    });

    await drain(
      await adapter.chat({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        effort: "high",
        tools: [{ name: "t", parameters: {} }],
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

/* ─── Anthropic system-turn image drop warn ──────────────────────────────── */

describe("Anthropic system-turn image drop warns (audit §6 bug #145)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("warns when a system turn carries an image part", () => {
    toAnthropicMessages([
      {
        role: "system",
        content: [
          { type: "text", text: "you are a helpful assistant" },
          { type: "image", mimeType: "image/png", dataBase64: "iVBORw0K" },
        ],
      },
      { role: "user", content: "hi" },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("anthropic");
    expect(msg).toContain("1 image part(s)");
    expect(msg).toContain("system turn");
  });

  it("counts multiple image parts across multiple system turns", () => {
    toAnthropicMessages([
      {
        role: "system",
        content: [
          { type: "image", mimeType: "image/png", dataBase64: "a" },
          { type: "image", mimeType: "image/png", dataBase64: "b" },
        ],
      },
      {
        role: "system",
        content: [{ type: "image", mimeType: "image/jpeg", dataBase64: "c" }],
      },
      { role: "user", content: "ok" },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("3 image part(s)");
  });

  it("does NOT warn when system turns are text-only", () => {
    toAnthropicMessages([
      { role: "system", content: "you are an assistant" },
      { role: "user", content: "hi" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT warn when image parts ride a user turn (Anthropic accepts those)", () => {
    toAnthropicMessages([
      { role: "system", content: "system text" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", dataBase64: "u" },
        ],
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});
