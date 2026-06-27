import { describe, expect, it } from "vitest";

import { auditPaper, type AuditInput } from "./audit.js";
import { buildAuditPrompt, AUDIT_PROMPT_VERSION } from "./prompts.js";
import type { PaperNode, PaperReadBody } from "../../../paper-graph/types.js";
import type { SpineLLM } from "../spine/llm.js";

function paper(over: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "p1",
    title: "On the ternary Goldbach problem",
    authors: ["H. Helfgott"],
    year: 2013,
    arxivId: "1312.7748",
    isSurvey: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function legitRead(): PaperReadBody {
  return {
    mainResults: [
      {
        label: "Theorem 1.1",
        statement: "Every odd integer $n > 5$ is the sum of three primes.",
        whereInPaper: "§1, p. 2",
        noveltyVsPrior: "Removes the GRH assumption of Deshouillers et al. 1997.",
      },
    ],
    proofStrategy:
      "Combines the circle method with explicit major-arc estimates and a refined large-sieve bound on the minor arcs.",
    keyTechniques: [
      { name: "circle method", role: "split into major/minor arcs" },
      { name: "large sieve", role: "bound minor-arc contribution" },
    ],
    technicalDependencies: [
      { claim: "explicit zero-free region", source: "Platt 2013", whereUsed: "major arcs, §4" },
    ],
    novelContributions: "First unconditional proof of the ternary Goldbach conjecture.",
    standardMaterial: "Circle method setup is standard.",
    hardSteps: ["Making the major-arc estimates fully explicit and rigorous."],
    role: "milestone",
  };
}

function crankRead(): PaperReadBody {
  return {
    mainResults: [],
    proofStrategy: "It is obvious that the result follows by elementary considerations.",
    keyTechniques: [],
    technicalDependencies: [],
    novelContributions:
      "We give a complete and elementary proof of the Riemann Hypothesis in three pages.",
    standardMaterial: "",
    hardSteps: [],
    role: "milestone",
  };
}

function mockLLM(reply: string): SpineLLM {
  return async () => reply;
}

describe("buildAuditPrompt", () => {
  it("embeds metadata, distillation fields, and the watch-list", () => {
    const input: AuditInput = {
      paper: paper(),
      read: legitRead(),
      sourceKind: "tex",
      problemTitle: "ternary Goldbach",
    };
    const prompt = buildAuditPrompt(input);
    expect(prompt).toContain("SENIOR REFEREE");
    expect(prompt).toContain("Theorem 1.1");
    expect(prompt).toContain("circle method");
    expect(prompt).toContain("RED FLAGS");
    expect(prompt).toContain("ternary Goldbach");
    expect(AUDIT_PROMPT_VERSION).toBe("v1");
  });

  it("adds the OCR caveat only for pdf-text sources", () => {
    const base: AuditInput = {
      paper: paper(),
      read: legitRead(),
      sourceKind: "tex",
      problemTitle: "x",
    };
    expect(buildAuditPrompt(base)).not.toContain("PDF/OCR TEXT");
    expect(buildAuditPrompt({ ...base, sourceKind: "pdf-text" })).toContain("PDF/OCR TEXT");
  });
});

describe("auditPaper", () => {
  it("returns trusted on a legit read", async () => {
    const reply = JSON.stringify({
      verdict: "trusted",
      score: 9,
      flags: [],
      reason: "Precise statement, named techniques, plausible dependency.",
    });
    const out = await auditPaper(
      { paper: paper(), read: legitRead(), sourceKind: "tex", problemTitle: "ternary Goldbach" },
      { llm: mockLLM(reply) },
    );
    expect(out.verdict).toBe("trusted");
    expect(out.score).toBe(9);
    expect(out.pass).toBe("fine");
    expect(out.sourceRead).toBe("tex");
  });

  it("returns rejected on a crank read with multiple flags", async () => {
    const reply = JSON.stringify({
      verdict: "rejected",
      score: 2,
      flags: ["no_extractable_statements", "elementary_proof_of_famous_problem", "empty_dependencies"],
      reason: "Claims elementary RH proof; no theorem statements; empty dependencies.",
    });
    const out = await auditPaper(
      { paper: paper({ title: "Elementary proof of RH" }), read: crankRead(), sourceKind: "tex", problemTitle: "RH" },
      { llm: mockLLM(reply) },
    );
    expect(out.verdict).toBe("rejected");
    expect(out.flags.length).toBeGreaterThanOrEqual(3);
  });

  it("returns warn on a pdf-text source where prose is good but formulas are garbled", async () => {
    const reply = JSON.stringify({
      verdict: "warn",
      score: 5,
      flags: ["ocr_artifacts"],
      reason: "Prose is coherent; formulas garbled by OCR; some dependencies missing.",
    });
    const out = await auditPaper(
      { paper: paper(), read: legitRead(), sourceKind: "pdf-text", problemTitle: "x" },
      { llm: mockLLM(reply) },
    );
    expect(out.verdict).toBe("warn");
    expect(out.sourceRead).toBe("pdf");
  });

  it("reconciles an inconsistent label against the score", async () => {
    // LLM says "trusted" but score is 2 → must become rejected.
    const out = await auditPaper(
      { paper: paper(), read: crankRead(), sourceKind: "tex", problemTitle: "x" },
      { llm: mockLLM(JSON.stringify({ verdict: "trusted", score: 2, flags: ["x"], reason: "r" })) },
    );
    expect(out.verdict).toBe("rejected");
  });

  it("never throws — returns warn/llm_error on LLM failure", async () => {
    const failing: SpineLLM = async () => {
      throw new Error("boom");
    };
    const out = await auditPaper(
      { paper: paper(), read: legitRead(), sourceKind: "tex", problemTitle: "x" },
      { llm: failing },
    );
    expect(out.verdict).toBe("warn");
    expect(out.flags).toContain("llm_error");
  });

  it("never throws — returns warn on unparseable JSON", async () => {
    const out = await auditPaper(
      { paper: paper(), read: legitRead(), sourceKind: "tex", problemTitle: "x" },
      { llm: mockLLM("I cannot produce JSON, sorry.") },
    );
    expect(out.verdict).toBe("warn");
    expect(out.flags).toContain("llm_error");
  });
});
