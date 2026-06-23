/**
 * Permission Profiles (C-1) — dispatch-level hard reject still beats
 * autoApprovePatterns.
 *
 * Confirms the precedence invariant from PLAN.md §1:
 *
 *     denylist > hardReject (readOnlyMode / hardRejectMutations) >
 *     autoApprovePattern > user prompt
 *
 * Specifically: a ci/review profile with `autoApprovePatterns: ["*"]` MUST
 * still hard-reject mutating tool calls at the dispatch entry point, before
 * the broker (and therefore before the pattern check) is ever consulted.
 *
 * This complements profile-integration.test.ts (which covers hard-reject in
 * isolation) and approval-broker-auto-approve.test.ts (which covers the
 * broker-level precedence) — together they pin down every cell of the matrix.
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

describe("Profile hard-reject precedence over autoApprovePatterns (C-1 §1)", () => {
  it("ci readOnlyMode still rejects write_file even when autoApprovePattern '**' would match", async () => {
    const tool = makeTool("write_file", "write");
    const llm = new ScriptedLLM(callThenStop("write_file", '{"path":"src/a.test.ts"}'));
    // A custom ci-like profile with an overly-permissive autoApprovePattern.
    // The dispatch-level hard reject must win.
    const ciProfile = resolveProfileEffects({
      ...BUILTIN_PROFILES.ci,
      autoApprovePatterns: ["**"],
    });
    const broker = new ApprovalBroker({
      policy: "never",
      autoApprovePatterns: ciProfile.autoApprovePatterns,
      resolver: allowResolver,
    });
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      profile: ciProfile,
    });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).content).toContain("read-only mode");
  });

  it("review hardRejectMutations beats autoApprovePattern '*'", async () => {
    const tool = makeTool("edit_file", "write");
    const llm = new ScriptedLLM(
      callThenStop("edit_file", '{"path":"src/x.ts","old_string":"a","new_string":"b"}'),
    );
    const reviewProfile = resolveProfileEffects({
      ...BUILTIN_PROFILES.review,
      autoApprovePatterns: ["*"], // would auto-approve everything
    });
    const broker = new ApprovalBroker({
      policy: "never",
      autoApprovePatterns: reviewProfile.autoApprovePatterns,
      resolver: allowResolver,
    });
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      profile: reviewProfile,
    });
    const events = await collect(session.send("go"));
    expect(tool.ran).toBe(0);
    const tr = events.find((e) => e.type === "tool-result");
    expect((tr as any).content).toContain("forbids mutation");
  });

  it("dev profile + autoApprovePattern lets matching writes through silently", async () => {
    // Positive control: in a dev profile (no hard reject) autoApprovePatterns
    // DO short-circuit the broker, so a matching write runs without prompting.
    const tool = makeTool("write_file", "write");
    const llm = new ScriptedLLM(callThenStop("write_file", '{"path":"src/a.test.ts"}'));
    const devProfile = resolveProfileEffects({
      ...BUILTIN_PROFILES.dev,
      autoApprovePatterns: ["src/**/*.test.ts"],
    });
    let resolverCalls = 0;
    const broker = new ApprovalBroker({
      policy: "on-request", // would normally prompt
      autoApprovePatterns: devProfile.autoApprovePatterns,
      resolver: async () => {
        resolverCalls++;
        return { outcome: "allow_once" };
      },
    });
    const session = new ChatSession({
      llm,
      tools: [tool],
      approvalBroker: broker,
      profile: devProfile,
    });
    await collect(session.send("go"));
    expect(tool.ran).toBe(1);
    expect(resolverCalls).toBe(0); // no prompt
  });
});
