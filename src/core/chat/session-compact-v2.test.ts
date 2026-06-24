/**
 * Tests for ChatSession.compactV2 / maybeAutoCompactMidTurn — TODO-2 §9.1 / C6.
 *
 * Covers the V2 entry plumbed through ChatSession:
 *   - compactV2 invokes pickStrategy + ensureBuiltInsRegistered
 *   - phase → policy mapping via injectionPolicyForPhase
 *   - swap on ok=true / NO swap on ok=false (PreCompact stopped)
 *   - PreCompact hook outcome handling (stopped → status=skipped)
 *   - mid-turn cumulative reset on send() entry + after successful compact
 *   - second concurrent compactV2 awaits the first (dedup)
 *
 * The existing 45 session.test.ts cases still cover the legacy `compact()`
 * path, which is intentionally LEFT ALONE in C6 — V2 ships alongside it.
 */

import { describe, it, expect, vi } from "vitest";
import { ChatSession } from "./session.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../providers/llm.js";

async function* singleText(text: string): AsyncIterable<LLMStreamChunk> {
  yield { type: "text", delta: text };
  yield { type: "done", finishReason: "stop" };
}

function fakeSummarizer(summary: string): LLMProvider {
  return {
    async describe() { return { name: "fake" }; },
    chat: vi.fn(async (_req: LLMRequest, _opts?: { signal?: AbortSignal }) => {
      return {
        stream: () => singleText(summary),
      } as unknown as LLMResponse;
    }),
    countTokens: (msgs: LLMMessage[]) =>
      Math.ceil(msgs.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0) / 4),
  } as unknown as LLMProvider;
}

function newSessionWithHistory(history: LLMMessage[]): ChatSession {
  const sess = new ChatSession({
    llm: fakeSummarizer("V2 summary"),
    model: "gpt-5.5",
    tools: [],
    systemPrompt: "you are mathran",
    autoCompact: {
      enabled: true,
      thresholdPct: 0.5,
      keepRecentRounds: 2,
      contextWindow: 200000,
    },
  });
  sess.replaceHistory(history);
  return sess;
}

const sys = (text: string): LLMMessage => ({ role: "system", content: text });
const user = (text: string): LLMMessage => ({ role: "user", content: text });
const asst = (text: string): LLMMessage => ({ role: "assistant", content: text });

describe("ChatSession.compactV2", () => {
  it("uses LocalCompactionStrategy on first call (lazy bootstrap)", async () => {
    const sess = newSessionWithHistory([
      sys("you are mathran"),
      user("dropped 1"), asst("ok 1"),
      user("dropped 2"), asst("ok 2"),
      user("dropped 3"), asst("ok 3"),
      user("kept 1"), asst("ok kept 1"),
      user("kept 2"), asst("ok kept 2"),
    ]);
    const out = await sess.compactV2({
      reason: "user_requested",
      phase: "standalone",
      trigger: "manual",
    });
    expect(out.ok).toBe(true);
    expect(out.telemetry.strategy).toBe("local");
    expect(out.telemetry.droppedRoundCount).toBe(3);
    // SwapV2 succeeded
    const newMsgs = sess.history();
    // newMsgs has: [sys, SUMMARY, kept1, ok-kept-1, kept2, ok-kept-2]
    expect(newMsgs.length).toBe(6);
    expect(newMsgs[1].role).toBe("system");
    expect(newMsgs[1].content).toContain("V2 summary");
  });

  it("resolves SummaryInjectionPolicy from phase when caller omits policy", async () => {
    const sess = newSessionWithHistory([
      sys("sys"),
      user("d1"), asst("o1"),
      user("d2"), asst("o2"),
      user("d3"), asst("o3"),
      user("kept"), asst("ok kept"),
    ]);
    // phase=mid_turn → policy should default to before_last_user_message
    const out = await sess.compactV2({
      reason: "token_limit",
      phase: "mid_turn",
      trigger: "auto",
    });
    expect(out.ok).toBe(true);
    expect(out.telemetry.phase).toBe("mid_turn");
    expect(out.telemetry.policy).toBe("before_last_user_message");
    // keepRecentRounds=2 → tail keeps the last 2 user-rooted rounds:
    //   tail = [user("d3"), asst("o3"), user("kept"), asst("ok kept")]
    // With mid_turn policy, summary inserts BEFORE the last real user
    // inside tail → just before user("kept").
    // Final shape: [sys, user("d3"), asst("o3"), SUMMARY, user("kept"), asst("ok kept")]
    const newMsgs = sess.history();
    expect(newMsgs.length).toBe(6);
    expect(newMsgs[0]).toEqual(sys("sys"));
    expect(newMsgs[1]).toEqual(user("d3"));
    expect(newMsgs[2]).toEqual(asst("o3"));
    expect(newMsgs[3].role).toBe("system");
    expect(newMsgs[3].content).toContain("V2 summary");
    expect(newMsgs[4]).toEqual(user("kept"));
    expect(newMsgs[5]).toEqual(asst("ok kept"));
  });

  it("does NOT swap messages when PreCompact hook stops the compaction", async () => {
    const sess = newSessionWithHistory([
      sys("sys"),
      user("d1"), asst("o1"),
      user("d2"), asst("o2"),
      user("d3"), asst("o3"),
      user("kept"), asst("ok kept"),
    ]);
    const before = sess.history();
    const out = await sess.compactV2({
      reason: "user_requested",
      phase: "standalone",
      trigger: "manual",
      hooks: {
        pre: async () => ({ kind: "stopped", reason: "feature-disabled" }),
      },
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("skipped");
    expect(out.error).toBe("feature-disabled");
    expect(out.telemetry.status).toBe("skipped");
    expect(out.telemetry.hookOutcomes?.pre).toBe("stopped");
    // Messages unchanged
    expect(sess.history()).toEqual(before);
  });

  it("dedups concurrent compactV2 calls", async () => {
    const sess = newSessionWithHistory([
      sys("sys"),
      user("d1"), asst("o1"),
      user("d2"), asst("o2"),
      user("d3"), asst("o3"),
      user("kept"), asst("ok kept"),
    ]);
    // Fire two concurrent calls — they should resolve to the SAME outcome.
    const [a, b] = await Promise.all([
      sess.compactV2({ reason: "user_requested", phase: "standalone", trigger: "manual" }),
      sess.compactV2({ reason: "user_requested", phase: "standalone", trigger: "manual" }),
    ]);
    expect(a.telemetry.startedAtMs).toBe(b.telemetry.startedAtMs);
    expect(a.telemetry.endedAtMs).toBe(b.telemetry.endedAtMs);
    // Only one swap happened (newMsgs is stable, V2 summary appears exactly once)
    const newMsgs = sess.history();
    const summaryCount = newMsgs.filter((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("V2 summary")).length;
    expect(summaryCount).toBe(1);
  });

  it("PostCompact hook fires after successful compaction", async () => {
    const sess = newSessionWithHistory([
      sys("sys"),
      user("d1"), asst("o1"),
      user("d2"), asst("o2"),
      user("d3"), asst("o3"),
      user("kept"), asst("ok kept"),
    ]);
    const postSpy = vi.fn(async () => ({ kind: "continue" as const }));
    const out = await sess.compactV2({
      reason: "user_requested",
      phase: "standalone",
      trigger: "manual",
      hooks: { post: postSpy },
    });
    expect(out.ok).toBe(true);
    expect(postSpy).toHaveBeenCalledOnce();
    // The telemetry passed to post() reflects status=ok
    const args = postSpy.mock.calls[0] as unknown as Array<{ status: string }>;
    expect(args[0].status).toBe("ok");
  });

  it("C8 — emits a 'compaction' ChatEvent to onCompactionEvent listener on success", async () => {
    const events: Array<{ type: string; outcome?: string; reason?: string; droppedRoundCount?: number; originalTokens?: number; newTokens?: number }> = [];
    const sess = new ChatSession({
      llm: fakeSummarizer("V2 summary"),
      model: "gpt-5.5",
      tools: [],
      systemPrompt: "you are mathran",
      autoCompact: { enabled: true, thresholdPct: 0.5, keepRecentRounds: 2, contextWindow: 200000 },
      onCompactionEvent: (ev) => { events.push(ev); },
    });
    sess.replaceHistory([
      sys("sys"),
      user("d1"), asst("o1"),
      user("d2"), asst("o2"),
      user("d3"), asst("o3"),
      user("kept"), asst("ok kept"),
    ]);
    const out = await sess.compactV2({
      reason: "user_requested",
      phase: "standalone",
      trigger: "manual",
    });
    expect(out.ok).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("compaction");
    expect(events[0].outcome).toBe("ok");
    expect(events[0].reason).toBe("user_requested");
    expect(events[0].droppedRoundCount).toBeGreaterThan(0);
    expect(events[0].originalTokens).toBeGreaterThan(0);
    expect(events[0].newTokens).toBeGreaterThanOrEqual(0);
  });

  it("C8 — does NOT emit compaction event for noop (droppedRoundCount=0)", async () => {
    const events: Array<{ type: string }> = [];
    const sess = new ChatSession({
      llm: fakeSummarizer("V2 summary"),
      model: "gpt-5.5",
      tools: [],
      systemPrompt: "you are mathran",
      autoCompact: { enabled: true, thresholdPct: 0.5, keepRecentRounds: 50, contextWindow: 200000 },
      onCompactionEvent: (ev) => { events.push(ev); },
    });
    // keepRecentRounds=50 with only 1 round → middle is empty → noop
    sess.replaceHistory([sys("sys"), user("only kept"), asst("ok")]);
    const out = await sess.compactV2({
      reason: "user_requested",
      phase: "standalone",
      trigger: "manual",
    });
    expect(out.ok).toBe(true);
    expect(out.telemetry.droppedRoundCount).toBe(0);
    expect(events.length).toBe(0); // silent on noop
  });

  it("C8 — emits compaction event on failure (hook stopped)", async () => {
    const events: Array<{ type: string; outcome?: string }> = [];
    const sess = new ChatSession({
      llm: fakeSummarizer("V2 summary"),
      model: "gpt-5.5",
      tools: [],
      systemPrompt: "you are mathran",
      autoCompact: { enabled: true, thresholdPct: 0.5, keepRecentRounds: 2, contextWindow: 200000 },
      onCompactionEvent: (ev) => { events.push(ev); },
    });
    sess.replaceHistory([
      sys("sys"),
      user("d1"), asst("o1"),
      user("d2"), asst("o2"),
      user("d3"), asst("o3"),
      user("kept"), asst("ok kept"),
    ]);
    const out = await sess.compactV2({
      reason: "user_requested",
      phase: "standalone",
      trigger: "manual",
      hooks: {
        pre: async () => ({ kind: "stopped", reason: "disabled" }),
      },
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("skipped");
    expect(events.length).toBe(1);
    expect(events[0].outcome).toBe("skipped");
  });

  it("C8 — listener exceptions never escape compactV2", async () => {
    const sess = new ChatSession({
      llm: fakeSummarizer("V2 summary"),
      model: "gpt-5.5",
      tools: [],
      systemPrompt: "you are mathran",
      autoCompact: { enabled: true, thresholdPct: 0.5, keepRecentRounds: 2, contextWindow: 200000 },
      onCompactionEvent: () => { throw new Error("listener boom"); },
    });
    sess.replaceHistory([
      sys("sys"),
      user("d1"), asst("o1"),
      user("d2"), asst("o2"),
      user("d3"), asst("o3"),
      user("kept"), asst("ok kept"),
    ]);
    // Must not throw; outcome must still be ok.
    const out = await sess.compactV2({
      reason: "user_requested",
      phase: "standalone",
      trigger: "manual",
    });
    expect(out.ok).toBe(true);
  });
});
