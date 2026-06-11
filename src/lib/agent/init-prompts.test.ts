import { describe, it, expect } from "vitest";
import {
  buildConceptExtractionPrompt,
  buildWSAnalysisPrompt,
  getMathStatusEmphasis,
  buildSinglePagePrompt,
  buildVerificationPrompt,
  buildCorrectionPrompt,
} from "./init-prompts";

const mockProblem = {
  title: "Kakeya Conjecture",
  formalStatement: "Every Kakeya set in R^n has Hausdorff dimension n",
  description: "A fundamental problem in geometric measure theory",
  backgroundSummary: "The Kakeya conjecture relates to sets containing unit line segments in every direction",
  tags: ["harmonic-analysis", "geometric-measure-theory"],
};

describe("buildConceptExtractionPrompt", () => {
  it("includes problem title", () => {
    const result = buildConceptExtractionPrompt(mockProblem, []);
    expect(result).toContain("Kakeya Conjecture");
  });

  it("includes formal statement", () => {
    const result = buildConceptExtractionPrompt(mockProblem, []);
    expect(result).toContain("Hausdorff dimension");
  });

  it("includes papers when provided", () => {
    const papers = [{ id: "arxiv-1", title: "Paper 1", authors: ["Author A"], year: 2023, sourceType: "arxiv" as const, url: "https://arxiv.org/abs/1", abstract: "Abstract text" }];
    const result = buildConceptExtractionPrompt(mockProblem, papers);
    expect(result).toContain("Paper 1");
    expect(result).toContain("Author A");
  });

  it("includes wiki summary when provided", () => {
    const result = buildConceptExtractionPrompt(mockProblem, [], "Wiki summary about Kakeya");
    expect(result).toContain("Wiki summary about Kakeya");
  });

  it("handles empty papers list", () => {
    const result = buildConceptExtractionPrompt(mockProblem, []);
    expect(result).toContain("(none yet)");
  });

  it("includes tags", () => {
    const result = buildConceptExtractionPrompt(mockProblem, []);
    expect(result).toContain("harmonic-analysis");
  });
});

describe("buildWSAnalysisPrompt", () => {
  it("includes problem info", () => {
    const result = buildWSAnalysisPrompt(mockProblem, []);
    expect(result).toContain("Kakeya Conjecture");
  });

  it("includes resources", () => {
    const resources = [{ id: "r1", title: "Resource Paper", authors: ["Auth1", "Auth2", "Auth3"], year: 2024, sourceType: "arxiv" as const, url: "u" }];
    const result = buildWSAnalysisPrompt(mockProblem, resources);
    expect(result).toContain("Resource Paper");
    expect(result).toContain("et al.");
  });

  it("includes full text excerpts when provided", () => {
    const resources = [{ id: "r1", title: "R", authors: ["A"], sourceType: "arxiv" as const, url: "u" }];
    const fullTexts = new Map([["r1", "This is the full text of the paper..."]]);
    const result = buildWSAnalysisPrompt(mockProblem, resources, fullTexts);
    expect(result).toContain("Full text excerpt:");
  });
});

describe("getMathStatusEmphasis", () => {
  it("returns solved emphasis", () => {
    expect(getMathStatusEmphasis("SOLVED")).toContain("SOLVED");
    expect(getMathStatusEmphasis("SOLVED")).toContain("proof history");
  });
  it("returns open emphasis", () => {
    expect(getMathStatusEmphasis("OPEN")).toContain("OPEN");
  });
  it("returns partially solved emphasis", () => {
    expect(getMathStatusEmphasis("PARTIALLY_SOLVED")).toContain("PARTIALLY SOLVED");
  });
  it("returns disputed emphasis", () => {
    expect(getMathStatusEmphasis("DISPUTED")).toContain("DISPUTED");
  });
  it("returns default for unknown", () => {
    expect(getMathStatusEmphasis("SOMETHING")).toContain("balanced coverage");
  });
});

describe("buildSinglePagePrompt", () => {
  const workspace = { efforts: [], edges: [] };
  const spec = { slug: "overview", title: "Overview", instruction: "Write an overview" };

  it("includes page spec", () => {
    const result = buildSinglePagePrompt(mockProblem, workspace, spec);
    expect(result).toContain("Overview");
    expect(result).toContain("overview");
  });

  it("includes math status", () => {
    const result = buildSinglePagePrompt(mockProblem, workspace, spec, "SOLVED");
    expect(result).toContain("SOLVED");
  });

  it("includes related page titles", () => {
    const result = buildSinglePagePrompt(mockProblem, workspace, spec, undefined, ["History", "Approaches"]);
    expect(result).toContain("History");
    expect(result).toContain("Approaches");
  });
});

describe("buildVerificationPrompt", () => {
  const page = { slug: "overview", title: "Overview", content: "Some wiki content about math", workspaceRefs: [] };
  const corpus = [{ id: "s1", title: "Source Paper", authors: ["A"], year: 2024, abstract: "This is a long enough abstract for testing purposes that exceeds thirty characters", type: "arxiv" }];

  it("includes page content", () => {
    const result = buildVerificationPrompt(page, mockProblem, corpus);
    expect(result).toContain("Some wiki content");
  });

  it("includes source corpus", () => {
    const result = buildVerificationPrompt(page, mockProblem, corpus);
    expect(result).toContain("Source Paper");
  });

  it("handles empty corpus", () => {
    const result = buildVerificationPrompt(page, mockProblem, []);
    expect(result).toContain("no sources with abstracts available");
  });
});

describe("buildCorrectionPrompt", () => {
  const page = { slug: "overview", title: "Overview", content: "Content with errors", workspaceRefs: [] };
  const issues = [{ pageSlug: "overview", claim: "Wrong claim", status: "incorrect" as const, severity: "major" as const, explanation: "This is wrong", sourceEvidence: "Source says X", suggestedFix: "Fix it" }];

  it("includes issues", () => {
    const result = buildCorrectionPrompt(page, issues, mockProblem, []);
    expect(result).toContain("Wrong claim");
    expect(result).toContain("Source says X");
    expect(result).toContain("Fix it");
  });

  it("includes page content", () => {
    const result = buildCorrectionPrompt(page, issues, mockProblem, []);
    expect(result).toContain("Content with errors");
  });
});
