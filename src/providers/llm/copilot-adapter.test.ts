import { describe, it, expect } from "vitest";
import { CopilotAdapter } from "./copilot-adapter.js";
import type { CopilotChatRequest, CopilotChatResponse } from "./copilot.js";
import type { LLMStreamChunk } from "../../core/providers/llm.js";

function fakeChat(
  res: Partial<CopilotChatResponse>,
  sink?: { req?: CopilotChatRequest },
): (req: CopilotChatRequest) => Promise<CopilotChatResponse> {
  return async (req: CopilotChatRequest) => {
    if (sink) sink.req = req;
    return {
      text: res.text ?? "",
      toolCalls: res.toolCalls ?? [],
      finishReason: res.finishReason ?? "stop",
      usage: res.usage ?? { input: 1, output: 2 },
      raw: res.raw ?? {},
    };
  };
}

async function collect(stream: AsyncIterable<LLMStreamChunk>): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("CopilotAdapter tool wiring", () => {
  it("forwards tools and tool messages to the chat fn", async () => {
    const sink: { req?: CopilotChatRequest } = {};
    const adapter = new CopilotAdapter({ chatFn: fakeChat({ text: "hi" }, sink) as never });
    await collect(
      (await adapter.chat({
        model: "gpt-5.5",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "" },
          { role: "tool", content: "result", toolCallId: "c1", name: "lean_check" },
        ],
        tools: [{ name: "lean_check", description: "d", parameters: { type: "object" } }],
      })).stream(),
    );
    expect(sink.req?.systemPrompt).toBe("sys");
    expect(sink.req?.tools).toEqual([
      { name: "lean_check", description: "d", parameters: { type: "object" } },
    ]);
    expect(sink.req?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "tool", content: "result", toolCallId: "c1", name: "lean_check" },
    ]);
  });

  it("emits tool-call chunks (whole args) before done, with tool_calls finishReason", async () => {
    const adapter = new CopilotAdapter({
      chatFn: fakeChat({
        text: "",
        toolCalls: [{ id: "call_1", name: "lean_check", arguments: '{"code":"rfl"}' }],
        finishReason: "tool_calls",
        usage: { input: 5, output: 6 },
      }) as never,
    });
    const chunks = await collect((await adapter.chat({ model: "gpt-5.5", messages: [] })).stream());
    expect(chunks).toEqual([
      { type: "tool-call", id: "call_1", name: "lean_check", argsDelta: '{"code":"rfl"}' },
      { type: "done", finishReason: "tool_calls", usage: { promptTokens: 5, completionTokens: 6 } },
    ]);
  });

  it("keeps the text-only path unchanged (no tool-call chunk, stop)", async () => {
    const adapter = new CopilotAdapter({
      chatFn: fakeChat({ text: "PONG", finishReason: "stop", usage: { input: 3, output: 4 } }) as never,
    });
    const chunks = await collect((await adapter.chat({ model: "gpt-5.5", messages: [] })).stream());
    expect(chunks).toEqual([
      { type: "text", delta: "PONG" },
      { type: "done", finishReason: "stop", usage: { promptTokens: 3, completionTokens: 4 } },
    ]);
  });

  it("emits both text and tool-call when a turn has both", async () => {
    const adapter = new CopilotAdapter({
      chatFn: fakeChat({
        text: "let me check",
        toolCalls: [{ id: "c", name: "lean_check", arguments: "{}" }],
        finishReason: "tool_calls",
      }) as never,
    });
    const chunks = await collect((await adapter.chat({ model: "gpt-5.5", messages: [] })).stream());
    expect(chunks).toEqual([
      { type: "text", delta: "let me check" },
      { type: "tool-call", id: "c", name: "lean_check", argsDelta: "{}" },
      { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 2 } },
    ]);
  });

  it("omits tools when none are provided", async () => {
    const sink: { req?: CopilotChatRequest } = {};
    const adapter = new CopilotAdapter({ chatFn: fakeChat({ text: "x" }, sink) as never });
    await collect(
      (await adapter.chat({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] })).stream(),
    );
    expect(sink.req?.tools).toBeUndefined();
  });
});
