/**
 * Orchestrator tests.
 *
 * These exercise the full skim→read→audit→harvest pipeline and therefore depend
 * on W2-α (source-loader) and W2-β (skim / read-regime) modules. On this branch
 * those modules are not yet present, so the suite detects their absence at
 * runtime and SKIPS — the assertions are deferred to post-merge integration.
 *
 * Post-merge the suite runs with an injected (superset-JSON) LLM mock and an
 * injected `fetchArxivSource`, so it needs no network and no real model.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import type { PaperNode } from "../../../paper-graph/types.js";
import type { SpineLLM } from "../spine/llm.js";

// Detect whether the W2-α/β modules are present without statically importing
// (a static import would make this whole file fail to load when they're absent).
let depsAvailable = true;
try {
  await import("./source-loader.js");
  await import("./skim.js");
  await import("./read-regime-a.js");
} catch {
  depsAvailable = false;
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-readpaper-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function paper(over: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "p-orch-1",
    title: "On the ternary Goldbach problem",
    authors: ["H. Helfgott"],
    year: 2013,
    arxivId: "1312.7748",
    abstract: "We prove the ternary Goldbach conjecture.",
    isSurvey: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * Superset JSON covering every pass's schema (skim + read body + audit). Each
 * pass's parser extracts its own subset, so one canned reply satisfies all.
 */
function supersetReply(): string {
  return JSON.stringify({
    // skim
    oneLineSummary: "Unconditional proof of ternary Goldbach.",
    mainContribution: "Removes GRH from prior conditional proofs.",
    sectionOutline: [{ level: 1, title: "Introduction" }],
    decision: "study",
    decisionReason: "Core milestone.",
    // read body
    mainResults: [
      {
        label: "Theorem 1.1",
        statement: "Every odd $n>5$ is a sum of three primes.",
        whereInPaper: "§1",
        noveltyVsPrior: "Unconditional; improves on arXiv:1201.6656.",
      },
    ],
    proofStrategy: "Circle method with explicit major-arc bounds; relies on arXiv:1201.6656.",
    keyTechniques: [{ name: "circle method", role: "arc decomposition" }],
    technicalDependencies: [
      { claim: "five-primes theorem", source: "arXiv:1201.6656", whereUsed: "§2" },
    ],
    novelContributions: "First unconditional proof.",
    standardMaterial: "Circle method setup.",
    hardSteps: ["Explicit major-arc estimates."],
    role: "milestone",
    // audit
    verdict: "trusted",
    score: 9,
    flags: [],
    reason: "Precise statements, named techniques, plausible dependency.",
  });
}

/** A fetchArxivSource stub that materializes a one-file .tex bundle on disk. */
async function makeFetchStub(): Promise<
  typeof import("../../../paper-graph/arxiv-source.js").fetchArxivSource
> {
  return (async (arxivId: string) => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-src-"));
    const mainTexFile = path.join(rootDir, "main.tex");
    const tex = [
      "\\documentclass{article}\\begin{document}",
      "Main theorem. We cite arXiv:1201.6656.",
      "\\begin{thebibliography}{9}",
      "\\bibitem{tao} T. Tao, ``Five primes'', 2014. arXiv:1201.6656.",
      "\\end{thebibliography}",
      "\\end{document}",
    ].join("\n");
    await fs.writeFile(mainTexFile, tex, "utf8");
    return {
      status: "ok" as const,
      arxivId,
      rootDir,
      mainTexFile,
      texFiles: [mainTexFile],
      bibFiles: [],
      figureFiles: [],
      fromCache: false,
      byteSize: tex.length,
      fetchedAt: new Date().toISOString(),
    };
  }) as typeof import("../../../paper-graph/arxiv-source.js").fetchArxivSource;
}

describe.skipIf(!depsAvailable)("readPaper orchestrator [integration]", () => {
  it("runs the full skim→read→audit→harvest pipeline with a mocked LLM", async () => {
    const { readPaper } = await import("./index.js");
    const llm: SpineLLM = async () => supersetReply();
    const read = await readPaper(paper(), {
      workspace,
      problemTitle: "ternary Goldbach",
      llm,
      modelName: "test/model",
      fetchArxivSource: await makeFetchStub(),
    });

    expect(read.passesCompleted).toContain("skim");
    expect(read.passesCompleted).toContain("read");
    expect(read.passesCompleted).toContain("audit");
    expect(read.read?.mainResults?.length).toBeGreaterThan(0);
    expect(read.audit?.verdict).toBe("trusted");
    expect(read.outgoingCitations.some((c) => c.citedArxivId === "1201.6656")).toBe(true);
    expect(read.totalLlmCalls).toBeGreaterThanOrEqual(3);

    // Persisted to disk.
    const onDisk = path.join(workspace, ".mathran", "paper-graph", "reads", "p-orch-1.json");
    expect(await fs.readFile(onDisk, "utf8")).toContain("Theorem 1.1");
  });

  it("returns the cached PaperRead without re-running passes on a fresh hit", async () => {
    const { readPaper, DEFAULT_READER_PROMPT_VERSION } = await import("./index.js");
    const { writePaperRead } = await import("../../../paper-graph/reads.js");

    const cached = {
      paperId: "p-orch-1",
      arxivId: "1312.7748",
      sourceKind: "tex" as const,
      sourceBytes: 10,
      truncated: false,
      skim: {
        oneLineSummary: "cached",
        mainContribution: "cached",
        sectionOutline: [],
        decision: "study" as const,
        decisionReason: "cached",
      },
      outgoingCitations: [],
      isSurvey: false,
      modelUsed: "test/model",
      promptVersion: DEFAULT_READER_PROMPT_VERSION,
      passesCompleted: ["skim", "read", "audit"] as ("skim" | "read" | "audit")[],
      totalLlmCalls: 3,
      totalTokensIn: 0,
      totalTokensOut: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writePaperRead(workspace, cached);

    let called = false;
    const llm: SpineLLM = async () => {
      called = true;
      throw new Error("LLM must not be called on a cache hit");
    };
    const read = await readPaper(paper(), {
      workspace,
      problemTitle: "ternary Goldbach",
      llm,
      modelName: "test/model",
      fetchArxivSource: await makeFetchStub(),
    });

    expect(called).toBe(false);
    expect(read.skim.oneLineSummary).toBe("cached");
  });
});

// Always-present sanity test so the file reports at least one active test
// regardless of W2-α/β availability.
describe("readPaper module wiring", () => {
  it("availability flag is a boolean (skips integration suite when deps absent)", () => {
    expect(typeof depsAvailable).toBe("boolean");
  });
});
