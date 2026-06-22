import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatSession, type ChatEvent, type ToolSpec } from "./session.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../providers/llm.js";
import { HookInvoker } from "../hooks/executor.js";
import type { HookType, LoadedHook } from "../hooks/loader.js";

function responseOf(chunks: LLMStreamChunk[]): LLMResponse {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

class ScriptedLLM implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  private turns: LLMStreamChunk[][];
  private i = 0;
  constructor(turns: LLMStreamChunk[][]) {
    this.turns = turns;
  }
  async describe() {
    return { name: "scripted" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const turn = this.turns[this.i] ?? [{ type: "done", finishReason: "stop" }];
    this.i += 1;
    return responseOf(turn);
  }
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "session-hooks-"));
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

function invokerWith(specs: Array<{ type: HookType; body: string }>): HookInvoker {
  const dir = path.join(ws, ".mathran", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  const hooks: LoadedHook[] = specs.map(({ type, body }) => {
    const p = path.join(dir, `${type}.sh`);
    fs.writeFileSync(p, body);
    return { name: type, type, layer: "workspace" as const, path: p, allowed: false };
  });
  return new HookInvoker({ hooks, workspace: ws });
}

const echoTool: ToolSpec = {
  name: "echo",
  riskClass: "read",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { ok: true, content: "echoed" };
  },
};

describe("ChatSession — hooks integration", () => {
  it("runs post-tool after a tool call and injects its output as a system message", async () => {
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "c1", name: "echo", argsDelta: "{}" },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "all done" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const hooks = invokerWith([
      { type: "post-tool", body: "#!/bin/bash\necho \"ran for $MATHRAN_TOOL_NAME\"\n" },
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      tools: [echoTool],
      workspace: ws,
      hooks,
    });
    await collect(session.send("go"));

    expect(hooks.history.countToday("post-tool")).toBe(1);
    // The second LLM request should carry the post-tool system message.
    const sys = llm.requests[1].messages.filter((m) => m.role === "system");
    const joined = sys.map((m) => m.content).join("\n");
    expect(joined).toContain("ran for echo");
  });

  it("runs on-goal-complete when the turn finishes without tool calls", async () => {
    const llm = new ScriptedLLM([
      [
        { type: "text", delta: "answer" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const hooks = invokerWith([
      { type: "on-goal-complete", body: "#!/bin/bash\necho \"goal: $MATHRAN_GOAL_TEXT\"\n" },
    ]);
    const session = new ChatSession({ llm, model: "m", workspace: ws, hooks });
    await collect(session.send("prove it"));

    expect(hooks.history.countToday("on-goal-complete")).toBe(1);
    const last = hooks.history.last("on-goal-complete");
    expect(last?.stdoutPreview).toContain("goal: prove it");
  });

  it("does not run on-goal-complete when no such hook is configured", async () => {
    const llm = new ScriptedLLM([
      [
        { type: "text", delta: "answer" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const hooks = invokerWith([
      { type: "post-tool", body: "#!/bin/bash\necho hi\n" },
    ]);
    const session = new ChatSession({ llm, model: "m", workspace: ws, hooks });
    await collect(session.send("hello"));
    expect(hooks.history.countToday("on-goal-complete")).toBe(0);
  });
});
