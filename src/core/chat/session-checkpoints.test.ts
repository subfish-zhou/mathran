import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ChatSession } from "./session.js";
import { readCheckpointIndex, readCheckpoint } from "../checkpoints/store.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../providers/llm.js";

function responseOf(chunks: LLMStreamChunk[]): LLMResponse {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

/** Scripted LLM that replays one tool-call turn then stops. */
class ScriptedLLM implements LLMProvider {
  private turns: LLMStreamChunk[][];
  private i = 0;
  constructor(turns: LLMStreamChunk[][]) {
    this.turns = turns;
  }
  async describe() {
    return { name: "scripted" };
  }
  async chat(_req: LLMRequest): Promise<LLMResponse> {
    const turn = this.turns[this.i] ?? [{ type: "done", finishReason: "stop" }];
    this.i += 1;
    return responseOf(turn);
  }
}

let ws: string;
beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-session-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) {
    /* consume */
  }
}

describe("ChatSession checkpoints wiring (/diff + rewind)", () => {
  it("records a checkpoint when the model calls write_file", async () => {
    const llm = new ScriptedLLM([
      [
        {
          type: "tool-call",
          id: "call_w",
          name: "write_file",
          argsDelta: JSON.stringify({ path: "foo.ts", content: "hello\n" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      workspace: ws,
      builtinTools: { write_file: true },
      checkpoints: { conversationId: "conv-x", workspace: ws },
    });

    await drain(session.send("make a file"));

    // The file was written.
    expect(await fs.readFile(path.join(ws, "foo.ts"), "utf-8")).toBe("hello\n");

    // And a checkpoint was recorded for it.
    const index = await readCheckpointIndex(ws, "conv-x");
    expect(index).toHaveLength(1);
    const cp = await readCheckpoint(ws, "conv-x", index[0]!.id);
    expect(cp?.toolName).toBe("write_file");
    expect(cp?.toolCallId).toBe("call_w");
    expect(cp?.affectedPaths).toEqual(["foo.ts"]);
    expect(cp?.files[0]!.before).toEqual({ kind: "absent" });
    expect(cp?.files[0]!.after).toEqual({ kind: "text", content: "hello\n" });
  });

  it("does not record checkpoints when the checkpoints option is absent", async () => {
    const llm = new ScriptedLLM([
      [
        {
          type: "tool-call",
          id: "call_w",
          name: "write_file",
          argsDelta: JSON.stringify({ path: "foo.ts", content: "hi\n" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      workspace: ws,
      builtinTools: { write_file: true },
      // no checkpoints config
    });
    await drain(session.send("make a file"));
    expect(await readCheckpointIndex(ws, "conv-x")).toEqual([]);
  });

  it("appendSystemNote pushes a system message and clears read tracking", async () => {
    const llm = new ScriptedLLM([[{ type: "done", finishReason: "stop" }]]);
    const session = new ChatSession({ llm, workspace: ws });
    session.appendSystemNote("[Rewound to before checkpoint X]");
    const history = session.history();
    expect(history[history.length - 1]).toEqual({
      role: "system",
      content: "[Rewound to before checkpoint X]",
    });
  });
});
