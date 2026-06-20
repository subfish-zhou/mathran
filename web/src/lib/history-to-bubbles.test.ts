import { describe, expect, it } from "vitest";
import { historyToBubbles, type LLMMessageWire } from "./history-to-bubbles.ts";

describe("historyToBubbles", () => {
  it("returns [] for an empty history", () => {
    expect(historyToBubbles([])).toEqual([]);
  });

  it("drops system messages", () => {
    const out = historyToBubbles([
      { role: "system", content: "you are mathran" },
      { role: "user", content: "hi" },
    ]);
    expect(out).toEqual([{ kind: "user", text: "hi" }]);
  });

  it("maps a basic user/assistant exchange", () => {
    const hist: LLMMessageWire[] = [
      { role: "user", content: "what is 2+2" },
      { role: "assistant", content: "4" },
    ];
    expect(historyToBubbles(hist)).toEqual([
      { kind: "user", text: "what is 2+2" },
      { kind: "assistant", text: "4" },
    ]);
  });

  it("emits one tool bubble per tool call + fills result on the matching tool message", () => {
    const hist: LLMMessageWire[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "bash", arguments: '{"command":"ls"}' }],
      },
      { role: "tool", content: "a.txt\nb.txt", toolCallId: "t1", name: "bash" },
      { role: "assistant", content: "found 2 files" },
    ];
    const out = historyToBubbles(hist);
    expect(out).toEqual([
      { kind: "user", text: "list files" },
      { kind: "tool", id: "t1", name: "bash", args: '{"command":"ls"}', result: "a.txt\nb.txt", ok: true },
      { kind: "assistant", text: "found 2 files" },
    ]);
  });

  it("emits assistant text bubble alongside tool bubbles when content is non-empty", () => {
    const hist: LLMMessageWire[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "let me check",
        toolCalls: [{ id: "t1", name: "bash", arguments: "{}" }],
      },
      { role: "tool", content: "ok", toolCallId: "t1", name: "bash" },
    ];
    const out = historyToBubbles(hist);
    expect(out).toEqual([
      { kind: "user", text: "go" },
      { kind: "assistant", text: "let me check" },
      { kind: "tool", id: "t1", name: "bash", args: "{}", result: "ok", ok: true },
    ]);
  });

  it("marks tool result as failed when content starts with 'error:'", () => {
    const hist: LLMMessageWire[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tx", name: "bash", arguments: "{}" }],
      },
      { role: "tool", content: "error: nonzero exit", toolCallId: "tx", name: "bash" },
    ];
    const out = historyToBubbles(hist);
    expect(out).toHaveLength(1);
    expect((out[0] as any).ok).toBe(false);
    expect((out[0] as any).result).toBe("error: nonzero exit");
  });

  it("handles multiple tool calls in one assistant turn", () => {
    const hist: LLMMessageWire[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "read_file", arguments: '{"path":"x"}' },
          { id: "b", name: "read_file", arguments: '{"path":"y"}' },
        ],
      },
      { role: "tool", content: "X", toolCallId: "a", name: "read_file" },
      { role: "tool", content: "Y", toolCallId: "b", name: "read_file" },
    ];
    const out = historyToBubbles(hist);
    expect(out).toHaveLength(2);
    expect((out[0] as any).result).toBe("X");
    expect((out[1] as any).result).toBe("Y");
  });

  it("falls back gracefully when a tool message has no matching call (orphan)", () => {
    const hist: LLMMessageWire[] = [
      { role: "tool", content: "stranded result", toolCallId: "ghost", name: "bash" },
    ];
    const out = historyToBubbles(hist);
    expect(out).toHaveLength(1);
    expect((out[0] as any).id).toBe("ghost");
    expect((out[0] as any).result).toBe("stranded result");
    expect((out[0] as any).ok).toBe(true);
  });

  it("surfaces user-message attachments on the resulting bubble (v0.17 mathub parity)", () => {
    // The persisted JSONL keeps an `attachments:[…]` array on the user
    // message when the SPA sent files via `POST /api/uploads`. The
    // hydrator forwards that metadata onto the bubble so ChatPanel can
    // render the chip strip below the user pill on reload.
    const hist: LLMMessageWire[] = [
      {
        role: "user",
        content: "look at these\n\n[Image: diagram.png @ /tmp/uploads/abc-diagram.png]",
        attachments: [
          {
            path: "/tmp/uploads/abc-diagram.png",
            filename: "diagram.png",
            mimeType: "image/png",
          },
        ],
      },
      { role: "assistant", content: "got it" },
    ];
    const out = historyToBubbles(hist);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      kind: "user",
      text: "look at these\n\n[Image: diagram.png @ /tmp/uploads/abc-diagram.png]",
      attachments: [
        {
          path: "/tmp/uploads/abc-diagram.png",
          filename: "diagram.png",
          mimeType: "image/png",
        },
      ],
    });
  });

  it("omits the attachments field when the user message has an empty array", () => {
    // Empty arrays mean "no attachments" — the renderer wants `undefined`
    // so the chip-strip block is skipped cleanly with a single nullish check.
    const hist: LLMMessageWire[] = [
      { role: "user", content: "hi", attachments: [] },
    ];
    const out = historyToBubbles(hist);
    expect(out).toEqual([{ kind: "user", text: "hi" }]);
    expect((out[0] as any).attachments).toBeUndefined();
  });
});
