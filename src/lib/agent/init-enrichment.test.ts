import { describe, it, expect, vi } from "vitest";
import { buildSourceCorpus } from "./init-enrichment";
import type { CrawledResource, WorkspaceResult } from "./init-types";

// Mock external dependencies
vi.mock("./azure-llm", () => ({
  callAzureLLM: vi.fn(),
  extractJSON: vi.fn((s: string) => s),
}));

vi.mock("./ref-utils", () => ({
  extractWorkspaceRefs: vi.fn(() => []),
}));

describe("buildSourceCorpus", () => {
  it("includes crawled resources", () => {
    const resources: CrawledResource[] = [
      { id: "r1", title: "Paper 1", authors: ["A"], year: 2024, sourceType: "arxiv", url: "u", abstract: "abs" },
    ];
    const workspace: WorkspaceResult = { efforts: [], edges: [] };
    const corpus = buildSourceCorpus(resources, workspace);
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.title).toBe("Paper 1");
  });

  it("includes non-REFERENCE workspace efforts as known facts", () => {
    const resources: CrawledResource[] = [];
    const workspace: WorkspaceResult = {
      efforts: [
        { id: "e1", type: "PROOF_ATTEMPT", title: "Attempt 1", description: "Desc", status: "DRAFT" },
        { id: "e2", type: "REFERENCE", title: "Ref 1", description: "Desc", status: "REFERENCE" },
      ],
      edges: [],
    };
    const corpus = buildSourceCorpus(resources, workspace);
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.title).toBe("Attempt 1");
  });

  it("combines resources and efforts", () => {
    const resources: CrawledResource[] = [
      { id: "r1", title: "Paper", authors: ["A"], sourceType: "arxiv", url: "u" },
    ];
    const workspace: WorkspaceResult = {
      efforts: [{ id: "e1", type: "ESTIMATE", title: "Est", description: "D", status: "DRAFT" }],
      edges: [],
    };
    const corpus = buildSourceCorpus(resources, workspace);
    expect(corpus).toHaveLength(2);
  });

  it("handles empty inputs", () => {
    const corpus = buildSourceCorpus([], { efforts: [], edges: [] });
    expect(corpus).toEqual([]);
  });

  it("preserves resource metadata", () => {
    const resources: CrawledResource[] = [
      { id: "r1", title: "T", authors: ["A", "B"], year: 2020, sourceType: "journal", url: "u", abstract: "abs" },
    ];
    const corpus = buildSourceCorpus(resources, { efforts: [], edges: [] });
    expect(corpus[0]!.authors).toEqual(["A", "B"]);
    expect(corpus[0]!.year).toBe(2020);
    expect(corpus[0]!.type).toBe("journal");
  });

  it("effort corpus entries have empty authors", () => {
    const workspace: WorkspaceResult = {
      efforts: [{ id: "e1", type: "CONSTRUCTION", title: "C", description: "D", status: "DRAFT" }],
      edges: [],
    };
    const corpus = buildSourceCorpus([], workspace);
    expect(corpus[0]!.authors).toEqual([]);
  });
});
