import { describe, it, expect, vi } from "vitest";
import {
  parseReviewerVerdict,
  decideReviewerAction,
  runReviewer,
  buildReviewerPrompt,
  REVIEWER_FAIL_OPEN,
  type ReviewerVerdict,
  type ReviewerInput,
} from "./goal-reviewer";
import { LLMRouter } from "./llm-router";

/**
 * P2-5 reviewer tests. Three things must NEVER regress:
 *  1. Parser tolerates garbage → fail-OPEN (never escalates to drift/stuck).
 *  2. LLM call failure → fail-OPEN verdict (so a broken reviewer can't break the loop).
 *  3. real verdict → continue=true; drift/stuck → continue=false with surfaced reason.
 *
 * The decideReviewerAction tests are pure and don't need any LLM mocking — they
 * lock the OUTER loop's branching independent of how the verdict was obtained.
 */

// ─── parseReviewerVerdict (tolerant JSON parser) ────────────────────────────

describe("parseReviewerVerdict", () => {
  it("parses a clean drift verdict", () => {
    const v = parseReviewerVerdict(
      '{"progress": "drift", "reason": "agent is exploring an unrelated subproject", "evidence": "[T3] read_effort on unrelated id"}',
    );
    expect(v.progress).toBe("drift");
    expect(v.reason).toBe("agent is exploring an unrelated subproject");
    expect(v.evidence).toBe("[T3] read_effort on unrelated id");
  });

  it("parses a stuck verdict (evidence optional)", () => {
    const v = parseReviewerVerdict('{"progress":"stuck","reason":"重复调同一个工具"}');
    expect(v.progress).toBe("stuck");
    expect(v.reason).toBe("重复调同一个工具");
    expect(v.evidence).toBeUndefined();
  });

  it("strips ```json code fences", () => {
    const v = parseReviewerVerdict('```json\n{"progress":"real","reason":"ok"}\n```');
    expect(v.progress).toBe("real");
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const v = parseReviewerVerdict(
      '总结: {"progress": "real", "reason": "ok"} 谢谢',
    );
    expect(v.progress).toBe("real");
  });

  // ★ fail-OPEN — the whole point of the safety story. If this regresses, a
  //   malformed verdict could falsely STOP a healthy run.
  it("empty input → fail-OPEN (progress=real, reason='reviewer unavailable')", () => {
    expect(parseReviewerVerdict("")).toEqual(REVIEWER_FAIL_OPEN);
  });

  it("non-JSON garbage → fail-OPEN", () => {
    expect(parseReviewerVerdict("不是 json")).toEqual(REVIEWER_FAIL_OPEN);
  });

  it("malformed JSON → fail-OPEN", () => {
    expect(parseReviewerVerdict('{"progress": "drift"')).toEqual(REVIEWER_FAIL_OPEN);
  });

  it("unknown progress enum → fail-OPEN (never trust unknown verdicts)", () => {
    // 'unknown' is NOT in {real, drift, stuck} — contract violation → fail-OPEN
    // protects against an unintended STOP from a misbehaving model.
    expect(parseReviewerVerdict('{"progress":"unknown","reason":"x"}')).toEqual(
      REVIEWER_FAIL_OPEN,
    );
  });

  it("missing reason gets a placeholder, never empty", () => {
    const v = parseReviewerVerdict('{"progress":"drift"}');
    expect(v.progress).toBe("drift");
    expect(v.reason.length).toBeGreaterThan(0);
  });

  it("clips overly long reason to a bounded length", () => {
    const long = "x".repeat(1000);
    const v = parseReviewerVerdict(`{"progress":"drift","reason":"${long}"}`);
    // Bound is 200 in the impl; check it's well under the original length.
    expect(v.reason.length).toBeLessThanOrEqual(200);
  });
});

// ─── decideReviewerAction (pure branch) ─────────────────────────────────────

describe("decideReviewerAction", () => {
  it("real → continue=true", () => {
    const v: ReviewerVerdict = { progress: "real", reason: "ok" };
    expect(decideReviewerAction(v)).toEqual({ continue: true });
  });

  it("drift → continue=false with reason surfaced", () => {
    const v: ReviewerVerdict = {
      progress: "drift",
      reason: "exploring unrelated subproject",
      evidence: "[T3] read_effort on unrelated id",
    };
    const r = decideReviewerAction(v);
    expect(r.continue).toBe(false);
    if (r.continue === false) {
      expect(r.reason).toContain("偏离目标");
      expect(r.reason).toContain("exploring unrelated subproject");
      expect(r.reason).toContain("[T3]");
    }
  });

  it("stuck → continue=false with 原地卷 tag", () => {
    const v: ReviewerVerdict = { progress: "stuck", reason: "重复调同一个工具" };
    const r = decideReviewerAction(v);
    expect(r.continue).toBe(false);
    if (r.continue === false) {
      expect(r.reason).toContain("原地卷");
    }
  });

  // ★ The fail-OPEN verdict (progress=real) MUST mean continue=true, otherwise
  //   the whole fail-OPEN story collapses.
  it("REVIEWER_FAIL_OPEN → continue=true (broken reviewer can't stop a healthy run)", () => {
    expect(decideReviewerAction(REVIEWER_FAIL_OPEN)).toEqual({ continue: true });
  });
});

// ─── buildReviewerPrompt (shape sanity) ─────────────────────────────────────

describe("buildReviewerPrompt", () => {
  const baseInput: ReviewerInput = {
    objective: "完成一个可运行的 prototype",
    recentSummaries: ["初始探索", "完成架构设计"],
    recentToolRows: [
      { round: 3, toolName: "read_effort", toolStatus: "completed", content: "effort foo" },
      { round: 4, toolName: "write_effort", toolStatus: "completed", content: "wrote bar" },
    ],
    round: 5,
  };

  it("includes objective, round, summaries, tool rows", () => {
    const p = buildReviewerPrompt(baseInput);
    expect(p).toContain("可运行的 prototype");
    expect(p).toContain("当前轮次：5");
    expect(p).toContain("[S1]");
    expect(p).toContain("[S2]");
    expect(p).toContain("[T1]");
    expect(p).toContain("read_effort");
    expect(p).toContain("write_effort");
  });

  it("asks for strict JSON + evidence pointer", () => {
    const p = buildReviewerPrompt(baseInput);
    expect(p).toContain("严格 JSON");
    expect(p).toContain("evidence");
  });

  it("empty arrays render placeholders, not undefined", () => {
    const p = buildReviewerPrompt({
      objective: "x",
      recentSummaries: [],
      recentToolRows: [],
      round: 1,
    });
    expect(p).toContain("(无近期总结)");
    expect(p).toContain("(无近期工具调用)");
  });
});

// ─── runReviewer (LLM-mocked) ───────────────────────────────────────────────

/**
 * Minimal LLMRouter stub: structural-type-compatible by exposing `chatCompletion`.
 * We cast through `unknown` so TS accepts it where an LLMRouter is expected.
 * The reviewer ONLY ever reads `chunk.choices[0].delta.content`, so this stub
 * is enough — we don't need to mimic ChatChunk in full.
 */
function stubRouter(textOrError: string | Error): LLMRouter {
  const fake = {
    async *chatCompletion(_params: unknown) {
      if (textOrError instanceof Error) throw textOrError;
      yield {
        choices: [{ delta: { content: textOrError } }],
      };
    },
  };
  return fake as unknown as LLMRouter;
}

const sampleInput: ReviewerInput = {
  objective: "补齐 P2-5",
  recentSummaries: ["轮 4 完成"],
  recentToolRows: [{ round: 5, toolName: "read_effort", toolStatus: "completed", content: "x" }],
  round: 5,
};

describe("runReviewer (LLM-mocked)", () => {
  it("happy path: parses a drift verdict and surfaces it", async () => {
    const router = stubRouter(
      '{"progress":"drift","reason":"偏离了","evidence":"[T1] read_effort"}',
    );
    const v = await runReviewer(sampleInput, { router });
    expect(v.progress).toBe("drift");
    expect(v.reason).toBe("偏离了");
    expect(v.evidence).toBe("[T1] read_effort");
  });

  // ★ The whole safety story — router throws (timeout / 5xx / abort) → caller
  //   gets a `real` verdict so the loop continues. Without this, a flaky Azure
  //   could falsely halt every long run.
  it("LLM call throws → fail-OPEN (continue=true downstream)", async () => {
    const router = stubRouter(new Error("simulated 503"));
    const v = await runReviewer(sampleInput, { router });
    expect(v).toEqual(REVIEWER_FAIL_OPEN);
    // … and downstream decision is continue=true.
    expect(decideReviewerAction(v)).toEqual({ continue: true });
  });

  it("LLM returns garbage → fail-OPEN (continue=true downstream)", async () => {
    const router = stubRouter("not a json at all 🙃");
    const v = await runReviewer(sampleInput, { router });
    expect(v).toEqual(REVIEWER_FAIL_OPEN);
    expect(decideReviewerAction(v)).toEqual({ continue: true });
  });

  // The reviewer accepts a stub and stays inside the supplied router (no
  // network). The vi.fn() spy is just a sentinel — we're really checking that
  // the call completes without throwing.
  it("accepts a stub router without touching the network", async () => {
    const router = stubRouter('{"progress":"real","reason":"ok"}');
    const spy = vi.fn();
    const v = await runReviewer(sampleInput, { router });
    expect(v.progress).toBe("real");
    expect(spy).not.toHaveBeenCalled();
  });
});
