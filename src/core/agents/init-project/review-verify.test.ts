import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  reviewAndRefinePages,
  verifyPages,
  reviewLinks,
  checkCompleteness,
  type ReviewVerifyConfig,
  type ReviewProblem,
} from "./review-verify.js";
import { wikiDir } from "./spine/wiki-from-spine.js";
import type { SpineLLM } from "./spine/llm.js";
import type {
  WikiPageOutput,
  WorkspaceEffortOutput,
  NarrativeSpine,
  SpineNode,
} from "./spine/types.js";

/**
 * Build a routing fake `SpineLLM`. The router maps a prompt to a reply string;
 * unmatched prompts return `""` so callers can assert defensive fallbacks.
 */
function fakeLlm(router: (prompt: string) => string): SpineLLM {
  return async (prompt) => router(prompt);
}

function page(overrides: Partial<WikiPageOutput> = {}): WikiPageOutput {
  return {
    slug: "twin-primes",
    title: "Twin Primes",
    content: "# Twin Primes\n\nSome content about $p, p+2$.",
    workspaceRefs: [],
    ...overrides,
  };
}

const PROBLEM: ReviewProblem = {
  title: "Twin Prime Conjecture",
  formalStatement: "There are infinitely many primes p with p+2 prime.",
  description: "A classic open problem.",
  tags: ["number-theory", "sieve"],
};

function effort(id: string): WorkspaceEffortOutput {
  return {
    id,
    type: "exploration" as WorkspaceEffortOutput["type"],
    title: `Effort ${id}`,
    description: "",
    status: "active" as WorkspaceEffortOutput["status"],
    subject: "",
    sources: [],
    document: "",
    tags: [],
    difficultyEstimate: "medium" as WorkspaceEffortOutput["difficultyEstimate"],
  };
}

function spineWith(nodes: Array<Partial<SpineNode>>): NarrativeSpine {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    globalThesis: "thesis",
    eras: [],
    nodes: nodes.map((n, i) => ({
      id: n.id ?? `node-${i + 1}`,
      type: (n.type ?? "milestone") as SpineNode["type"],
      title: n.title ?? `Node ${i + 1}`,
      statement: n.statement ?? "stmt",
      significance: n.significance ?? "sig",
      paperIds: n.paperIds ?? [],
      effortIds: n.effortIds ?? [],
      depth: (n.depth ?? "major") as SpineNode["depth"],
      ...n,
    })) as SpineNode[],
    edges: [],
    threads: [],
    openQuestions: [],
  };
}

let projectDir: string;

function config(overrides: Partial<ReviewVerifyConfig> = {}): ReviewVerifyConfig {
  return {
    projectDir,
    pages: [page()],
    problem: PROBLEM,
    ...overrides,
  };
}

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-rv-"));
});
afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

async function readWiki(slug: string): Promise<string> {
  return fs.readFile(path.join(wikiDir(projectDir), `${slug}.md`), "utf-8");
}

describe("reviewAndRefinePages — phase: refine", () => {
  it("refines and rewrites a low-scoring page to fs", async () => {
    const llm = fakeLlm((prompt) => {
      if (prompt.includes("reviewing a mathematical wiki page")) {
        return JSON.stringify({
          overallScore: 3,
          issues: [{ section: "intro", problem: "vague", suggestion: "clarify" }],
        });
      }
      if (prompt.includes("refining a mathematical wiki page")) {
        return "# Twin Primes\n\nRefined content referencing @ws:e1.";
      }
      return "";
    });

    const result = await reviewAndRefinePages(config({ efforts: [effort("e1")] }), llm);
    expect(result.refinedCount).toBe(1);
    expect(result.scores[0]!.score).toBe(3);
    expect(result.scores[0]!.refined).toBe(true);

    const written = await readWiki("twin-primes");
    expect(written).toContain("Refined content");
    expect(written).toContain("[AI-GENERATED]");
    // workspaceRefs are re-extracted from the refined content
    expect(result.pages[0]!.workspaceRefs).toContain("e1");
  });

  it("leaves a high-scoring page untouched (no refine)", async () => {
    const llm = fakeLlm((prompt) => {
      if (prompt.includes("reviewing a mathematical wiki page")) {
        return JSON.stringify({ overallScore: 9, issues: [] });
      }
      return "SHOULD NOT BE CALLED";
    });

    const result = await reviewAndRefinePages(config(), llm);
    expect(result.refinedCount).toBe(0);
    expect(result.scores[0]!.refined).toBe(false);
    expect(result.scores[0]!.score).toBe(9);
  });

  it("treats invalid review JSON as a safe high score (no throw, no refine)", async () => {
    const llm = fakeLlm(() => "this is not json at all");
    const result = await reviewAndRefinePages(config(), llm);
    expect(result.refinedCount).toBe(0);
    expect(result.scores[0]!.score).toBe(10);
    expect(result.scores[0]!.skipped).toBeUndefined();
  });

  it("isolates a thrown LLM error to a skipped sentinel", async () => {
    const llm: SpineLLM = async () => {
      throw new Error("llm exploded");
    };
    const result = await reviewAndRefinePages(config(), llm);
    expect(result.scores[0]!.skipped).toBe(true);
    expect(result.scores[0]!.score).toBe(-1);
    expect(result.refinedCount).toBe(0);
  });

  it("does not refine when score is low but no issues are listed", async () => {
    const llm = fakeLlm((prompt) => {
      if (prompt.includes("reviewing a mathematical wiki page")) {
        return JSON.stringify({ overallScore: 2, issues: [] });
      }
      return "REFINED";
    });
    const result = await reviewAndRefinePages(config(), llm);
    expect(result.refinedCount).toBe(0);
    expect(result.scores[0]!.refined).toBe(false);
  });
});

describe("verifyPages — phase: verify", () => {
  it("flags a page and stamps verification: flagged frontmatter", async () => {
    const llm = fakeLlm(() =>
      JSON.stringify({ status: "flagged", flaggedClaims: ["bad claim"] }),
    );
    const result = await verifyPages(config(), llm);
    expect(result.flaggedCount).toBe(1);
    expect(result.results[0]!.status).toBe("flagged");
    expect(result.results[0]!.flaggedClaims).toContain("bad claim");

    const written = await readWiki("twin-primes");
    expect(written).toContain("verification: flagged");
  });

  it("marks a clean page verified", async () => {
    const llm = fakeLlm(() => JSON.stringify({ status: "verified", flaggedClaims: [] }));
    const result = await verifyPages(config(), llm);
    expect(result.flaggedCount).toBe(0);
    expect(result.results[0]!.status).toBe("verified");
    const written = await readWiki("twin-primes");
    expect(written).toContain("verification: verified");
  });

  it("treats invalid verify JSON as verified (safe fallback, no throw)", async () => {
    const llm = fakeLlm(() => "not-json");
    const result = await verifyPages(config(), llm);
    expect(result.results[0]!.status).toBe("verified");
    expect(result.flaggedCount).toBe(0);
  });

  it("isolates a thrown LLM error to a skipped result", async () => {
    const llm: SpineLLM = async () => {
      throw new Error("verify boom");
    };
    const result = await verifyPages(config(), llm);
    expect(result.results[0]!.status).toBe("skipped");
    expect(result.flaggedCount).toBe(0);
  });
});

describe("reviewLinks — phase: link_review (pure)", () => {
  it("flags broken @ws refs and broken [[wiki]] links", () => {
    const pages: WikiPageOutput[] = [
      page({
        slug: "a",
        content: "Links @ws:e1 (ok) and @ws:missing (broken) and [[b]] (ok) and [[ghost]] (broken).",
      }),
      page({ slug: "b", content: "Backlink [[a]]." }),
    ];
    const result = reviewLinks(config({ pages, efforts: [effort("e1")] }));
    expect(result.brokenWsRefs).toEqual([{ slug: "a", ref: "missing" }]);
    expect(result.brokenWikiLinks).toEqual([{ slug: "a", target: "ghost" }]);
  });

  it("reports no broken links when everything resolves", () => {
    const pages: WikiPageOutput[] = [
      page({ slug: "a", content: "Good @ws:e1 and [[b]]." }),
      page({ slug: "b", content: "Plain page." }),
    ];
    const result = reviewLinks(config({ pages, efforts: [effort("e1")] }));
    expect(result.brokenWsRefs).toHaveLength(0);
    expect(result.brokenWikiLinks).toHaveLength(0);
  });
});

describe("checkCompleteness — phase: completeness_check (pure)", () => {
  it("returns full coverage when there is no spine", () => {
    const result = checkCompleteness(config());
    expect(result.coverage).toBe(1);
    expect(result.totalNodes).toBe(0);
  });

  it("computes partial coverage and lists uncovered node ids", () => {
    const spine = spineWith([
      { id: "n1", effortIds: ["e1"] },
      { id: "n2", effortIds: [] },
    ]);
    const result = checkCompleteness(config({ spine }));
    expect(result.totalNodes).toBe(2);
    expect(result.coveredNodes).toBe(1);
    expect(result.coverage).toBeCloseTo(0.5);
    expect(result.uncoveredNodeIds).toEqual(["n2"]);
  });
});
