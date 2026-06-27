import { describe, expect, it } from "vitest";

import { rewriteArtifact, type RewriteInput } from "./rewriter.js";
import { buildRewriterPrompt } from "./prompts.js";
import type { ReviewerVerdict } from "./reviewer.js";
import type { SpineLLM } from "../spine/llm.js";
import { makeFullPaperRead } from "../effort-synthesis/test-fixtures.js";

function verdict(overrides: Partial<ReviewerVerdict> = {}): ReviewerVerdict {
  return {
    verdict: "rewrite_requested",
    overallReaderExperience: "Confusing in places.",
    issues: [
      {
        location: "Main Result, paragraph 1",
        severity: "blocks-understanding",
        kind: "vague",
        what_you_experienced: "I couldn't tell what the bound applies to.",
        what_would_help: "State the hypotheses explicitly.",
      },
    ],
    verdictReasoning: "Key claim is vague.",
    ...overrides,
  };
}

function input(overrides: Partial<RewriteInput> = {}): RewriteInput {
  return {
    artifactKind: "effort-document",
    artifactTitle: "Sharp Chromatic Bound",
    originalContent: "# Sharp Chromatic Bound\n\nThe bound holds.",
    reviewerVerdict: verdict(),
    sourcePaperReads: [makeFullPaperRead("n1-paper")],
    topic: "Chromatic numbers",
    ...overrides,
  };
}

describe("rewriteArtifact", () => {
  it("returns the rewritten content produced by the writer model", async () => {
    const llm: SpineLLM = async () =>
      "# Sharp Chromatic Bound\n\nFor every finite simple graph $G$, $\\chi(G)\\le\\Delta(G)+1$.";
    const out = await rewriteArtifact(input(), llm);
    expect(out).toContain("finite simple graph");
    expect(out).not.toBe(input().originalContent);
  });

  it("unwraps a whole-document markdown fence", async () => {
    const llm: SpineLLM = async () => "```markdown\n# Title\n\nbody\n```";
    const out = await rewriteArtifact(input(), llm);
    expect(out).toBe("# Title\n\nbody");
  });

  it("keeps the original content when the writer returns empty or throws", async () => {
    const empty: SpineLLM = async () => "   ";
    expect(await rewriteArtifact(input(), empty)).toBe(input().originalContent);
    const boom: SpineLLM = async () => {
      throw new Error("nope");
    };
    expect(await rewriteArtifact(input(), boom)).toBe(input().originalContent);
  });
});

describe("rewriter prompt — source re-read requirement (§6.4)", () => {
  it("includes the FULL source PaperRead mainResults in the prompt", async () => {
    let captured = "";
    const llm: SpineLLM = async (p) => {
      captured = p;
      return "rewritten";
    };
    await rewriteArtifact(input(), llm);
    // verbatim statement from makeFullPaperRead's Theorem 1.1
    expect(captured).toContain("$\\chi(G) \\le \\Delta(G) + 1$ for every finite simple graph $G$.");
    expect(captured).toContain("@paper-read:n1-paper#mainResult-1");
    expect(captured).toContain("proofStrategy");
  });

  it("emits an explicit source-recheck instruction for an `unsupported` flag", () => {
    const p = buildRewriterPrompt(
      input({
        reviewerVerdict: verdict({
          issues: [
            {
              location: "Body p2",
              severity: "blocks-understanding",
              kind: "unsupported",
              what_you_experienced: "No source for the constant.",
              what_would_help: "Cite the source.",
            },
          ],
        }),
      }),
    );
    expect(p).toMatch(/MUST\s*\n?\s*re-read/);
    expect(p).toContain("Do NOT rewrite these claims from memory");
  });

  it("emits the source-recheck instruction for a `wrong` flag", () => {
    const p = buildRewriterPrompt(
      input({
        reviewerVerdict: verdict({
          issues: [
            {
              location: "Body p2",
              severity: "blocks-understanding",
              kind: "wrong",
              what_you_experienced: "The stated bound looks incorrect.",
              what_would_help: "Recheck against the theorem.",
            },
          ],
        }),
      }),
    );
    expect(p).toContain('"unsupported" or "wrong"');
  });

  it("omits the CRITICAL recheck clause when no unsupported/wrong flags exist", () => {
    const p = buildRewriterPrompt(
      input({
        reviewerVerdict: verdict({
          issues: [
            {
              location: "Intro p1",
              severity: "annoying",
              kind: "redundant",
              what_you_experienced: "Repeats the abstract.",
              what_would_help: "Trim it.",
            },
          ],
        }),
      }),
    );
    expect(p).not.toContain("Do NOT rewrite these claims from memory");
  });
});
