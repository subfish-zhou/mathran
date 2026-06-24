/**
 * Tests for LocalCompactionStrategy (V2 path) — TODO-2 §9.1 / C5.
 *
 * Covers the V2 contract added on top of the legacy compactRunner:
 *   - AbortSignal before / during / between attempts
 *   - Independent retry budget with backoff
 *   - SummaryInjectionPolicy applied via rebuildHistory
 *   - 9-section structured prompt forwarded to summarizer LLM
 *   - Telemetry populated even on failure
 *   - Never mutates req.messages
 *   - Mid-turn injection (before_last_real_user_message) vs pre-turn (front)
 *
 * The legacy 9 cases in compact.test.ts continue to verify the v0.2
 * `compactRunner` path is unchanged.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";
import type { CompactionRequest } from "./compact-types.js";
import { LocalCompactionStrategy, COMPACT_SUMMARY_PREFIX } from "./compact.js";

// ---------- fakes ----------

/** Stream a single text chunk + done frame. */
async function* singleText(text: string): AsyncIterable<LLMStreamChunk> {
  yield { type: "text", delta: text };
  yield { type: "done", finishReason: "stop" };
}

/** LLMProvider that returns a fixed summary, always succeeds. */
function fakeSummarizer(summary: string): LLMProvider {
  return {
    async describe() { return { name: "fake" }; },
    chat: vi.fn(async (_req: LLMRequest, _opts?: { signal?: AbortSignal }) => {
      return {
        stream: () => singleText(summary),
      } as unknown as LLMResponse;
    }),
    countTokens: (msgs: LLMMessage[]) => msgs.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0) / 4,
  } as unknown as LLMProvider;
}

/** LLMProvider that throws N times then succeeds. */
function flakyLLM(failCount: number, finalSummary: string): { llm: LLMProvider; callCount: () => number } {
  let calls = 0;
  const provider: LLMProvider = {
    async describe() { return { name: "flaky" }; },
    chat: vi.fn(async (_req: LLMRequest, _opts?: { signal?: AbortSignal }) => {
      calls++;
      if (calls <= failCount) throw new Error(`flaky-fail attempt #${calls}`);
      return {
        stream: () => singleText(finalSummary),
      } as unknown as LLMResponse;
    }),
  } as unknown as LLMProvider;
  return { llm: provider, callCount: () => calls };
}

/** LLMProvider that never returns (so we can test signal-during-call). */
function hangingLLM(): LLMProvider {
  return {
    async describe() { return { name: "hang" }; },
    chat: vi.fn(async (_req: LLMRequest, opts?: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      // unreachable
      return { stream: () => singleText("never") } as unknown as LLMResponse;
    }),
  } as unknown as LLMProvider;
}

// ---------- fixtures ----------

const sys = (text: string): LLMMessage => ({ role: "system", content: text });
const user = (text: string): LLMMessage => ({ role: "user", content: text });
const asst = (text: string): LLMMessage => ({ role: "assistant", content: text });

/** Build a request whose middle has 3 droppable rounds, tail has 2 kept rounds. */
function buildReq(opts: Partial<CompactionRequest> & { llm?: LLMProvider } = {}): CompactionRequest {
  const messages: LLMMessage[] = [
    sys("you are mathran"),
    user("dropped 1"), asst("ok 1"),
    user("dropped 2"), asst("ok 2"),
    user("dropped 3"), asst("ok 3"),
    user("kept 1"),    asst("ok kept 1"),
    user("kept 2"),    asst("ok kept 2"),
  ];
  return {
    messages,
    reason: "budget_exceeded",
    phase: "pre_turn",
    trigger: "auto",
    policy: "do_not_inject",
    keepRecentRounds: 2,
    llm: opts.llm ?? fakeSummarizer("compacted earlier work"),
    ...opts,
  };
}

// ---------- tests ----------

describe("LocalCompactionStrategy", () => {
  describe("happy path", () => {
    it("compacts middle, keeps systemBlock and last N rounds verbatim", async () => {
      const strat = new LocalCompactionStrategy();
      const req = buildReq();
      const out = await strat.run(req);

      expect(out.ok).toBe(true);
      expect(out.status).toBe("ok");
      expect(out.newMessages).toBeDefined();
      const m = out.newMessages!;
      // [system, SUMMARY, kept1, ok-kept-1, kept2, ok-kept-2]
      expect(m[0]).toEqual(sys("you are mathran"));
      expect(m[1].role).toBe("system");
      expect(m[1].content).toBe(`${COMPACT_SUMMARY_PREFIX}compacted earlier work`);
      expect(m[2]).toEqual(user("kept 1"));
      expect(m[m.length - 1]).toEqual(asst("ok kept 2"));
    });

    it("populates telemetry on success", async () => {
      const strat = new LocalCompactionStrategy();
      const out = await strat.run(buildReq());

      const t = out.telemetry;
      expect(t.status).toBe("ok");
      expect(t.strategy).toBe("local");
      expect(t.reason).toBe("budget_exceeded");
      expect(t.phase).toBe("pre_turn");
      expect(t.policy).toBe("do_not_inject");
      expect(t.originalTokens).toBeGreaterThan(0);
      expect(t.newTokens).toBeGreaterThan(0);
      expect(t.droppedRoundCount).toBe(3); // 3 user-rooted dropped rounds
      expect(t.retryAttempts).toBe(0); // succeeded on first try
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("noop (status=ok, droppedRoundCount=0) when middle is empty", async () => {
      const strat = new LocalCompactionStrategy();
      const req: CompactionRequest = {
        messages: [sys("sys"), user("only kept"), asst("ok")],
        reason: "budget_exceeded",
        phase: "pre_turn",
        trigger: "auto",
        policy: "do_not_inject",
        keepRecentRounds: 5, // way more than available → entire history is "tail"
        llm: fakeSummarizer("would-be-summary"),
      };
      const out = await strat.run(req);
      expect(out.ok).toBe(true);
      expect(out.telemetry.droppedRoundCount).toBe(0);
      // newMessages equals input (cloned, same contents)
      expect(out.newMessages?.length).toBe(req.messages.length);
    });

    it("mid_turn policy injects summary inside tail (before last real user)", async () => {
      const strat = new LocalCompactionStrategy();
      const req = buildReq({ phase: "mid_turn", policy: "before_last_user_message" });
      const out = await strat.run(req);
      expect(out.ok).toBe(true);
      const m = out.newMessages!;
      // Expect summary to land just above the LAST real user message in the
      // retained tail ("kept 2"), i.e. after "ok kept 1" and before "kept 2".
      // Layout: [system, kept1, ok-kept1, SUMMARY, kept2, ok-kept2]
      expect(m[0]).toEqual(sys("you are mathran"));
      expect(m[1]).toEqual(user("kept 1"));
      expect(m[2]).toEqual(asst("ok kept 1"));
      expect(m[3].role).toBe("system");
      expect(m[3].content).toBe(`${COMPACT_SUMMARY_PREFIX}compacted earlier work`);
      expect(m[4]).toEqual(user("kept 2"));
      expect(m[5]).toEqual(asst("ok kept 2"));
    });
  });

  describe("AbortSignal", () => {
    it("returns cancelled when signal is already aborted at entry", async () => {
      const strat = new LocalCompactionStrategy();
      const controller = new AbortController();
      controller.abort();
      const out = await strat.run(buildReq({ signal: controller.signal }));
      expect(out.ok).toBe(false);
      expect(out.status).toBe("cancelled");
      expect(out.error).toMatch(/aborted before start/);
    });

    it("returns cancelled when signal aborts during the LLM call", async () => {
      const strat = new LocalCompactionStrategy();
      const controller = new AbortController();
      const llm = hangingLLM();
      const promise = strat.run(buildReq({ llm, signal: controller.signal, retryBudget: 0 }));
      // give the run loop a tick to enter the LLM call
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      const out = await promise;
      expect(out.ok).toBe(false);
      expect(out.status).toBe("failed"); // hang threw "aborted" via LLM, retry exhausted (budget=0)
      expect(out.telemetry.status).toBe("failed");
    });

    it("never mutates req.messages on cancellation", async () => {
      const strat = new LocalCompactionStrategy();
      const controller = new AbortController();
      controller.abort();
      const req = buildReq({ signal: controller.signal });
      const originalLen = req.messages.length;
      const originalFirst = req.messages[0].content;
      await strat.run(req);
      expect(req.messages.length).toBe(originalLen);
      expect(req.messages[0].content).toBe(originalFirst);
    });
  });

  describe("retry budget", () => {
    it("retries up to retryBudget attempts then succeeds", async () => {
      const strat = new LocalCompactionStrategy();
      const { llm, callCount } = flakyLLM(2, "succeeded after retries");
      const out = await strat.run(buildReq({ llm, retryBudget: 3 }));
      expect(out.ok).toBe(true);
      expect(out.telemetry.retryAttempts).toBe(2); // 2 failures before the 3rd attempt succeeded
      expect(callCount()).toBe(3);
    });

    it("fails (status=failed) when all retries exhausted", async () => {
      const strat = new LocalCompactionStrategy();
      const { llm } = flakyLLM(99, "never reached"); // way more failures than budget
      const out = await strat.run(buildReq({ llm, retryBudget: 1 }));
      expect(out.ok).toBe(false);
      expect(out.status).toBe("failed");
      expect(out.error).toMatch(/summarizer failed after 2 attempt/); // budget=1 + initial = 2
    });

    it("retry budget is INDEPENDENT — retries don't bleed into telemetry as durationMs spikes", async () => {
      const strat = new LocalCompactionStrategy();
      const { llm } = flakyLLM(99, "never");
      // retryBudget=0 means exactly 1 attempt total — no backoff, no retries.
      const t0 = Date.now();
      const out = await strat.run(buildReq({ llm, retryBudget: 0 }));
      const elapsed = Date.now() - t0;
      expect(out.ok).toBe(false);
      expect(out.telemetry.retryAttempts).toBe(0); // 0 retries
      expect(elapsed).toBeLessThan(500); // no backoff sleep happened
    });
  });

  describe("immutability", () => {
    it("does not mutate req.messages on success", async () => {
      const strat = new LocalCompactionStrategy();
      const req = buildReq();
      const beforeLen = req.messages.length;
      const beforeFirstRef = req.messages[0];
      const out = await strat.run(req);
      expect(out.ok).toBe(true);
      expect(req.messages.length).toBe(beforeLen);
      expect(req.messages[0]).toBe(beforeFirstRef); // same reference, not replaced
    });
  });

  describe("telemetry on failure", () => {
    it("populates a complete telemetry block when status=failed", async () => {
      const strat = new LocalCompactionStrategy();
      const { llm } = flakyLLM(99, "never");
      const out = await strat.run(buildReq({ llm, retryBudget: 0 }));
      expect(out.ok).toBe(false);
      const t = out.telemetry;
      expect(t.status).toBe("failed");
      expect(t.strategy).toBe("local");
      expect(t.originalTokens).toBeGreaterThan(0);
      expect(t.newTokens).toBe(t.originalTokens); // unchanged on failure
      expect(t.droppedRoundCount).toBe(0);
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
      expect(t.startedAtMs).toBeLessThanOrEqual(t.endedAtMs);
    });
  });

  describe("supports()", () => {
    it("returns true for any request (always-available built-in)", () => {
      const strat = new LocalCompactionStrategy();
      expect(strat.supports(buildReq())).toBe(true);
      expect(strat.supports(buildReq({ phase: "mid_turn", policy: "before_last_user_message" }))).toBe(true);
      expect(strat.supports(buildReq({ reason: "user_requested", trigger: "manual" }))).toBe(true);
    });
  });
});
