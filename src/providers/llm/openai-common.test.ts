/**
 * Tests for the OpenAI / Azure / Ollama shared message-builder.
 *
 * Specifically guards the BUG #3 fix: assistant turns that issued a tool_call
 * MUST be replayed with a `tool_calls` array on the next request, and a
 * trailing `role:"tool"` message must include `tool_call_id`.
 */
import { describe, it, expect } from "vitest";
import { buildOpenAIParams } from "./openai-common.js";
import type { LLMRequest } from "../../core/providers/llm.js";

describe("buildOpenAIParams", () => {
  it("preserves a plain user/assistant exchange unchanged", () => {
    const req: LLMRequest = {
      model: "gpt-test",
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello!" },
      ],
    };
    const params = buildOpenAIParams(req, "gpt-test");
    expect(params.model).toBe("gpt-test");
    expect(params.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ]);
  });

  it("threads tool_call_id back onto tool messages", () => {
    const req: LLMRequest = {
      model: "gpt-test",
      messages: [
        { role: "user", content: "verify" },
        { role: "tool", content: "OK", toolCallId: "call_xyz", name: "lean_check" },
      ],
    };
    const params = buildOpenAIParams(req, "gpt-test");
    expect(params.messages[1]).toEqual({
      role: "tool",
      content: "OK",
      tool_call_id: "call_xyz",
    });
  });

  it("emits assistant.tool_calls so the trailing tool message has a parent (BUG #3)", () => {
    const req: LLMRequest = {
      model: "gpt-test",
      messages: [
        { role: "user", content: "verify lemma" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_42",
              name: "lean_check",
              arguments: '{"leanSource":"theorem t : 1 = 1 := by rfl"}',
            },
          ],
        },
        { role: "tool", content: "OK", toolCallId: "call_42", name: "lean_check" },
        { role: "user", content: "thanks" },
      ],
    };
    const params = buildOpenAIParams(req, "gpt-test");
    const assistant = params.messages[1];
    expect(assistant.role).toBe("assistant");
    // Empty assistant content becomes `null` per the OpenAI spec.
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toEqual([
      {
        id: "call_42",
        type: "function",
        function: {
          name: "lean_check",
          arguments: '{"leanSource":"theorem t : 1 = 1 := by rfl"}',
        },
      },
    ]);
    expect(params.messages[2]).toEqual({
      role: "tool",
      content: "OK",
      tool_call_id: "call_42",
    });
  });

  it("keeps assistant text alongside tool_calls when both are present", () => {
    const req: LLMRequest = {
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: "Let me check that.",
          toolCalls: [{ id: "c1", name: "lean_check", arguments: "{}" }],
        },
      ],
    };
    const params = buildOpenAIParams(req, "gpt-test");
    expect(params.messages[0].content).toBe("Let me check that.");
    expect(params.messages[0].tool_calls).toHaveLength(1);
  });
});
