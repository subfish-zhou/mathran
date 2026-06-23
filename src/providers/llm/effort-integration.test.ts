/**
 * Integration tests for reasoning-effort passthrough into provider adapters
 * (#6). Each test patches the underlying SDK client's `create` method to
 * capture the on-the-wire request body, then drives the adapter's `chat()`
 * stream to completion.
 *
 * Acceptance coverage:
 *   1. OpenAI effort=high      → body.reasoning.effort === "high"
 *   2. OpenAI effort=max       → reasoning.effort "high" + raised max_tokens
 *   3. Anthropic effort=low    → NO `thinking` field
 *   4. Anthropic effort=high   → thinking.budget_tokens === 16384
 *   5. Ollama (OpenAI-compat)  → ignores effort (no `reasoning` field)
 *   6. A bespoke unsupported adapter ignores effort without throwing
 */
import { describe, it, expect } from "vitest";
import { OpenAIAdapter } from "./openai.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OllamaAdapter } from "./ollama.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../core/providers/llm.js";

/** Patch an OpenAI-SDK-shaped client to capture chat.completions params. */
function captureOpenAI(adapter: { client: any }): { last: () => any } {
  let captured: any;
  adapter.client.chat = {
    completions: {
      create: async (params: any) => {
        captured = params;
        return [] as any;
      },
    },
  };
  return { last: () => captured };
}

/** Patch an Anthropic-SDK-shaped client to capture messages.create params. */
function captureAnthropic(adapter: { client: any }): { last: () => any } {
  let captured: any;
  adapter.client.messages = {
    create: async (params: any) => {
      captured = params;
      return [] as any;
    },
  };
  return { last: () => captured };
}

async function drain(res: LLMResponse): Promise<void> {
  for await (const _ of res.stream()) {
    /* consume */
  }
}

const baseReq = (extra: Partial<LLMRequest>): LLMRequest => ({
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

describe("OpenAI adapter effort passthrough", () => {
  it("injects reasoning.effort = high (acceptance #1)", async () => {
    const adapter = new OpenAIAdapter({ apiKey: "k", defaultModel: "gpt-x" });
    const cap = captureOpenAI(adapter as any);
    await drain(await adapter.chat(baseReq({ effort: "high" })));
    expect(cap.last().reasoning).toEqual({ effort: "high" });
    expect(cap.last().max_tokens).toBeUndefined();
  });

  it("max clamps reasoning to high and raises max_tokens", async () => {
    const adapter = new OpenAIAdapter({ apiKey: "k", defaultModel: "gpt-x" });
    const cap = captureOpenAI(adapter as any);
    await drain(await adapter.chat(baseReq({ effort: "max" })));
    expect(cap.last().reasoning).toEqual({ effort: "high" });
    expect(cap.last().max_tokens).toBeGreaterThanOrEqual(32768);
  });

  it("sends no reasoning field when effort is absent", async () => {
    const adapter = new OpenAIAdapter({ apiKey: "k", defaultModel: "gpt-x" });
    const cap = captureOpenAI(adapter as any);
    await drain(await adapter.chat(baseReq({})));
    expect(cap.last().reasoning).toBeUndefined();
  });
});

describe("Anthropic adapter effort passthrough", () => {
  it("effort=low sends NO thinking field (acceptance #3)", async () => {
    const adapter = new AnthropicAdapter({ apiKey: "k", defaultModel: "claude-x" });
    const cap = captureAnthropic(adapter as any);
    await drain(await adapter.chat(baseReq({ effort: "low" })));
    expect(cap.last().thinking).toBeUndefined();
  });

  it("effort=high enables thinking with budget 16384", async () => {
    const adapter = new AnthropicAdapter({ apiKey: "k", defaultModel: "claude-x" });
    const cap = captureAnthropic(adapter as any);
    await drain(await adapter.chat(baseReq({ effort: "high" })));
    expect(cap.last().thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(cap.last().max_tokens).toBeGreaterThan(16384);
  });

  it("effort=max enables thinking with budget 32768", async () => {
    const adapter = new AnthropicAdapter({ apiKey: "k", defaultModel: "claude-x" });
    const cap = captureAnthropic(adapter as any);
    await drain(await adapter.chat(baseReq({ effort: "max" })));
    expect(cap.last().thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
  });

  it("drops a custom temperature when thinking is enabled", async () => {
    const adapter = new AnthropicAdapter({ apiKey: "k", defaultModel: "claude-x" });
    const cap = captureAnthropic(adapter as any);
    await drain(await adapter.chat(baseReq({ effort: "medium", temperature: 0.2 })));
    expect(cap.last().temperature).toBeUndefined();
    expect(cap.last().thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("keeps temperature when effort=low (thinking disabled)", async () => {
    const adapter = new AnthropicAdapter({ apiKey: "k", defaultModel: "claude-x" });
    const cap = captureAnthropic(adapter as any);
    await drain(await adapter.chat(baseReq({ effort: "low", temperature: 0.2 })));
    expect(cap.last().temperature).toBe(0.2);
  });
});

describe("unsupported providers silently ignore effort (acceptance #4/#5)", () => {
  it("Ollama (OpenAI-compatible) does not inject reasoning", async () => {
    const adapter = new OllamaAdapter({ defaultModel: "llama3" });
    const cap = captureOpenAI(adapter as any);
    await drain(await adapter.chat(baseReq({ effort: "max" })));
    expect(cap.last().reasoning).toBeUndefined();
    expect(cap.last().thinking).toBeUndefined();
  });

  it("a bespoke adapter that ignores effort does not throw", async () => {
    class MockProvider implements LLMProvider {
      seen?: LLMRequest;
      async describe() {
        return { name: "mock" };
      }
      async chat(req: LLMRequest): Promise<LLMResponse> {
        this.seen = req; // receives effort but never reads it
        return {
          stream: async function* (): AsyncIterable<LLMStreamChunk> {
            yield { type: "done", finishReason: "stop" };
          },
        };
      }
    }
    const mock = new MockProvider();
    await drain(await mock.chat(baseReq({ effort: "high" })));
    expect(mock.seen?.effort).toBe("high");
  });
});
