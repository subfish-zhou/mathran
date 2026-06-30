/**
 * Part B1 commit 4 — ChatSession plan-mode tests.
 *
 * Exercises the dispatcher gate from commit 2 plus the chat-level toggle
 * tools from commit 3. We don't go through a real LLM here; we drive
 * `executeWithApproval` via the public `send()` path with a scripted
 * provider, mirroring the existing session-approval.test.ts style.
 *
 * Coverage targets:
 *   1. planMode default false; isPlanMode reports it.
 *   2. enablePlanMode flips the flag; disablePlanMode flips it back.
 *   3. enter_plan_mode tool exists when builtinTools.plan_mode=true.
 *   4. complete_plan tool exists when builtinTools.plan_mode=true.
 *   5. enter_plan_mode.execute flips the session flag.
 *   6. complete_plan.execute flips the session flag back.
 *   7. While planMode=true, calling a non-readOnly tool yields an
 *      ok:false tool-result with the "refused in plan mode" prefix.
 *   8. While planMode=true, a readOnly tool runs normally.
 *   9. planMode=false default: any tool runs (no gate).
 *  10. The plan-mode toggle tools are themselves readOnly so they can
 *      execute WHILE planMode=true (escape hatch).
 *  11. enter_plan_mode requires non-empty objective; rejects empty.
 *  12. complete_plan requires non-empty summary; rejects empty.
 */

import { describe, it, expect } from "vitest";
import {
  ChatSession,
  PlanModeBlockedError,
  type ChatEvent,
  type ToolSpec,
} from "./session.js";
import {
  createCompletePlanTool,
  createEnterPlanModeTool,
} from "./tools/plan-mode-tools.js";
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

function callToolThenStop(name: string, args = "{}"): LLMStreamChunk[][] {
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

function makeWriteTool(): ToolSpec & { ran: number } {
  const tool: ToolSpec & { ran: number } = {
    name: "mutating",
    riskClass: "write",
    readOnly: false,
    ran: 0,
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.ran++;
      return { ok: true, content: "wrote" };
    },
  };
  return tool;
}

function makeReadTool(): ToolSpec & { ran: number } {
  const tool: ToolSpec & { ran: number } = {
    name: "readonly_thing",
    riskClass: "read",
    readOnly: true,
    ran: 0,
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.ran++;
      return { ok: true, content: "read" };
    },
  };
  return tool;
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("ChatSession × plan mode", () => {
  it("(1) default planMode is false; isPlanMode reports it", () => {
    const llm = new ScriptedLLM([[{ type: "done", finishReason: "stop" }]]);
    const session = new ChatSession({ llm, tools: [] });
    expect(session.isPlanMode()).toBe(false);
  });

  it("(2) enablePlanMode flips on; disablePlanMode flips off (idempotent)", () => {
    const llm = new ScriptedLLM([[{ type: "done", finishReason: "stop" }]]);
    const session = new ChatSession({ llm, tools: [] });
    session.enablePlanMode();
    expect(session.isPlanMode()).toBe(true);
    session.enablePlanMode(); // idempotent
    expect(session.isPlanMode()).toBe(true);
    session.disablePlanMode();
    expect(session.isPlanMode()).toBe(false);
    session.disablePlanMode(); // idempotent
    expect(session.isPlanMode()).toBe(false);
  });

  it("(3+4) builtinTools.plan_mode registers both enter_plan_mode + complete_plan", async () => {
    const llm = new ScriptedLLM([[{ type: "done", finishReason: "stop" }]]);
    const session = new ChatSession({
      llm,
      tools: [],
      builtinTools: { plan_mode: true },
    });
    // Internal access is tested via tool dispatch: ask the LLM to call
    // each tool and verify it executed (rather than poking private fields).
    // Here we directly inspect the public LLMRequest the kernel would send
    // by intercepting via .listTools() if exposed; fall back to using
    // executeTool dispatch through send() in the dedicated tests below.
    // For now, sanity-check the kernel didn't throw at construction.
    expect(session).toBeDefined();
    // Confirm executing those names through send() works (=> registered).
    const llm2 = new ScriptedLLM(callToolThenStop("enter_plan_mode", JSON.stringify({ objective: "think first" })));
    const s2 = new ChatSession({
      llm: llm2,
      tools: [],
      builtinTools: { plan_mode: true },
    });
    const events = await collect(s2.send("go"));
    const tr = events.find((e) => e.type === "tool-result");
    expect(tr).toBeTruthy();
    expect((tr as any).ok).toBe(true);
    expect((tr as any).content).toContain("plan");
    expect(s2.isPlanMode()).toBe(true);

    const llm3 = new ScriptedLLM(callToolThenStop("complete_plan", JSON.stringify({ summary: "did it" })));
    const s3 = new ChatSession({
      llm: llm3,
      tools: [],
      builtinTools: { plan_mode: true },
    });
    s3.enablePlanMode();
    const e3 = await collect(s3.send("go"));
    const tr3 = e3.find((e) => e.type === "tool-result");
    expect((tr3 as any).ok).toBe(true);
    expect(s3.isPlanMode()).toBe(false);
  });

  it("(5) enter_plan_mode.execute flips the session flag", async () => {
    let enabled = false;
    const tool = createEnterPlanModeTool({
      enablePlanMode: () => {
        enabled = true;
      },
      disablePlanMode: () => {
        enabled = false;
      },
    });
    const r = await tool.execute({ objective: "plan stuff" });
    expect(r.ok).toBe(true);
    expect(enabled).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.mode).toBe("plan");
    expect(parsed.objective).toBe("plan stuff");
  });

  it("(6) complete_plan.execute flips the session flag back", async () => {
    let enabled = true;
    const tool = createCompletePlanTool({
      enablePlanMode: () => {
        enabled = true;
      },
      disablePlanMode: () => {
        enabled = false;
      },
    });
    const r = await tool.execute({ summary: "final plan" });
    expect(r.ok).toBe(true);
    expect(enabled).toBe(false);
    const parsed = JSON.parse(r.content);
    expect(parsed.mode).toBe("normal");
    expect(parsed.summary).toBe("final plan");
  });

  it("(7) blocks non-readOnly tool calls while planMode=true (ok:false tool-result)", async () => {
    const tool = makeWriteTool();
    const llm = new ScriptedLLM(callToolThenStop("mutating"));
    const session = new ChatSession({ llm, tools: [tool] });
    session.enablePlanMode();
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect(tr).toBeTruthy();
    expect((tr as any).ok).toBe(false);
    expect((tr as any).content).toContain("refused in plan mode");
    expect((tr as any).content).toContain("mutating");
  });

  it("(8) allows readOnly tool calls while planMode=true", async () => {
    const tool = makeReadTool();
    const llm = new ScriptedLLM(callToolThenStop("readonly_thing"));
    const session = new ChatSession({ llm, tools: [tool] });
    session.enablePlanMode();
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(1);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(true);
    expect((tr as any).content).toBe("read");
  });

  it("(9) planMode=false default: mutating tools run with no gate", async () => {
    const tool = makeWriteTool();
    const llm = new ScriptedLLM(callToolThenStop("mutating"));
    const session = new ChatSession({ llm, tools: [tool] });
    expect(session.isPlanMode()).toBe(false);
    await collect(session.send("go"));
    expect(tool.ran).toBe(1);
  });

  it("(10) plan-mode toggle tools are themselves readOnly (escape hatch)", () => {
    const enter = createEnterPlanModeTool({
      enablePlanMode: () => {},
      disablePlanMode: () => {},
    });
    const complete = createCompletePlanTool({
      enablePlanMode: () => {},
      disablePlanMode: () => {},
    });
    expect(enter.readOnly).toBe(true);
    expect(complete.readOnly).toBe(true);
    // riskClass should be 'read' so the approval broker treats them as
    // the most-permissive bucket too.
    expect(enter.riskClass).toBe("read");
    expect(complete.riskClass).toBe("read");
  });

  it("(11) enter_plan_mode rejects empty objective", async () => {
    let enabled = false;
    const tool = createEnterPlanModeTool({
      enablePlanMode: () => {
        enabled = true;
      },
      disablePlanMode: () => {},
    });
    const r1 = await tool.execute({ objective: "" });
    expect(r1.ok).toBe(false);
    expect(r1.content).toContain("non-empty 'objective'");
    expect(enabled).toBe(false);
    const r2 = await tool.execute({ objective: "   " });
    expect(r2.ok).toBe(false);
    expect(enabled).toBe(false);
    const r3 = await tool.execute({});
    expect(r3.ok).toBe(false);
    expect(enabled).toBe(false);
  });

  it("(12) complete_plan rejects empty summary", async () => {
    let disabled = false;
    const tool = createCompletePlanTool({
      enablePlanMode: () => {},
      disablePlanMode: () => {
        disabled = true;
      },
    });
    const r1 = await tool.execute({ summary: "" });
    expect(r1.ok).toBe(false);
    expect(r1.content).toContain("non-empty 'summary'");
    expect(disabled).toBe(false);
    const r2 = await tool.execute({});
    expect(r2.ok).toBe(false);
    expect(disabled).toBe(false);
  });

  it("(bonus) PlanModeBlockedError carries the tool name", () => {
    const err = new PlanModeBlockedError("write_file");
    expect(err).toBeInstanceOf(Error);
    expect(err.toolName).toBe("write_file");
    expect(err.message).toContain("write_file");
    expect(err.message).toContain("refused in plan mode");
    expect(err.name).toBe("PlanModeBlockedError");
  });

  it("(bonus) mutating tool with NO readOnly field is treated as mutating (conservative default)", async () => {
    // ToolSpec without `readOnly` should still be blocked in plan mode.
    const tool: ToolSpec = {
      name: "legacy_unknown",
      riskClass: "exec",
      // readOnly intentionally omitted
      parameters: { type: "object", properties: {} },
      async execute() {
        return { ok: true, content: "ran" };
      },
    };
    const llm = new ScriptedLLM(callToolThenStop("legacy_unknown"));
    const session = new ChatSession({ llm, tools: [tool] });
    session.enablePlanMode();
    const events = await collect(session.send("go"));
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(false);
    expect((tr as any).content).toContain("refused in plan mode");
  });
});
