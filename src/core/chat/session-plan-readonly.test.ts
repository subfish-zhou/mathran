/**
 * Plan-mode read-only ENFORCEMENT tests (Hardening 2026-06-30).
 *
 * Companion to `session-plan-mode.test.ts`. The original test file proves
 * the gate machinery exists (flag flips, readOnly tools pass, mutating
 * tools error). This file proves the *contract* the LLM sees when it
 * tries to violate plan mode:
 *
 *   • Hard rejection — mutating tools (write_file, edit_file, bash,
 *     run_python, run_latex, dispatch_subagent, propose_goal,
 *     propose_plan) MUST NOT execute their `execute()` body while plan
 *     mode is active. The dispatcher refuses BEFORE the tool runs.
 *   • Uniform error envelope — every refusal surfaces as
 *     `{ ok: false, content: "refused in plan mode: '<name>' is a
 *     mutating tool. Use 'complete_plan' to exit plan mode first, or
 *     call read-only tools (search/read_file/grep/glob) for
 *     investigation." }`. The LLM gets one consistent shape it can
 *     pattern-match.
 *   • Meta-tool whitelist — `complete_plan`, `enter_plan_mode`,
 *     `ask_user`, `todo_write` execute normally in plan mode even though
 *     `todo_write` is classified `readOnly: false`. The whitelist is
 *     the documented escape valve for in-flight bookkeeping.
 *   • Read-only tools — `read_file`, `grep`, `glob`, and arbitrary
 *     custom tools with `readOnly: true` are unaffected.
 *   • Lifecycle — `complete_plan` flips the gate off; the SAME session
 *     can then call write_file successfully in the next round.
 *
 * No real LLM is in the loop — `ScriptedLLM` drives each tool call from
 * a pre-recorded chunk script (mirrors `session-plan-mode.test.ts` and
 * `session-approval.test.ts`). This keeps the test deterministic and
 * fast: we exercise the dispatcher branch, not the provider plumbing.
 */

import { describe, it, expect } from "vitest";
import { ChatSession, type ChatEvent, type ToolSpec } from "./session.js";
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

// ─────────────────────────────────────────────────────────────────────────
// Test scaffolding (mirrors session-plan-mode.test.ts)
// ─────────────────────────────────────────────────────────────────────────

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

/** One LLM turn that fires `name` with the given args, then a no-op
 *  follow-up turn that lets the loop exit cleanly after the tool
 *  result lands. */
function callToolThenStop(name: string, args = "{}"): LLMStreamChunk[][] {
  return [
    [
      { type: "tool-call", id: `c_${name}`, name, argsDelta: args },
      { type: "done", finishReason: "tool_calls" },
    ],
    [
      { type: "text", delta: "ok" },
      { type: "done", finishReason: "stop" },
    ],
  ];
}

/** Two-step LLM script: turn-1 calls `firstName`, turn-2 calls
 *  `secondName`, turn-3 stops. Models the "enter -> action" or
 *  "complete -> action" lifecycle scenarios. */
function callTwoToolsThenStop(
  firstName: string,
  firstArgs: string,
  secondName: string,
  secondArgs: string,
): LLMStreamChunk[][] {
  return [
    [
      { type: "tool-call", id: `c_${firstName}`, name: firstName, argsDelta: firstArgs },
      { type: "done", finishReason: "tool_calls" },
    ],
    [
      { type: "tool-call", id: `c_${secondName}`, name: secondName, argsDelta: secondArgs },
      { type: "done", finishReason: "tool_calls" },
    ],
    [
      { type: "text", delta: "done" },
      { type: "done", finishReason: "stop" },
    ],
  ];
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Tool builders for each scenario
// ─────────────────────────────────────────────────────────────────────────

interface InstrumentedTool extends ToolSpec {
  ran: number;
}

/** Build a write-style tool (riskClass=write, readOnly=false) named
 *  `name`. Records the number of times `execute` ran in `tool.ran`. */
function makeWriteTool(name: string): InstrumentedTool {
  const tool: InstrumentedTool = {
    name,
    riskClass: "write",
    readOnly: false,
    ran: 0,
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.ran++;
      return { ok: true, content: `${name} ran` };
    },
  };
  return tool;
}

/** Build an exec-style tool (riskClass=exec, readOnly=false). */
function makeExecTool(name: string): InstrumentedTool {
  const tool: InstrumentedTool = {
    name,
    riskClass: "exec",
    readOnly: false,
    ran: 0,
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.ran++;
      return { ok: true, content: `${name} ran` };
    },
  };
  return tool;
}

/** Build a read-only tool (riskClass=read, readOnly=true). */
function makeReadTool(name: string): InstrumentedTool {
  const tool: InstrumentedTool = {
    name,
    riskClass: "read",
    readOnly: true,
    ran: 0,
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.ran++;
      return { ok: true, content: `${name} ok` };
    },
  };
  return tool;
}

/** Build a meta-tool with the EXACT NAME of a whitelisted entry
 *  (`todo_write`, `ask_user`, etc.) but readOnly=false, so we can
 *  verify the name-whitelist branch independently of the readOnly
 *  branch. */
function makeWhitelistedMetaTool(name: string): InstrumentedTool {
  const tool: InstrumentedTool = {
    name,
    riskClass: "write",
    readOnly: false,
    ran: 0,
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.ran++;
      return { ok: true, content: `${name} ran` };
    },
  };
  return tool;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe("ChatSession × plan-mode hardening (read-only enforcement)", () => {
  // ─── A. Hard rejection of every mutating tool category ───────────────

  it.each([
    "write_file",
    "edit_file",
    "bash",
    "run_python",
    "run_latex",
    "dispatch_subagent",
    "propose_goal",
    "propose_plan",
  ])(
    "hard-rejects mutating tool '%s' while in plan mode (execute() NEVER runs)",
    async (mutatingName) => {
      const tool = makeWriteTool(mutatingName);
      const llm = new ScriptedLLM(callToolThenStop(mutatingName));
      const session = new ChatSession({ llm, tools: [tool] });
      session.enablePlanMode();

      const events = await collect(session.send("go"));

      // CRITICAL invariant: execute() never ran.
      expect(tool.ran).toBe(0);

      const tr = events.find((e) => e.type === "tool-result");
      expect(tr).toBeTruthy();
      expect((tr as any).ok).toBe(false);
      expect((tr as any).name).toBe(mutatingName);

      // Uniform error envelope contract.
      const content = (tr as any).content as string;
      expect(content).toContain("refused in plan mode");
      expect(content).toContain(`'${mutatingName}'`);
      expect(content).toContain("mutating tool");
      expect(content).toContain("complete_plan");
      // The recovery hint MUST point the LLM at read-only investigation
      // tools so it knows what's still available without re-reading the
      // tool catalog.
      expect(content).toContain("read-only");
    },
  );

  // ─── B. Read-only tools STILL run while in plan mode ─────────────────

  it.each(["read_file", "grep", "glob"])(
    "allows read-only tool '%s' to run while in plan mode",
    async (readName) => {
      const tool = makeReadTool(readName);
      const llm = new ScriptedLLM(callToolThenStop(readName));
      const session = new ChatSession({ llm, tools: [tool] });
      session.enablePlanMode();

      const events = await collect(session.send("go"));

      expect(tool.ran).toBe(1);
      const tr = events.find((e) => e.type === "tool-result");
      expect((tr as any).ok).toBe(true);
      expect((tr as any).content).toBe(`${readName} ok`);
    },
  );

  // ─── C. Meta-tool whitelist ──────────────────────────────────────────

  it("whitelists 'todo_write' in plan mode even though it's readOnly:false", async () => {
    // todo_write is classified `readOnly: false` because it writes a
    // JSON file under .mathran/todos/, but that file is conversation
    // scratch state — letting the model maintain its in-flight plan
    // list is the whole point of plan mode.
    const tool = makeWhitelistedMetaTool("todo_write");
    const llm = new ScriptedLLM(callToolThenStop("todo_write"));
    const session = new ChatSession({ llm, tools: [tool] });
    session.enablePlanMode();

    const events = await collect(session.send("go"));

    expect(tool.ran).toBe(1);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(true);
    expect((tr as any).content).toBe("todo_write ran");
  });

  it("whitelists 'ask_user' in plan mode even when injected with readOnly:false", async () => {
    // The real ask_user tool ships with readOnly:true, but the name
    // whitelist is the policy guarantee: even if a future refactor
    // forgets to flag it, plan mode still lets it through.
    const tool = makeWhitelistedMetaTool("ask_user");
    const llm = new ScriptedLLM(callToolThenStop("ask_user"));
    const session = new ChatSession({ llm, tools: [tool] });
    session.enablePlanMode();

    const events = await collect(session.send("go"));

    expect(tool.ran).toBe(1);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(true);
  });

  it("rejects identically-named tools that are NOT on the whitelist", async () => {
    // Sanity check the whitelist is a strict allow-list, not a prefix
    // match. `todo_writer` (note the trailing 'r') must still be
    // blocked.
    const tool = makeWriteTool("todo_writer");
    const llm = new ScriptedLLM(callToolThenStop("todo_writer"));
    const session = new ChatSession({ llm, tools: [tool] });
    session.enablePlanMode();

    const events = await collect(session.send("go"));

    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(false);
    expect((tr as any).content).toContain("refused in plan mode");
  });

  // ─── D. enter_plan_mode + complete_plan toggle tools always work ─────

  it("'complete_plan' (built-in) is always callable in plan mode (escape hatch)", async () => {
    const llm = new ScriptedLLM(
      callToolThenStop("complete_plan", JSON.stringify({ summary: "done planning" })),
    );
    const session = new ChatSession({
      llm,
      tools: [],
      builtinTools: { plan_mode: true },
    });
    session.enablePlanMode();
    expect(session.isPlanMode()).toBe(true);

    const events = await collect(session.send("go"));

    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(true);
    // complete_plan flipped the flag off.
    expect(session.isPlanMode()).toBe(false);
  });

  it("'enter_plan_mode' is idempotent and itself always allowed", async () => {
    const llm = new ScriptedLLM(
      callToolThenStop(
        "enter_plan_mode",
        JSON.stringify({ objective: "re-enter" }),
      ),
    );
    const session = new ChatSession({
      llm,
      tools: [],
      builtinTools: { plan_mode: true },
    });
    session.enablePlanMode(); // already in plan mode

    const events = await collect(session.send("go"));

    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(true);
    expect(session.isPlanMode()).toBe(true);
  });

  // ─── E. Lifecycle — complete_plan unblocks subsequent writes ─────────

  it("after complete_plan, mutating tools run normally on the SAME session", async () => {
    // Round 1: complete_plan flips off. Round 2: write_file runs normally.
    const writeTool = makeWriteTool("write_file");
    const llm = new ScriptedLLM(
      callTwoToolsThenStop(
        "complete_plan",
        JSON.stringify({ summary: "plan summary" }),
        "write_file",
        "{}",
      ),
    );
    const session = new ChatSession({
      llm,
      tools: [writeTool],
      builtinTools: { plan_mode: true },
    });
    session.enablePlanMode();
    expect(session.isPlanMode()).toBe(true);

    const events = await collect(session.send("go"));

    expect(session.isPlanMode()).toBe(false);
    expect(writeTool.ran).toBe(1);

    // Both tool-results should be ok:true (no rejection on either).
    const trs = events.filter((e) => e.type === "tool-result");
    expect(trs.length).toBe(2);
    expect((trs[0] as any).name).toBe("complete_plan");
    expect((trs[0] as any).ok).toBe(true);
    expect((trs[1] as any).name).toBe("write_file");
    expect((trs[1] as any).ok).toBe(true);
  });

  it("BEFORE complete_plan, the same write_file call IS rejected", async () => {
    // Mirror of the previous test without the complete_plan first — to
    // pin down that ordering (not session identity) is what unblocks
    // the write.
    const writeTool = makeWriteTool("write_file");
    const llm = new ScriptedLLM(callToolThenStop("write_file"));
    const session = new ChatSession({
      llm,
      tools: [writeTool],
      builtinTools: { plan_mode: true },
    });
    session.enablePlanMode();

    const events = await collect(session.send("go"));

    expect(session.isPlanMode()).toBe(true);
    expect(writeTool.ran).toBe(0);

    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(false);
    expect((tr as any).content).toContain("refused in plan mode");
  });

  // ─── F. Plan-mode OFF default — no gating ────────────────────────────

  it("plan mode OFF: write_file runs as normal (no gate)", async () => {
    const writeTool = makeWriteTool("write_file");
    const llm = new ScriptedLLM(callToolThenStop("write_file"));
    const session = new ChatSession({ llm, tools: [writeTool] });
    expect(session.isPlanMode()).toBe(false);

    const events = await collect(session.send("go"));

    expect(writeTool.ran).toBe(1);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(true);
  });

  // ─── G. enter_plan_mode tool note carries the restriction reminder ───

  it("enter_plan_mode tool note explicitly names the blocked tools", async () => {
    // The "note" field is the in-conversation system-reminder fragment
    // the LLM sees inline with its tool result. It MUST name the major
    // mutating tools so the model knows the cost of staying in plan
    // mode without needing to re-read the tool catalog.
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
    expect(parsed.note).toContain("write_file");
    expect(parsed.note).toContain("edit_file");
    expect(parsed.note).toContain("bash");
    expect(parsed.note).toContain("complete_plan");
    // Whitelisted meta-tools should be advertised too so the model
    // knows todo_write is still on the table.
    expect(parsed.note).toContain("todo_write");
  });

  // ─── H. isPlanMode() getter accuracy (host / SPA contract) ───────────

  it("isPlanMode() reflects the live flag for host inspection", () => {
    const llm = new ScriptedLLM([[{ type: "done", finishReason: "stop" }]]);
    const session = new ChatSession({ llm, tools: [] });
    expect(session.isPlanMode()).toBe(false);
    session.enablePlanMode();
    expect(session.isPlanMode()).toBe(true);
    session.disablePlanMode();
    expect(session.isPlanMode()).toBe(false);
  });

  // ─── I. Real enter_plan_mode + complete_plan tool flow ───────────────

  it("real built-in enter_plan_mode flips the gate so subsequent write_file is refused", async () => {
    // End-to-end: register the real enter_plan_mode tool, fire it via
    // the LLM, then fire write_file in the next round. The write call
    // must be refused.
    const writeTool = makeWriteTool("write_file");
    const llm = new ScriptedLLM(
      callTwoToolsThenStop(
        "enter_plan_mode",
        JSON.stringify({ objective: "investigate first" }),
        "write_file",
        "{}",
      ),
    );
    const session = new ChatSession({
      llm,
      tools: [writeTool],
      builtinTools: { plan_mode: true },
    });

    const events = await collect(session.send("go"));

    expect(session.isPlanMode()).toBe(true);
    expect(writeTool.ran).toBe(0);

    const trs = events.filter((e) => e.type === "tool-result");
    expect(trs.length).toBe(2);
    expect((trs[0] as any).name).toBe("enter_plan_mode");
    expect((trs[0] as any).ok).toBe(true);
    expect((trs[1] as any).name).toBe("write_file");
    expect((trs[1] as any).ok).toBe(false);
    expect((trs[1] as any).content).toContain("refused in plan mode");
  });

  // ─── J. Direct toggle (no built-in tools) still gates correctly ──────

  it("direct session.enablePlanMode() (no built-in plan_mode tools) still gates writes", async () => {
    // Hosts can flip plan mode directly (e.g. via a `/plan` slash
    // command) without registering enter_plan_mode / complete_plan.
    // The dispatcher gate must still fire.
    const writeTool = makeWriteTool("edit_file");
    const llm = new ScriptedLLM(callToolThenStop("edit_file"));
    const session = new ChatSession({
      llm,
      tools: [writeTool],
      // builtinTools.plan_mode intentionally NOT set
    });
    session.enablePlanMode();

    const events = await collect(session.send("go"));

    expect(writeTool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(false);
    expect((tr as any).content).toContain("refused in plan mode");
  });

  // ─── K. exec-class tools blocked too (not just write-class) ──────────

  it("exec-class tools (riskClass='exec') are refused in plan mode same as write-class", async () => {
    // The gate is based on readOnly + whitelist, not riskClass. A
    // riskClass='exec' tool without readOnly:true MUST be refused.
    const tool = makeExecTool("custom_runner");
    const llm = new ScriptedLLM(callToolThenStop("custom_runner"));
    const session = new ChatSession({ llm, tools: [tool] });
    session.enablePlanMode();

    const events = await collect(session.send("go"));

    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).ok).toBe(false);
    expect((tr as any).content).toContain("refused in plan mode");
    expect((tr as any).content).toContain("custom_runner");
  });

  // ─── L. complete_plan tool factory disablePlanMode behaviour ─────────

  it("createCompletePlanTool: empty summary rejects without flipping the flag", async () => {
    let disabledCount = 0;
    const tool = createCompletePlanTool({
      enablePlanMode: () => {},
      disablePlanMode: () => {
        disabledCount++;
      },
    });
    const r = await tool.execute({ summary: "" });
    expect(r.ok).toBe(false);
    expect(disabledCount).toBe(0);
  });
});
