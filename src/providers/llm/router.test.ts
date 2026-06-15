import { describe, it, expect, vi } from "vitest";
import {
  ModelRouter,
  resolveApiKey,
  type MathranConfig,
  type ProviderConfig,
  type AdapterFactory,
} from "./router.js";
import type { LLMProvider, LLMResponse, LLMStreamChunk } from "../../core/providers/llm.js";

function fakeAdapter(name: string, sink?: string[]): LLMProvider {
  return {
    async describe() {
      return { name };
    },
    async chat(req): Promise<LLMResponse> {
      sink?.push(req.model);
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "text", delta: name };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

const baseCfg: MathranConfig = {
  defaultModel: "openai/gpt-4o",
  providers: {
    openai: { kind: "openai", apiKey: "k1" },
    anthropic: { kind: "anthropic", apiKey: "k2" },
  },
};

describe("ModelRouter.resolve", () => {
  it("splits a prefixed model into provider + model", () => {
    const r = new ModelRouter(baseCfg, { adapterFactory: () => fakeAdapter("x") });
    expect(r.resolve("anthropic/claude-opus-4-5")).toEqual({
      providerKey: "anthropic",
      model: "claude-opus-4-5",
    });
  });

  it("keeps only the first slash as the separator", () => {
    const r = new ModelRouter(baseCfg, { adapterFactory: () => fakeAdapter("x") });
    expect(r.resolve("azure/my/deploy")).toEqual({ providerKey: "azure", model: "my/deploy" });
  });

  it("uses defaultModel's provider prefix for a bare model", () => {
    const r = new ModelRouter(baseCfg, { adapterFactory: () => fakeAdapter("x") });
    expect(r.resolve("gpt-4o-mini")).toEqual({ providerKey: "openai", model: "gpt-4o-mini" });
  });

  it("falls back to the first provider when no defaultModel", () => {
    const cfg: MathranConfig = { providers: { ollama: { kind: "ollama" } } };
    const r = new ModelRouter(cfg, { adapterFactory: () => fakeAdapter("x") });
    expect(r.resolve("llama3.1")).toEqual({ providerKey: "ollama", model: "llama3.1" });
  });
});

describe("ModelRouter.chat", () => {
  it("routes to the correct adapter and forwards the stripped model", async () => {
    const seen: string[] = [];
    const factory: AdapterFactory = (key) => fakeAdapter(key, seen);
    const r = new ModelRouter(baseCfg, { adapterFactory: factory });
    const res = await r.chat({ model: "anthropic/claude-3", messages: [] });
    const chunks: LLMStreamChunk[] = [];
    for await (const c of res.stream()) chunks.push(c);
    expect(seen).toEqual(["claude-3"]);
    expect(chunks[0]).toEqual({ type: "text", delta: "anthropic" });
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("throws on an unknown provider", async () => {
    const r = new ModelRouter(baseCfg, { adapterFactory: () => fakeAdapter("x") });
    await expect(r.chat({ model: "mystery/foo", messages: [] })).rejects.toThrow(/unknown provider/);
  });

  it("lazily instantiates adapters and caches them", async () => {
    const factory = vi.fn<AdapterFactory>((key) => fakeAdapter(key));
    const r = new ModelRouter(baseCfg, { adapterFactory: factory });
    // No adapter built before first use.
    expect(factory).not.toHaveBeenCalled();

    await r.chat({ model: "openai/gpt-4o", messages: [] });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("openai", baseCfg.providers.openai);

    // Second call to same provider reuses the cached adapter.
    await r.chat({ model: "openai/gpt-4o-mini", messages: [] });
    expect(factory).toHaveBeenCalledTimes(1);

    // Different provider builds a second adapter.
    await r.chat({ model: "anthropic/claude-3", messages: [] });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not build adapters for unused providers", async () => {
    const factory = vi.fn<AdapterFactory>((key) => fakeAdapter(key));
    const r = new ModelRouter(baseCfg, { adapterFactory: factory });
    await r.chat({ model: "openai/gpt-4o", messages: [] });
    // anthropic was never touched.
    const builtKeys = factory.mock.calls.map((c) => c[0]);
    expect(builtKeys).toEqual(["openai"]);
  });
});

describe("resolveApiKey priority", () => {
  it("prefers explicit config apiKey over the env var", () => {
    const cfg: ProviderConfig = { kind: "openai", apiKey: "explicit" };
    expect(resolveApiKey(cfg, { OPENAI_API_KEY: "from-env" })).toBe("explicit");
  });

  it("falls back to the env var when config apiKey is absent", () => {
    const cfg: ProviderConfig = { kind: "anthropic" };
    expect(resolveApiKey(cfg, { ANTHROPIC_API_KEY: "from-env" })).toBe("from-env");
  });

  it("uses the per-kind env var name", () => {
    const cfg: ProviderConfig = { kind: "azure" };
    expect(resolveApiKey(cfg, { AZURE_OPENAI_API_KEY: "az" })).toBe("az");
  });

  it("returns undefined when neither is set", () => {
    const cfg: ProviderConfig = { kind: "openai" };
    expect(resolveApiKey(cfg, {})).toBeUndefined();
  });
});

describe("ModelRouter default factory", () => {
  it("does not crash at construction for providers missing keys", () => {
    const cfg: MathranConfig = { providers: { openai: { kind: "openai" } } };
    // Constructing the router must not throw even without keys (lazy).
    expect(() => new ModelRouter(cfg, { env: {} })).not.toThrow();
  });

  it("throws a clear error only when an unconfigured provider is actually used", async () => {
    const cfg: MathranConfig = { providers: { openai: { kind: "openai" } } };
    const r = new ModelRouter(cfg, { env: {} });
    await expect(r.chat({ model: "openai/gpt-4o", messages: [] })).rejects.toThrow(/API key/);
  });

  it("describe reports the default model", async () => {
    const r = new ModelRouter(baseCfg, { adapterFactory: () => fakeAdapter("x") });
    expect(await r.describe()).toEqual({ name: "model-router", defaultModel: "openai/gpt-4o" });
  });
});
