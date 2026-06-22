/**
 * Tests for the `allowedModels` whitelist on the ModelRouter (Copilot Opus 4.8
 * task §A.2). The whitelist is fail-open: a provider without `allowedModels`
 * imposes no restriction; a provider with a non-empty list rejects any
 * resolved model not in the list, with an error that lists the allowed models.
 */

import { describe, it, expect } from "vitest";
import { ModelRouter, type MathranConfig } from "./router.js";
import type { LLMProvider, LLMResponse, LLMStreamChunk } from "../../core/providers/llm.js";

function fakeAdapter(name: string): LLMProvider {
  return {
    async describe() {
      return { name };
    },
    async chat(): Promise<LLMResponse> {
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "text", delta: name };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

const cfgWithWhitelist: MathranConfig = {
  defaultModel: "copilot/gpt-5.5",
  providers: {
    copilot: {
      kind: "copilot",
      defaultModel: "gpt-5.5",
      allowedModels: ["gpt-5.5", "claude-opus-4.8"],
    },
  },
};

describe("ModelRouter allowedModels whitelist", () => {
  it("allows a model present in the whitelist", async () => {
    const r = new ModelRouter(cfgWithWhitelist, {
      adapterFactory: () => fakeAdapter("copilot"),
    });
    await expect(
      r.chat({ model: "copilot/claude-opus-4.8", messages: [] }),
    ).resolves.toBeDefined();
  });

  it("rejects a model absent from the whitelist with the allowed list in the message", async () => {
    const r = new ModelRouter(cfgWithWhitelist, {
      adapterFactory: () => fakeAdapter("copilot"),
    });
    await expect(
      r.chat({ model: "copilot/gpt-4o", messages: [] }),
    ).rejects.toThrow(/not allowed for provider "copilot".*gpt-5\.5, claude-opus-4\.8/s);
  });

  it("does not restrict providers without allowedModels (fail-open)", async () => {
    const cfg: MathranConfig = {
      defaultModel: "copilot/gpt-5.5",
      providers: { copilot: { kind: "copilot", defaultModel: "gpt-5.5" } },
    };
    const r = new ModelRouter(cfg, { adapterFactory: () => fakeAdapter("copilot") });
    await expect(
      r.chat({ model: "copilot/anything-goes", messages: [] }),
    ).resolves.toBeDefined();
  });

  it("treats an empty allowedModels array as no restriction", async () => {
    const cfg: MathranConfig = {
      defaultModel: "copilot/gpt-5.5",
      providers: {
        copilot: { kind: "copilot", defaultModel: "gpt-5.5", allowedModels: [] },
      },
    };
    const r = new ModelRouter(cfg, { adapterFactory: () => fakeAdapter("copilot") });
    await expect(
      r.chat({ model: "copilot/whatever", messages: [] }),
    ).resolves.toBeDefined();
  });

  it("assertModelAllowed throws for a disallowed model and passes for an allowed one", () => {
    const r = new ModelRouter(cfgWithWhitelist, {
      adapterFactory: () => fakeAdapter("copilot"),
    });
    expect(() => r.assertModelAllowed("copilot", "claude-opus-4.8")).not.toThrow();
    expect(() => r.assertModelAllowed("copilot", "nope")).toThrow(/not allowed/);
  });
});
