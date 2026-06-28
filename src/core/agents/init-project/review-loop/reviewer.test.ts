import { describe, expect, it } from "vitest";

import { reviewArtifact, normalizeVerdict, type ReviewArtifactInput } from "./reviewer.js";
import { buildReviewerPrompt } from "./prompts.js";
import type { SpineLLM } from "../spine/llm.js";

function input(overrides: Partial<ReviewArtifactInput> = {}): ReviewArtifactInput {
  return {
    artifactKind: "wiki-page",
    artifactTitle: "Sharp Chromatic Bound",
    artifactSlug: "sharp-chromatic-bound",
    artifactContent: "# Sharp Chromatic Bound\n\nWe show $\\chi(G)\\le\\Delta+1$.",
    topic: "Chromatic numbers of graphs",
    ...overrides,
  };
}

describe("reviewArtifact — approve path", () => {
  it("returns verdict=approve with no issues for a good artifact", async () => {
    const llm: SpineLLM = async () =>
      JSON.stringify({
        verdict: "approve",
        overallReaderExperience: "Clear and well-paced; I followed it easily.",
        issues: [],
        verdict_reasoning: "Nothing tripped me up.",
      });
    const verdict = await reviewArtifact(input(), llm);
    expect(verdict.verdict).toBe("approve");
    expect(verdict.issues).toHaveLength(0);
    expect(verdict.overallReaderExperience).toContain("Clear");
    expect(verdict.verdictReasoning).toContain("tripped");
  });
});

describe("reviewArtifact — rewrite path", () => {
  it("returns rewrite_requested with blocks-understanding/vague issue", async () => {
    const llm: SpineLLM = async () =>
      JSON.stringify({
        verdict: "rewrite_requested",
        overallReaderExperience: "I got lost in §2 — the key term is never defined.",
        issues: [
          {
            location: "Definitions, paragraph 2",
            severity: "blocks-understanding",
            kind: "vague",
            what_you_experienced: "The term 'fractional relaxation' is used with no definition.",
            what_would_help: "Define it on first use or link to the relevant page.",
          },
        ],
        verdict_reasoning: "An undefined central term blocks understanding.",
      });
    const verdict = await reviewArtifact(input(), llm);
    expect(verdict.verdict).toBe("rewrite_requested");
    expect(verdict.issues).toHaveLength(1);
    expect(verdict.issues[0]!.severity).toBe("blocks-understanding");
    expect(verdict.issues[0]!.kind).toBe("vague");
  });

  it("forces rewrite_requested when the LLM says approve but flags a blocks-understanding issue", async () => {
    const llm: SpineLLM = async () =>
      JSON.stringify({
        verdict: "approve",
        overallReaderExperience: "Mostly fine.",
        issues: [
          {
            location: "Proof, paragraph 4",
            severity: "blocks-understanding",
            kind: "skips-steps",
            what_you_experienced: "The proof jumps from (3) to (5) with no justification.",
            what_would_help: "Show the intermediate step.",
          },
        ],
        verdict_reasoning: "Looks ok overall.",
      });
    const verdict = await reviewArtifact(input(), llm);
    expect(verdict.verdict).toBe("rewrite_requested");
  });
});

describe("reviewArtifact — multiple severities", () => {
  it("preserves all issues with their severities and kinds", async () => {
    const llm: SpineLLM = async () =>
      JSON.stringify({
        verdict: "rewrite_requested",
        overallReaderExperience: "A few rough spots.",
        issues: [
          { location: "Intro p1", severity: "trivial", kind: "notation", what_you_experienced: "x", what_would_help: "y" },
          { location: "Body p3", severity: "annoying", kind: "redundant", what_you_experienced: "x", what_would_help: "y" },
          { location: "Body p7", severity: "blocks-understanding", kind: "unsupported", what_you_experienced: "x", what_would_help: "y" },
        ],
        verdict_reasoning: "Mixed.",
      });
    const verdict = await reviewArtifact(input(), llm);
    expect(verdict.issues.map((i) => i.severity)).toEqual([
      "trivial",
      "annoying",
      "blocks-understanding",
    ]);
    expect(verdict.issues.map((i) => i.kind)).toEqual(["notation", "redundant", "unsupported"]);
  });

  it("coerces unknown severity/kind to safe defaults", async () => {
    const llm: SpineLLM = async () =>
      JSON.stringify({
        verdict: "rewrite_requested",
        overallReaderExperience: "?",
        issues: [{ location: "x", severity: "catastrophic", kind: "stylistic", what_you_experienced: "a", what_would_help: "b" }],
        verdict_reasoning: "?",
      });
    const verdict = await reviewArtifact(input(), llm);
    expect(verdict.issues[0]!.severity).toBe("annoying");
    expect(verdict.issues[0]!.kind).toBe("other");
  });
});

describe("reviewArtifact — robustness", () => {
  it("flags reviewer_broken (not silent-approve) when the LLM returns unparseable output after retry", async () => {
    let calls = 0;
    const llm: SpineLLM = async () => {
      calls++;
      return "I'm sorry, I can't do that.";
    };
    const verdict = await reviewArtifact(input(), llm);
    // dogfood-run-d79c820c42b7 fix: previously this branch silent-approved the
    // artifact (claiming the reviewer was satisfied when in fact it broke);
    // now it surfaces as reviewer_broken so review-loop can short-circuit
    // honestly. See reviewer.ts comment block.
    expect(verdict.verdict).toBe("reviewer_broken");
    expect(verdict.issues).toHaveLength(0);
    expect(calls).toBe(2); // first try + retry, both failed
    expect(verdict.verdictReasoning).toContain("after one retry");
  });

  it("retries with strict-format reminder and recovers when the second attempt is valid JSON", async () => {
    let calls = 0;
    const llm: SpineLLM = async (prompt: string) => {
      calls++;
      if (calls === 1) return "Sure, here's my review: it's fine."; // unparseable prose
      // Second call should include the strict-format reminder.
      expect(prompt).toContain("STRICT FORMAT REMINDER");
      return JSON.stringify({
        verdict: "approve",
        overallReaderExperience: "Recovered on retry.",
        issues: [],
        verdictReasoning: "ok",
      });
    };
    const verdict = await reviewArtifact(input(), llm);
    expect(calls).toBe(2);
    expect(verdict.verdict).toBe("approve");
    expect(verdict.overallReaderExperience).toBe("Recovered on retry.");
  });

  it("flags reviewer_broken (not silent-approve) when the LLM throws", async () => {
    const llm: SpineLLM = async () => {
      throw new Error("boom");
    };
    const verdict = await reviewArtifact(input(), llm);
    // Same fix class as the unparseable-after-retry case: a thrown reviewer
    // means no verdict was rendered, so the artifact must surface, not pass.
    expect(verdict.verdict).toBe("reviewer_broken");
    expect(verdict.verdictReasoning).toContain("boom");
  });
});

describe("reviewer prompt", () => {
  it("casts the reviewer as an attentive graduate student (verbatim §6.3 framing)", () => {
    const p = buildReviewerPrompt(input());
    expect(p).toContain("attentive");
    expect(p).toContain("graduate student");
    expect(p).toContain("rubric");
    expect(p).toContain("You are READING");
    expect(p).toContain("Chromatic numbers of graphs");
    expect(p).toContain("wiki page");
  });

  it("propagates the audience hint into the prompt context", () => {
    const p = buildReviewerPrompt(input({ audienceHint: "graduate-student-entering-field" }));
    expect(p).toContain("graduate-student-entering-field");
    expect(p).toContain("intended audience");
  });

  it("includes the FULL artifact content (no slicing)", () => {
    const long = "PARA ".repeat(4000); // ~20k chars
    const p = buildReviewerPrompt(input({ artifactContent: long }));
    expect(p).toContain(long);
  });

  it("omits the self-review preamble by default (dual-model is the assumed setup)", () => {
    const p = buildReviewerPrompt(input());
    expect(p).not.toContain("SELF-REVIEW MODE");
    expect(p).not.toContain("THE SAME underlying model");
  });

  it("injects a self-review preamble when selfReviewMode=true (dogfood-run-d79c820c42b7 mitigation)", () => {
    const p = buildReviewerPrompt(input({ selfReviewMode: true }));
    expect(p).toContain("SELF-REVIEW MODE");
    expect(p).toContain("THE SAME underlying model");
    expect(p).toContain("Compensation rules");
    // The preamble must precede the normal "Your goal: read this document"
    // framing, not replace it — both should be present.
    expect(p.indexOf("SELF-REVIEW MODE")).toBeLessThan(p.indexOf("Your goal:"));
  });

  // ── fix #4 from run-13-audit: priorVerdicts dedup block ──

  it("omits the prior-verdicts block on the first review (no rounds yet)", () => {
    const p = buildReviewerPrompt(input());
    expect(p).not.toContain("Issues already raised on earlier drafts");
  });

  it("renders the prior-verdicts block when priorVerdicts is non-empty, including severity + kind + location", () => {
    const p = buildReviewerPrompt(input({
      priorVerdicts: [
        {
          verdict: "rewrite_requested",
          overallReaderExperience: "Confusing in the middle.",
          issues: [
            { location: "§2 ¶3", severity: "blocks-understanding", kind: "unsupported",
              what_you_experienced: "Claim 'Bombieri-Vinogradov' invoked without citation",
              what_would_help: "Add a citation or a one-sentence statement." },
            { location: "§3 ¶1", severity: "annoying", kind: "notation",
              what_you_experienced: "Symbol π(x) used before definition",
              what_would_help: "Define it." },
          ],
          verdictReasoning: "Two structural issues; rest is fine.",
        },
      ],
    }));
    expect(p).toContain("Issues already raised on earlier drafts");
    expect(p).toContain("Confusing in the middle");
    expect(p).toContain("[blocks-understanding/unsupported]");
    expect(p).toContain("Claim 'Bombieri-Vinogradov' invoked without citation");
    expect(p).toContain("loc=§2 ¶3");
    // Dedup-directive rules must also appear so the reviewer knows what
    // to do with the block (not just see it).
    expect(p).toContain("DO NOT re-flag");
    expect(p).toContain("APPROVE");
  });

  it("renders MULTIPLE rounds in chronological order", () => {
    const p = buildReviewerPrompt(input({
      priorVerdicts: [
        { verdict: "rewrite_requested", overallReaderExperience: "Round-1 reaction.",
          issues: [{ location: "x", severity: "annoying", kind: "vague",
                     what_you_experienced: "early issue", what_would_help: "fix" }],
          verdictReasoning: "" },
        { verdict: "rewrite_requested", overallReaderExperience: "Round-2 reaction.",
          issues: [{ location: "y", severity: "annoying", kind: "vague",
                     what_you_experienced: "later issue", what_would_help: "fix" }],
          verdictReasoning: "" },
      ],
    }));
    expect(p).toContain("Round 1 (rewrite_requested): Round-1 reaction.");
    expect(p).toContain("Round 2 (rewrite_requested): Round-2 reaction.");
    expect(p.indexOf("Round 1")).toBeLessThan(p.indexOf("Round 2"));
  });

  it("caps each round's issues at 20 items (prompt-bloat protection)", () => {
    const manyIssues = Array.from({ length: 30 }, (_, i) => ({
      location: `loc-${i}`, severity: "annoying" as const, kind: "vague" as const,
      what_you_experienced: `issue-${i}`, what_would_help: "fix",
    }));
    const p = buildReviewerPrompt(input({
      priorVerdicts: [{ verdict: "rewrite_requested", overallReaderExperience: "lots",
                        issues: manyIssues, verdictReasoning: "" }],
    }));
    // First 20 must appear, the remaining 10 must not.
    expect(p).toContain("issue-0");
    expect(p).toContain("issue-19");
    expect(p).not.toContain("issue-20");
    expect(p).not.toContain("issue-29");
  });
});

describe("normalizeVerdict", () => {
  it("treats null input as a default approve", () => {
    const v = normalizeVerdict(null);
    expect(v.verdict).toBe("approve");
    expect(v.issues).toHaveLength(0);
  });
});
