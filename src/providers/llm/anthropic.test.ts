/**
 * Tests for the Anthropic message-builder.
 *
 * Specifically guards the BUG #3 fix: assistant turns that issued a tool_use
 * MUST be replayed as a content array of `{type:"text"} + {type:"tool_use"}`
 * blocks, and the trailing tool result must reference the same id.
 */
import { describe, it, expect } from "vitest";
import { toAnthropicMessages, toAnthropicContentBlocks, AnthropicAdapter } from "./anthropic.js";

describe("toAnthropicMessages", () => {
  it("collects all system messages into a single system string", () => {
    const out = toAnthropicMessages([
      { role: "system", content: "alpha" },
      { role: "user", content: "u1" },
      { role: "system", content: "beta" },
    ]);
    expect(out.system).toBe("alpha\n\nbeta");
    expect(out.messages).toEqual([{ role: "user", content: "u1" }]);
  });

  it("rewrites tool messages as user-role tool_result blocks", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "verify" },
      { role: "tool", content: "OK", toolCallId: "tu_42" },
    ]);
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_42", content: "OK" }],
    });
  });

  it("rebuilds an assistant tool_use block with parsed JSON input (BUG #3)", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "verify lemma" },
      {
        role: "assistant",
        content: "On it.",
        toolCalls: [
          {
            id: "tu_99",
            name: "lean_check",
            arguments: '{"leanSource":"theorem t : 1 = 1 := by rfl"}',
          },
        ],
      },
      { role: "tool", content: "OK", toolCallId: "tu_99" },
    ]);

    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "On it." },
        {
          type: "tool_use",
          id: "tu_99",
          name: "lean_check",
          input: { leanSource: "theorem t : 1 = 1 := by rfl" },
        },
      ],
    });
    expect(out.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_99", content: "OK" }],
    });
  });

  it("falls back to {} when the LLM-emitted tool arguments are not valid JSON", () => {
    const out = toAnthropicMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tu_x", name: "lean_check", arguments: "not-json" }],
      },
    ]);
    const blocks = (out.messages[0] as { content: any[] }).content;
    const toolUse = blocks.find((b: any) => b.type === "tool_use");
    expect(toolUse.input).toEqual({});
  });
});

describe("toAnthropicContentBlocks (C-round vision)", () => {
  it("keeps plain strings as plain strings", () => {
    expect(toAnthropicContentBlocks("hello")).toBe("hello");
  });

  it("emits {type:'image', source:{type:'base64', media_type, data}} for image parts", () => {
    const blocks = toAnthropicContentBlocks([
      { type: "text", text: "look at this" },
      { type: "image", mimeType: "image/png", dataBase64: "aGVsbG8=" },
    ]);
    expect(blocks).toEqual([
      { type: "text", text: "look at this" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
    ]);
  });

  it("drops zero-length text parts from the block list", () => {
    const blocks = toAnthropicContentBlocks([
      { type: "text", text: "" },
      { type: "image", mimeType: "image/jpeg", dataBase64: "AAAA" },
    ]);
    expect(blocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
    ]);
  });
});

describe("AnthropicAdapter supportsVision", () => {
  it("declares supportsVision = true so the host forwards ContentPart[]", () => {
    const adapter = new AnthropicAdapter({ apiKey: "sk-fake" });
    expect(adapter.supportsVision).toBe(true);
  });
});
