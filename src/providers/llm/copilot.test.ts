import { describe, it, expect } from "vitest";
import {
  buildResponsesInput,
  buildResponsesTools,
  extractResponsesToolCalls,
  buildMessagesInput,
  buildMessagesTools,
  extractMessagesToolCalls,
  type CopilotChatRequest,
  type CopilotChatMessage,
} from "./copilot.js";

const tool = {
  name: "lean_check",
  description: "Check a Lean proof",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

describe("buildResponsesInput (GPT /responses)", () => {
  it("emits a system item then user/assistant items", () => {
    const req: CopilotChatRequest = {
      model: "gpt-5.5",
      systemPrompt: "be helpful",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    };
    expect(buildResponsesInput(req)).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("translates a tool turn into function_call + function_call_output", () => {
    const req: CopilotChatRequest = {
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "prove it" },
        { role: "assistant", content: "" },
        { role: "tool", content: "ok: proof closed", toolCallId: "call_1", name: "lean_check" },
      ],
    };
    // empty assistant turn is dropped; tool becomes the call+output pair.
    expect(buildResponsesInput(req)).toEqual([
      { role: "user", content: "prove it" },
      { type: "function_call", call_id: "call_1", name: "lean_check", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok: proof closed" },
    ]);
  });

  it("keeps non-empty assistant content alongside a later tool turn", () => {
    const req: CopilotChatRequest = {
      model: "gpt-5.5",
      messages: [
        { role: "assistant", content: "let me check" },
        { role: "tool", content: "result", toolCallId: "c2", name: "lean_check" },
      ],
    };
    expect(buildResponsesInput(req)).toEqual([
      { role: "assistant", content: "let me check" },
      { type: "function_call", call_id: "c2", name: "lean_check", arguments: "{}" },
      { type: "function_call_output", call_id: "c2", output: "result" },
    ]);
  });
});

describe("buildResponsesTools", () => {
  it("uses the flat function tool shape", () => {
    expect(buildResponsesTools([tool])).toEqual([
      {
        type: "function",
        name: "lean_check",
        description: "Check a Lean proof",
        parameters: tool.parameters,
      },
    ]);
  });

  it("omits description when absent", () => {
    expect(buildResponsesTools([{ name: "t", parameters: {} }])).toEqual([
      { type: "function", name: "t", parameters: {} },
    ]);
  });
});

describe("extractResponsesToolCalls", () => {
  it("parses function_call items, preserving the arguments string", () => {
    const raw = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "thinking" }] },
        { type: "function_call", call_id: "call_42", name: "lean_check", arguments: '{"code":"rfl"}' },
      ],
    };
    expect(extractResponsesToolCalls(raw)).toEqual([
      { id: "call_42", name: "lean_check", arguments: '{"code":"rfl"}' },
    ]);
  });

  it("stringifies non-string arguments and falls back to id", () => {
    const raw = { output: [{ type: "function_call", id: "x1", name: "t", arguments: { a: 1 } }] };
    expect(extractResponsesToolCalls(raw)).toEqual([
      { id: "x1", name: "t", arguments: '{"a":1}' },
    ]);
  });

  it("returns [] when there are no function_call items", () => {
    expect(extractResponsesToolCalls({ output: [{ type: "message", content: [] }] })).toEqual([]);
    expect(extractResponsesToolCalls({})).toEqual([]);
  });
});

describe("buildMessagesInput (Claude /v1/messages)", () => {
  it("attaches a tool_use block to the assistant turn and a tool_result user turn", () => {
    const msgs: CopilotChatMessage[] = [
      { role: "user", content: "prove it" },
      { role: "assistant", content: "checking" },
      { role: "tool", content: "ok", toolCallId: "tu_1", name: "lean_check" },
    ];
    expect(buildMessagesInput(msgs)).toEqual([
      { role: "user", content: "prove it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "tu_1", name: "lean_check", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    ]);
  });

  it("batches multiple tool calls into one assistant + one user turn", () => {
    const msgs: CopilotChatMessage[] = [
      { role: "assistant", content: "" },
      { role: "tool", content: "r1", toolCallId: "a", name: "lean_check" },
      { role: "tool", content: "r2", toolCallId: "b", name: "lean_check" },
    ];
    expect(buildMessagesInput(msgs)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "lean_check", input: {} },
          { type: "tool_use", id: "b", name: "lean_check", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "r1" },
          { type: "tool_result", tool_use_id: "b", content: "r2" },
        ],
      },
    ]);
  });
});

describe("buildMessagesTools", () => {
  it("uses the Anthropic input_schema shape", () => {
    expect(buildMessagesTools([tool])).toEqual([
      { name: "lean_check", description: "Check a Lean proof", input_schema: tool.parameters },
    ]);
  });
});

describe("extractMessagesToolCalls", () => {
  it("parses tool_use blocks and stringifies input", () => {
    const raw = {
      content: [
        { type: "text", text: "let me try" },
        { type: "tool_use", id: "tu_9", name: "lean_check", input: { code: "rfl" } },
      ],
      stop_reason: "tool_use",
    };
    expect(extractMessagesToolCalls(raw)).toEqual([
      { id: "tu_9", name: "lean_check", arguments: '{"code":"rfl"}' },
    ]);
  });

  it("returns [] when there is no tool_use", () => {
    expect(extractMessagesToolCalls({ content: [{ type: "text", text: "hi" }] })).toEqual([]);
  });
});
