/**
 * Compaction V2 — multi-strategy + injection + hook tests.
 *
 * Covers spec/03-compaction.md §4.5:
 *   1. pickStrategy returns Local by default
 *   2. pickStrategy throws when no strategy is registered
 *   3. rebuildHistory policy=DoNotInject returns retained unchanged
 *   4. rebuildHistory policy=BeforeLastUserMessage splices before last user msg
 *   5. rebuildHistory with no user msg puts summary at head
 *   6. AbortSignal already-aborted -> outcome.ok=false, telemetry.status='cancelled'
 *   7. PreCompact hook returns skip -> V2 returns status='skipped_hook', no DB write
 *   8. PostCompact hook receives full telemetry on success
 *   9. injectionPolicyForPhase mapping (mid_turn vs others)
 *  10. LocalCompactionStrategy retries on empty summary up to retryBudget, then fails
 *
 * Ported: 2026-06-10 (commit 3/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub external modules so the LocalCompactionStrategy can be exercised in
// isolation. The DB-driven entry point (compactConversationV2) needs full
// channel_messages plumbing — that's covered by compaction-hardening.test.ts.
vi.mock("@/server/db/schema", () => ({
  channelMessages: {
    id: { name: "id" },
    channelId: { name: "channel_id" },
    topicId: { name: "topic_id" },
    authorKind: { name: "author_kind" },
    authorAssistantId: { name: "author_assistant_id" },
    content: { name: "content" },
    contentType: { name: "content_type" },
    isSummary: { name: "is_summary" },
    isCompacted: { name: "is_compacted" },
    toolCallId: { name: "tool_call_id" },
    toolResult: { name: "tool_result" },
    metadata: { name: "metadata" },
    createdAt: { name: "created_at" },
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>(
    "drizzle-orm",
  );
  return {
    ...actual,
    eq: () => ({}),
    and: () => ({}),
    asc: () => ({}),
    inArray: () => ({}),
    sql: Object.assign(() => ({}), { raw: () => ({}) }),
  };
});

vi.mock("../../azure-llm", () => ({
  DEFAULT_AZURE_MODEL: "gpt-test",
  logLLMUsage: vi.fn(),
  getAzureClient: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: "MOCK_SUMMARY" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })),
      },
    },
  })),
}));

vi.mock("../../constants", () => ({
  COMPACTION_PROMPT_LIMIT: 12_000,
  MESSAGE_CONTENT_SLICE: 500,
}));

vi.mock("@/server/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => mockRows,
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      transactionRan = true;
      await fn({
        update: () => ({ set: () => ({ where: async () => undefined }) }),
        insert: () => ({ values: async () => undefined }),
      });
    },
  }),
}));

let mockRows: Array<{
  id: string;
  role: string;
  content: string | null;
  toolCallId: string | null;
  toolResult: unknown;
  metadata: unknown;
  isSummary: boolean;
  createdAt: Date;
}> = [];
let transactionRan = false;

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  pickStrategy,
  _resetStrategiesForTest,
  _resetBuiltinStrategiesBootForTest,
  ensureBuiltinStrategiesRegistered,
  LocalCompactionStrategy,
  type CompactionRequest,
} from "../compaction-strategies";
import {
  injectionPolicyForPhase,
  rebuildHistory,
  summaryToMessage,
} from "../compaction-injection";
import {
  CompactionReason,
  CompactionPhase,
  CompactionTrigger,
  CompactionStrategy,
  SummaryInjectionPolicy,
  TruncationPolicy,
} from "../types";
import { registerPreCompact, registerPostCompact, resetForTest } from "../../hooks/registry";
import { compactConversationV2 } from "../compaction";

const baseReq = (over: Partial<CompactionRequest> = {}): CompactionRequest => ({
  conversationId: "conv-1",
  transcript: "[user]: hi\n[assistant]: hello",
  approxInputTokens: 100,
  inputMessages: 2,
  reason: CompactionReason.BudgetExceeded,
  phase: CompactionPhase.PostTurn,
  trigger: CompactionTrigger.Auto,
  policy: TruncationPolicy.Compaction,
  ...over,
});

describe("compaction-strategies", () => {
  beforeEach(() => {
    _resetStrategiesForTest();
    _resetBuiltinStrategiesBootForTest();
    resetForTest();
    mockRows = [];
    transactionRan = false;
  });

  afterEach(() => {
    _resetStrategiesForTest();
    _resetBuiltinStrategiesBootForTest();
    resetForTest();
  });

  // 1
  it("pickStrategy returns Local by default after ensureBuiltinStrategiesRegistered", () => {
    ensureBuiltinStrategiesRegistered();
    const strat = pickStrategy(baseReq());
    expect(strat.name).toBe(CompactionStrategy.Local);
  });

  // 2
  it("pickStrategy throws when no strategy is registered", () => {
    expect(() => pickStrategy(baseReq())).toThrow(/no compaction strategy/);
  });

  // 3
  it("rebuildHistory(policy=DoNotInject) returns retained unchanged", () => {
    const retained: ChatCompletionMessageParam[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    const out = rebuildHistory({
      retained,
      summary: "X",
      policy: SummaryInjectionPolicy.DoNotInject,
    });
    expect(out).toEqual(retained);
  });

  // 4
  it("rebuildHistory(policy=BeforeLastUserMessage) splices before last user msg", () => {
    const retained: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u-old" },
      { role: "assistant", content: "a-old" },
      { role: "user", content: "u-last" },
    ];
    const out = rebuildHistory({
      retained,
      summary: "SUMMARY",
      policy: SummaryInjectionPolicy.BeforeLastUserMessage,
    });
    expect(out.length).toBe(5);
    expect(out[2]).toEqual({ role: "assistant", content: "a-old" });
    expect(out[3]).toEqual(summaryToMessage("SUMMARY"));
    expect(out[4]).toEqual({ role: "user", content: "u-last" });
  });

  // 5
  it("rebuildHistory with no user msg puts summary at head", () => {
    const retained: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "a" },
    ];
    const out = rebuildHistory({
      retained,
      summary: "S",
      policy: SummaryInjectionPolicy.BeforeLastUserMessage,
    });
    expect(out[0]).toEqual(summaryToMessage("S"));
    expect(out.slice(1)).toEqual(retained);
  });

  // 6
  it("LocalCompactionStrategy with already-aborted signal returns cancelled", async () => {
    const strat = new LocalCompactionStrategy();
    const ac = new AbortController();
    ac.abort();
    const r = await strat.run(baseReq({ signal: ac.signal }));
    expect(r.ok).toBe(false);
    expect(r.telemetry.status).toBe("cancelled");
    expect(r.telemetry.retryCount).toBe(0);
  });

  // 7
  it("compactConversationV2 returns skipped_hook + no DB write when PreCompact vetoes", async () => {
    ensureBuiltinStrategiesRegistered();
    registerPreCompact({
      name: "veto",
      priority: 1,
      run: async () => ({ kind: "skip", reason: "lock held" }),
    });
    // Build 60 rows so the threshold trips.
    mockRows = Array.from({ length: 60 }, (_, i) => ({
      id: `r${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(150),
      toolCallId: null,
      toolResult: null,
      metadata: null,
      isSummary: false,
      createdAt: new Date(i * 1000),
    }));

    const res = await compactConversationV2({
      channelId: "chan-x",
      topicId: "topic-x",
      assistantId: "asst-x",
      reason: CompactionReason.BudgetExceeded,
      phase: CompactionPhase.PostTurn,
      trigger: CompactionTrigger.Auto,
    });
    expect(res.status).toBe("skipped_hook");
    expect(res.skipReason).toContain("lock held");
    expect(transactionRan).toBe(false);
  });

  // 8
  it("compactConversationV2 invokes PostCompact with success telemetry on happy path", async () => {
    ensureBuiltinStrategiesRegistered();
    const seenTelemetry: Array<unknown> = [];
    registerPostCompact({
      name: "observer",
      priority: 1,
      run: async (ev) => {
        seenTelemetry.push(ev.telemetry);
        return { kind: "ack" };
      },
    });
    mockRows = Array.from({ length: 60 }, (_, i) => ({
      id: `r${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(150),
      toolCallId: null,
      toolResult: null,
      metadata: null,
      isSummary: false,
      createdAt: new Date(i * 1000),
    }));

    const res = await compactConversationV2({
      channelId: "chan-y",
      topicId: "topic-y",
      assistantId: "asst-y",
      reason: CompactionReason.BudgetExceeded,
      phase: CompactionPhase.PostTurn,
      trigger: CompactionTrigger.Auto,
    });
    expect(res.status).toBe("ok");
    expect(transactionRan).toBe(true);
    expect(seenTelemetry.length).toBe(1);
    const t = seenTelemetry[0] as Record<string, unknown>;
    expect(t.strategy).toBe(CompactionStrategy.Local);
    expect(t.status).toBe("ok");
    expect(t.reason).toBe(CompactionReason.BudgetExceeded);
    expect(t.phase).toBe(CompactionPhase.PostTurn);
    expect(typeof t.inputTokens).toBe("number");
    expect(typeof t.durationMs).toBe("number");
  });

  // 9
  it("injectionPolicyForPhase maps mid_turn->BeforeLastUserMessage, others->DoNotInject", () => {
    expect(injectionPolicyForPhase(CompactionPhase.MidTurn)).toBe(
      SummaryInjectionPolicy.BeforeLastUserMessage,
    );
    expect(injectionPolicyForPhase(CompactionPhase.PreTurn)).toBe(
      SummaryInjectionPolicy.DoNotInject,
    );
    expect(injectionPolicyForPhase(CompactionPhase.PostTurn)).toBe(
      SummaryInjectionPolicy.DoNotInject,
    );
    expect(injectionPolicyForPhase(CompactionPhase.StandaloneTurn)).toBe(
      SummaryInjectionPolicy.DoNotInject,
    );
  });

  // 10
  it("LocalCompactionStrategy retries on empty summary up to retryBudget, then fails", async () => {
    // Override azure-llm mock just for this test to return empty.
    const { getAzureClient } = await import("../../azure-llm");
    const createFn = vi.fn(async () => ({
      choices: [{ message: { content: "   " } }], // whitespace-only -> trim() -> ""
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    }));
    (getAzureClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      chat: { completions: { create: createFn } },
    });

    const strat = new LocalCompactionStrategy();
    const r = await strat.run(baseReq({ retryBudget: 3 }));
    expect(r.ok).toBe(false);
    if (r.ok) return; // narrow
    expect(r.telemetry.status).toBe("failed");
    expect(r.telemetry.retryCount).toBe(3);
    expect(createFn).toHaveBeenCalledTimes(3);
  });
});
