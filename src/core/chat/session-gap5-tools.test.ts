/**
 * Registration smoke test for gap #5 chat tools: `search_web` + `verify_page`
 * should register on a ChatSession when their builtinTools flags are set.
 */
import { describe, it, expect } from "vitest";
import { ChatSession } from "./session.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../providers/llm.js";

class StubLLM implements LLMProvider {
  async describe() {
    return { name: "stub" };
  }
  async chat(_req: LLMRequest): Promise<LLMResponse> {
    return {
      async *stream() {
        yield { type: "done", finishReason: "stop" } as any;
      },
    } as LLMResponse;
  }
}

function toolNames(session: ChatSession): Set<string> {
  const tools = (session as any).tools as { name: string }[];
  return new Set(tools.map((t) => t.name));
}

describe("gap #5 chat-tool registration", () => {
  it("registers search_web when enabled with a boolean", () => {
    const session = new ChatSession({
      llm: new StubLLM(),
      builtinTools: { search_web: true },
      workspace: "/tmp/mathran-gap5-test",
    });
    expect(toolNames(session).has("search_web")).toBe(true);
  });

  it("registers search_web when enabled with a provider object", () => {
    const session = new ChatSession({
      llm: new StubLLM(),
      builtinTools: { search_web: { provider: "serpapi", apiKey: "k" } },
      workspace: "/tmp/mathran-gap5-test",
    });
    expect(toolNames(session).has("search_web")).toBe(true);
  });

  it("registers verify_page when enabled", () => {
    const session = new ChatSession({
      llm: new StubLLM(),
      builtinTools: { verify_page: true },
      workspace: "/tmp/mathran-gap5-test",
    });
    expect(toolNames(session).has("verify_page")).toBe(true);
  });

  it("does not register either tool by default", () => {
    const session = new ChatSession({
      llm: new StubLLM(),
      builtinTools: {},
      workspace: "/tmp/mathran-gap5-test",
    });
    const names = toolNames(session);
    expect(names.has("search_web")).toBe(false);
    expect(names.has("verify_page")).toBe(false);
  });
});
