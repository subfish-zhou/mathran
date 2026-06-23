/**
 * Permission Profiles (#2) — ChatSession dispatch-level hard reject integration.
 *
 * Verifies the profile enforcement that lives at the tool-dispatch entry point
 * (BEFORE the approval broker, so the user cannot override it):
 *   - ci  (readOnlyMode)        → mutating tools rejected "read-only mode".
 *   - review (hardRejectMutations) → mutating tools rejected even with policy
 *                                    `never` + an allow resolver.
 *   - dev (neither)             → mutating tools run.
 *   - denylistTools             → named tool blocked.
 *   - read tools always pass.
 */

import { describe, it, expect } from "vitest";
import { ChatSession, type ChatEvent, type ToolSpec } from "../../chat/session.js";
import { ApprovalBroker } from "../../chat/approval-broker.js";
import { resolveProfileEffects } from "../profile-resolver.js";
import { BUILTIN_PROFILES } from "../builtin-profiles.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";
import type { RiskClass, ApprovalDecision } from "../../approval/types.js";

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
  private i = 0;
  constructor(private turns: LLMStreamChunk[][]) {}
  async describe() {
    return { name: "scripted" };
  }
  async chat(_req: LLMRequest): Promise<LLMResponse> {
    const turn = this.turns[this.i] ?? [{ type: "done", finishReason: "stop" }];
    this.i += 1;
    return responseOf(turn);
  }
}

function makeTool(
  name: string,
  riskClass: RiskClass,
): ToolSpec & { ran: number } {
  const tool: ToolSpec & { ran: number } = {
    name,
    riskClass,
    ran: 0,
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.ran++;
      return { ok: true, content: "did it" };
    },
  };
  return tool;
}

function callThenStop(name: string, args: string): LLMStreamChunk[][] {
  return [
    [
      { type: "tool-call", id: "c1", name, argsDelta: args },
      { type: "done", finishReason: "tool_calls" },
    ],
    [
      { type: "text", delta: "ok" },
      { type: "done", finishReason: "stop" },
    ],
  ];
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

const allowResolver = async (): Promise<ApprovalDecision> => ({
  outcome: "allow_once",
});

describe("ChatSession × permission profile (hard reject)", () => {
  it("ci read-only mode rejects write_file before the broker", async () => {
    const tool = makeTool("write_file", "write");
    const llm = new ScriptedLLM(callThenStop("write_file", '{"path":"a.txt"}'));
    const broker = new ApprovalBroker({ policy: "never", resolver: allowResolver });
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      profile: resolveProfileEffects(BUILTIN_PROFILES.ci),
    });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).content).toContain("read-only mode");
  });

  it("review hard-rejects mutations even with policy never + allow resolver", async () => {
    const tool = makeTool("write_file", "write");
    const llm = new ScriptedLLM(callThenStop("write_file", '{"path":"a.txt"}'));
    // Even though policy is never (would auto-pass) and a resolver would allow,
    // the dispatch-level hard reject wins.
    const broker = new ApprovalBroker({ policy: "never", resolver: allowResolver });
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      profile: resolveProfileEffects(BUILTIN_PROFILES.review),
    });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).content).toContain("forbids mutation");
  });

  it("dev profile lets writes run", async () => {
    const tool = makeTool("write_file", "write");
    const llm = new ScriptedLLM(callThenStop("write_file", '{"path":"a.txt"}'));
    const broker = new ApprovalBroker({ policy: "never" });
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      profile: resolveProfileEffects(BUILTIN_PROFILES.dev),
    });
    await collect(session.send("go"));
    expect(tool.ran).toBe(1);
  });

  it("ci read-only mode still allows read tools", async () => {
    const tool = makeTool("read_file", "read");
    const llm = new ScriptedLLM(callThenStop("read_file", '{"path":"a.txt"}'));
    const broker = new ApprovalBroker({ policy: "never" });
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      profile: resolveProfileEffects(BUILTIN_PROFILES.ci),
    });
    await collect(session.send("go"));
    expect(tool.ran).toBe(1);
  });

  it("ci read-only mode allows read-only shell commands but blocks mutating ones", async () => {
    const readTool = makeTool("bash", "exec");
    const llm1 = new ScriptedLLM(callThenStop("bash", '{"command":"ls -la"}'));
    const s1 = new ChatSession({
      llm: llm1,
      tools: [readTool],
      approvalBroker: new ApprovalBroker({ policy: "never" }),
      profile: resolveProfileEffects(BUILTIN_PROFILES.ci),
    });
    await collect(s1.send("go"));
    expect(readTool.ran).toBe(1);

    const writeTool = makeTool("bash", "exec");
    const llm2 = new ScriptedLLM(callThenStop("bash", '{"command":"rm -rf x"}'));
    const s2 = new ChatSession({
      llm: llm2,
      tools: [writeTool],
      approvalBroker: new ApprovalBroker({ policy: "never" }),
      profile: resolveProfileEffects(BUILTIN_PROFILES.ci),
    });
    const events = await collect(s2.send("go"));
    expect(writeTool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).content).toContain("read-only mode");
  });

  it("denylistTools blocks a named tool", async () => {
    const tool = makeTool("read_file", "read");
    const llm = new ScriptedLLM(callThenStop("read_file", '{"path":"a.txt"}'));
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: new ApprovalBroker({ policy: "never" }),
      profile: resolveProfileEffects({ name: "custom", denylistTools: ["read_file"] }),
    });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).content).toContain("blocked by permission profile");
  });

  it("injects a profile banner system message", () => {
    const llm = new ScriptedLLM([]);
    const session = new ChatSession({
      llm,
      tools: [],
      profile: resolveProfileEffects(BUILTIN_PROFILES.ci),
    });
    const sys = session.history().filter((m) => m.role === "system");
    expect(sys.some((m) => (m.content ?? "").includes("Active permission profile: ci"))).toBe(true);
  });
});
