import { describe, it, expect } from "vitest";
import { ChatSession, type ChatEvent, type ToolSpec } from "./session.js";
import { ApprovalBroker } from "./approval-broker.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../providers/llm.js";
import type { ApprovalDecision } from "../approval/types.js";

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
  private i = 0;
  constructor(private turns: LLMStreamChunk[][]) {}
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

/** A fake exec tool that records whether it ran. */
function makeRecordingTool(opts?: { fail?: boolean }): ToolSpec & { ran: number } {
  const tool: ToolSpec & { ran: number } = {
    name: "danger",
    riskClass: "exec",
    ran: 0,
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.ran++;
      return opts?.fail
        ? { ok: false, content: "boom" }
        : { ok: true, content: "did it" };
    },
  };
  return tool;
}

function callDangerThenStop(): LLMStreamChunk[][] {
  return [
    [
      {
        type: "tool-call",
        id: "c1",
        name: "danger",
        argsDelta: '{"command":"rm x"}',
      },
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

describe("ChatSession × approval broker", () => {
  it("denies the tool when policy asks and user denies", async () => {
    const tool = makeRecordingTool();
    const llm = new ScriptedLLM(callDangerThenStop());
    const broker = new ApprovalBroker({
      policy: "on-request",
      learning: false,
      resolver: async (): Promise<ApprovalDecision> => ({
        outcome: "deny",
        reason: "no thanks",
      }),
    });
    const session = new ChatSession({ llm, tools: [tool], approvalBroker: broker });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect(tr && (tr as any).content).toContain("denied by approval policy");
    expect(tr && (tr as any).content).toContain("no thanks");
  });

  it("runs the tool when user allows", async () => {
    const tool = makeRecordingTool();
    const llm = new ScriptedLLM(callDangerThenStop());
    const broker = new ApprovalBroker({
      policy: "on-request",
      learning: false,
      resolver: async (): Promise<ApprovalDecision> => ({ outcome: "allow_once" }),
    });
    const session = new ChatSession({ llm, tools: [tool], approvalBroker: broker });
    await collect(session.send("go"));
    expect(tool.ran).toBe(1);
  });

  it("never policy runs silently without a resolver", async () => {
    const tool = makeRecordingTool();
    const llm = new ScriptedLLM(callDangerThenStop());
    const broker = new ApprovalBroker({ policy: "never" });
    const session = new ChatSession({ llm, tools: [tool], approvalBroker: broker });
    await collect(session.send("go"));
    expect(tool.ran).toBe(1);
  });

  it("on-failure retries then abandons", async () => {
    const tool = makeRecordingTool({ fail: true });
    const llm = new ScriptedLLM(callDangerThenStop());
    let n = 0;
    const broker = new ApprovalBroker({
      policy: "on-failure",
      resolver: async (): Promise<ApprovalDecision> => {
        n++;
        return n === 1 ? { outcome: "retry" } : { outcome: "abandon", reason: "stop" };
      },
    });
    const session = new ChatSession({ llm, tools: [tool], approvalBroker: broker });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(2); // initial + one retry
    const tr = events.find((e) => e.type === "tool-result");
    expect(tr && (tr as any).content).toContain("abandoned");
  });

  it("no broker = legacy zero-approval (tool runs)", async () => {
    const tool = makeRecordingTool();
    const llm = new ScriptedLLM(callDangerThenStop());
    const session = new ChatSession({ llm, tools: [tool] });
    await collect(session.send("go"));
    expect(tool.ran).toBe(1);
  });

  it("yields approval_request + approval_resolved with a session resolver", async () => {
    const tool = makeRecordingTool();
    const llm = new ScriptedLLM(callDangerThenStop());
    const broker = new ApprovalBroker({ policy: "on-request", learning: false });
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      approvalResolver: async (): Promise<ApprovalDecision> => ({
        outcome: "allow_once",
      }),
    });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(1);
    const req = events.find((e) => e.type === "approval_request");
    const res = events.find((e) => e.type === "approval_resolved");
    expect(req).toBeTruthy();
    expect((req as any).request.tool).toBe("danger");
    expect((req as any).request.id).toBe("c1");
    expect(res).toBeTruthy();
    expect((res as any).id).toBe("c1");
    expect((res as any).decision.outcome).toBe("allow_once");
  });

  it("session resolver deny blocks the tool", async () => {
    const tool = makeRecordingTool();
    const llm = new ScriptedLLM(callDangerThenStop());
    const broker = new ApprovalBroker({ policy: "on-request", learning: false });
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      approvalResolver: async (): Promise<ApprovalDecision> => ({
        outcome: "deny",
        reason: "nope",
      }),
    });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect(tr && (tr as any).content).toContain("nope");
  });

  it("session resolver with no resolver but ask policy fails safe to deny", async () => {
    // approvalResolver set but throwing? Use broker without resolver and no
    // session resolver → broker.authorize auto-denies.
    const tool = makeRecordingTool();
    const llm = new ScriptedLLM(callDangerThenStop());
    const broker = new ApprovalBroker({ policy: "on-request", learning: false });
    const session = new ChatSession({ llm, tools: [tool], approvalBroker: broker });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect(tr && (tr as any).content).toContain("auto-denied");
  });

  it("session resolver on-failure yields failure prompts", async () => {
    const tool = makeRecordingTool({ fail: true });
    const llm = new ScriptedLLM(callDangerThenStop());
    const broker = new ApprovalBroker({ policy: "on-failure", learning: false });
    let n = 0;
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      approvalResolver: async (): Promise<ApprovalDecision> => {
        n++;
        return n === 1
          ? { outcome: "retry" }
          : { outcome: "abandon", reason: "give up" };
      },
    });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(2);
    const reqs = events.filter((e) => e.type === "approval_request");
    expect(reqs.length).toBe(2);
    expect((reqs[0] as any).request.trigger).toBe("on-failure");
  });

  it("session rule auto-approves a second call", async () => {
    const tool = makeRecordingTool();
    const llm = new ScriptedLLM([
      ...callDangerThenStop().slice(0, 1),
      [
        { type: "tool-call", id: "c2", name: "danger", argsDelta: '{"command":"rm y"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "text", delta: "done" }, { type: "done", finishReason: "stop" }],
    ]);
    let prompts = 0;
    const broker = new ApprovalBroker({
      policy: "on-request",
      learning: false,
      resolver: async (): Promise<ApprovalDecision> => {
        prompts++;
        return { outcome: "allow_session" };
      },
    });
    const session = new ChatSession({ llm, tools: [tool], approvalBroker: broker });
    await collect(session.send("go"));
    expect(tool.ran).toBe(2);
    expect(prompts).toBe(1); // second call auto-approved by session rule
  });
});
