/**
 * Tests for the OpenAI / Azure / Ollama shared message-builder.
 *
 * Specifically guards the BUG #3 fix: assistant turns that issued a tool_call
 * MUST be replayed with a `tool_calls` array on the next request, and a
 * trailing `role:"tool"` message must include `tool_call_id`.
 */
import { describe, it, expect } from "vitest";
import { buildOpenAIParams, toOpenAIContent, streamOpenAI } from "./openai-common.js";
import type { LLMRequest, LLMStreamChunk } from "../../core/providers/llm.js";

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

function fakeOpenAIClient(parts: unknown[]): any {
  return {
    chat: { completions: { create: async () => fromArray(parts) } },
  };
}

async function collectChunks(it: AsyncIterable<LLMStreamChunk>): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("streamOpenAI reasoning parsing (UX gap B)", () => {
  it("maps reasoning_content deltas onto reasoning chunks", async () => {
    const client = fakeOpenAIClient([
      { choices: [{ delta: { reasoning_content: "let me " } }] },
      { choices: [{ delta: { reasoning_content: "think…" } }] },
      { choices: [{ delta: { content: "Answer." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const chunks = await collectChunks(streamOpenAI(client, {}));
    expect(chunks).toEqual([
      { type: "reasoning", delta: "let me " },
      { type: "reasoning", delta: "think…" },
      { type: "text", delta: "Answer." },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("also accepts the gateway `reasoning` delta alias", async () => {
    const client = fakeOpenAIClient([
      { choices: [{ delta: { reasoning: "hmm" } }] },
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
    ]);
    const chunks = await collectChunks(streamOpenAI(client, {}));
    expect(chunks).toContainEqual({ type: "reasoning", delta: "hmm" });
  });

  it("emits no reasoning chunk when the stream carries none", async () => {
    const client = fakeOpenAIClient([
      { choices: [{ delta: { content: "plain" }, finish_reason: "stop" }] },
    ]);
    const chunks = await collectChunks(streamOpenAI(client, {}));
    expect(chunks.some((c) => c.type === "reasoning")).toBe(false);
  });
});

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

describe("toOpenAIContent (C-round vision)", () => {
  it("keeps plain strings as plain strings", () => {
    expect(toOpenAIContent("text-only")).toBe("text-only");
  });

  it("emits {type:'image_url', image_url:{url:'data:<mime>;base64,<b64>'}} for image parts", () => {
    const parts = toOpenAIContent([
      { type: "text", text: "caption" },
      { type: "image", mimeType: "image/png", dataBase64: "AAAA" },
    ]);
    expect(parts).toEqual([
      { type: "text", text: "caption" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});

describe("buildOpenAIParams (C-round vision)", () => {
  it("forwards ContentPart[] image parts onto the user turn as image_url blocks", () => {
    const req: LLMRequest = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "S" },
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", mimeType: "image/jpeg", dataBase64: "////" },
          ],
        },
      ],
    };
    const params = buildOpenAIParams(req, "gpt-4o");
    // system turn stays a plain string (OpenAI rejects image_url on system)
    expect(params.messages[0]).toEqual({ role: "system", content: "S" });
    // user turn promotes to multimodal parts[]
    expect(params.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,////" } },
      ],
    });
  });
});
