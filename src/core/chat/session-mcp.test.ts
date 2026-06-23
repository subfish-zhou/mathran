import { describe, it, expect } from "vitest";
import { ChatSession, type ToolSpec } from "./session.js";
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

/** Scripted LLM recording the requests it receives (to inspect the toolset). */
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

function fakeRegistry(specs: ToolSpec[]): { toolSpecs(): ToolSpec[] } {
  return { toolSpecs: () => specs };
}

const readSpec = (onCall?: (args: Record<string, unknown>) => void): ToolSpec => ({
  name: "mcp__fs__read_file",
  riskClass: "exec",
  description: "[MCP:fs] read",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  async execute(args) {
    onCall?.(args);
    return { ok: true, content: "file-contents" };
  },
});

describe("ChatSession + MCP registry", () => {
  it("advertises injected MCP tools to the LLM request", async () => {
    const llm = new ScriptedLLM([[{ type: "done", finishReason: "stop" }]]);
    const session = new ChatSession({ llm, mcpRegistry: fakeRegistry([readSpec()]) });
    for await (const _ of session.send("hi")) void _;
    const tools = llm.requests[0].tools ?? [];
    expect(tools.map((t) => t.name)).toContain("mcp__fs__read_file");
  });

  it("dispatches an MCP tool call back through the registry spec", async () => {
    let seen: Record<string, unknown> | null = null;
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "c1", name: "mcp__fs__read_file", argsDelta: '{"path":"a.txt"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      mcpRegistry: fakeRegistry([readSpec((args) => (seen = args))]),
    });
    const results: string[] = [];
    for await (const ev of session.send("read a.txt")) {
      if (ev.type === "tool-result") results.push(ev.content);
    }
    expect(seen).toEqual({ path: "a.txt" });
    expect(results.join("\n")).toContain("file-contents");
  });

  it("is purely additive when the registry is absent", async () => {
    const llm = new ScriptedLLM([[{ type: "done", finishReason: "stop" }]]);
    const session = new ChatSession({ llm });
    for await (const _ of session.send("hi")) void _;
    const tools = llm.requests[0].tools ?? [];
    expect(tools.some((t) => t.name.startsWith("mcp__"))).toBe(false);
  });
});
