import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { runInitAgent, type InitAgentContext } from "./agent.js";
import { createRun, readRunLedger } from "./runs-ledger.js";
import { readSpine } from "./spine/builder.js";
import { getProjectPapers } from "../../paper-graph/index.js";
import type { InitAgentInput, CrawledResource } from "./types.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";

function fakeLlm(router: (prompt: string) => string): LLMProvider {
  return {
    async describe() {
      return { name: "fake" };
    },
    async chat(req: LLMRequest): Promise<LLMResponse> {
      const prompt = req.messages.map((m) => m.content).join("\n");
      const reply = router(prompt);
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "text", delta: reply };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

const ARXIV_RESULT: CrawledResource[] = [
  {
    id: "arxiv-2401.55555",
    title: "A Sieve Approach to Twin Primes",
    authors: ["J. Maynard"],
    year: 2024,
    sourceType: "arxiv",
    arxivId: "2401.55555",
    url: "https://arxiv.org/abs/2401.55555",
    abstract: "We develop a new sieve.",
  },
];

/**
 * Spine-aware fake LLM. Routes by prompt content and, for node extraction,
 * parses the real paper IDs out of the prompt so the produced spine nodes
 * survive validation.
 */
function spineLlm(): LLMProvider {
  return fakeLlm((prompt) => {
    if (prompt.includes("scoring papers for relevance")) {
      return "[]";
    }
    if (prompt.includes("extracting key mathematical contributions")) {
      const ids = [...prompt.matchAll(/Paper \[([^\]]+)\]/g)].map((m) => m[1]!);
      const nodes = ids.slice(0, 3).map((pid, i) => ({
        id: `node-${i + 1}`,
        type: i === 0 ? "foundation" : "milestone",
        title: `Contribution ${i + 1}`,
        year: 2000 + i,
        authors: ["Author"],
        statement: `Statement ${i + 1}.`,
        significance: "It matters for twin primes.",
        paper_ids: [pid],
        depth: i === 0 ? "foundational" : "major",
        suggested_edges:
          i === 0 ? [] : [{ target: `node-${i}`, type: "improves", context: "builds on" }],
      }));
      return JSON.stringify({ nodes });
    }
    if (prompt.includes("assembling a Narrative Spine")) {
      const ids = [...prompt.matchAll(/- \[([^\]]+)\]/g)].map((m) => m[1]!);
      const edges = ids.slice(1).map((id, i) => ({
        from: ids[i]!,
        to: id,
        type: "enables",
        context: "leads to",
      }));
      return JSON.stringify({
        global_thesis: "The twin prime problem drives sieve theory forward.",
        eras: [
          {
            name: "Modern (2000-2030)",
            start_year: 2000,
            end_year: 2030,
            summary: "Sieve era.",
            node_ids: ids,
          },
        ],
        edges,
        threads: [
          {
            id: "sieve-methods",
            name: "Sieve Methods",
            description: "Bounded gaps via sieves.",
            node_ids: ids,
            status: "active",
            current_frontier: "Bounded gaps of 246.",
          },
        ],
        open_questions: [
          {
            title: "Full Twin Prime",
            statement: "Infinitely many $p, p+2$ prime.",
            related_node_ids: ids.slice(0, 1),
            barrier: "Parity problem.",
            partial_progress: "Bounded gaps.",
          },
        ],
      });
    }
    // effort / thread / wiki documents
    return "> [AI-GENERATED] This content was automatically generated and requires human review.\n\n# Generated\n\nSome $p+2$ content with a @ws:node-1 reference.";
  });
}

function makeInput(overrides: Partial<InitAgentInput> = {}): InitAgentInput {
  return {
    problem: {
      title: "Twin Prime Conjecture",
      formalStatement: "There are infinitely many primes p with p+2 prime.",
      description: "A classic open problem.",
      tags: ["number-theory", "sieve"],
      mathStatus: "OPEN",
    },
    seedReferences: [
      {
        originalInput: "arXiv:1311.1234",
        type: "arxiv",
        arxivId: "1311.1234",
        title: "Bounded gaps between primes",
        authors: ["Yitang Zhang"],
        year: 2014,
        abstract: "Bounded gaps proof.",
      },
    ],
    aiInit: { enableWiki: true, enableWorkspace: true, useSpine: true },
    ...overrides,
  };
}

let workspace: string;
let projectDir: string;

function ctx(extra: Partial<InitAgentContext> = {}): InitAgentContext {
  return {
    workspace,
    projectDir,
    slug: "twin-prime-conjecture",
    runId: "run-spine01",
    llm: spineLlm(),
    rateDelayMs: 0,
    searchArxiv: async () => ARXIV_RESULT,
    fetchNeighbors: async () => [],
    // 2026-06-26 — no enrichment in spine tests for the same reason as
    // agent.test.ts (offline-safe).
    fetchArxivById: async () => null,
    // Reading loop drives the reader; keep it offline by failing the source
    // fetch so each paper degrades to an abstract-only read.
    fetchArxivSource: async (arxivId: string) => ({
      status: "no-source" as const,
      arxivId,
      error: "offline test stub",
    }),
    ...extra,
  };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-spine-agent-"));
  projectDir = path.join(workspace, "projects", "twin-prime-conjecture");
  await fs.mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("runInitAgent — Spine-First pipeline (useSpine=true)", () => {
  it("runs the 4 spine phases and writes a completed run", async () => {
    await createRun(projectDir, { runId: "run-spine01" });
    const result = await runInitAgent(makeInput(), ctx());

    expect(result.mode).toBe("spine");
    expect(result.projectSlug).toBe("twin-prime-conjecture");
    expect(result.summary.spineNodes).toBeGreaterThan(0);

    const ledger = await readRunLedger(projectDir, "run-spine01");
    expect(ledger?.run.status).toBe("completed");
    const phaseNames = ledger?.phases.map((p) => p.phase) ?? [];
    expect(phaseNames).toContain("prior_art_discovery");
    expect(phaseNames).toContain("read_and_explore");
    expect(phaseNames).toContain("build_spine");
    expect(phaseNames).toContain("build_efforts");
    expect(phaseNames).toContain("spine_wiki");
  });

  it("persists spine.json under .mathran/spine", async () => {
    await createRun(projectDir, { runId: "run-spine01" });
    await runInitAgent(makeInput(), ctx());

    const spine = await readSpine(projectDir);
    expect(spine).not.toBeNull();
    expect(spine!.nodes.length).toBeGreaterThan(0);
    const spineFile = path.join(projectDir, ".mathran", "spine", "spine.json");
    const stat = await fs.stat(spineFile);
    expect(stat.isFile()).toBe(true);
  });

  it("writes efforts to efforts/<id>/document.md", async () => {
    await createRun(projectDir, { runId: "run-spine01" });
    const result = await runInitAgent(makeInput(), ctx());
    expect(result.summary.effortsCreated).toBeGreaterThan(0);

    const effortsDir = path.join(projectDir, "efforts");
    const entries = await fs.readdir(effortsDir);
    expect(entries.length).toBeGreaterThan(0);
    const doc = await fs.readFile(
      path.join(effortsDir, entries[0]!, "document.md"),
      "utf-8",
    );
    expect(doc.length).toBeGreaterThan(0);
  });

  it("writes wiki pages to wiki/*.md", async () => {
    await createRun(projectDir, { runId: "run-spine01" });
    const result = await runInitAgent(makeInput(), ctx());
    expect(result.wikiPages.length).toBeGreaterThan(0);

    const wikiDir = path.join(projectDir, "wiki");
    const files = await fs.readdir(wikiDir);
    expect(files.some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("associates discovered papers with the project", async () => {
    await createRun(projectDir, { runId: "run-spine01" });
    await runInitAgent(makeInput(), ctx());
    const assoc = await getProjectPapers(projectDir);
    expect(assoc.length).toBeGreaterThanOrEqual(1);
  });

  it("respects enableWorkspace=false / enableWiki=false", async () => {
    await createRun(projectDir, { runId: "run-spine01" });
    const input = makeInput({
      aiInit: { enableWiki: false, enableWorkspace: false, useSpine: true },
    });
    const result = await runInitAgent(input, ctx());
    expect(result.summary.effortsCreated).toBe(0);
    expect(result.wikiPages).toHaveLength(0);
    // spine itself is still built
    expect(result.summary.spineNodes).toBeGreaterThan(0);
  });

  it("useSpine=false still runs the v1a path (mode undefined, deep_crawl phase)", async () => {
    await createRun(projectDir, { runId: "run-spine01" });
    const input = makeInput({
      aiInit: { enableWiki: true, enableWorkspace: true, useSpine: false },
    });
    const result = await runInitAgent(input, ctx());
    expect(result.mode).toBeUndefined();
    const ledger = await readRunLedger(projectDir, "run-spine01");
    const phaseNames = ledger?.phases.map((p) => p.phase) ?? [];
    expect(phaseNames).toContain("deep_crawl");
    expect(phaseNames).not.toContain("build_spine");
  });
});
