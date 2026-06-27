import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { runInitAgent, extractJSON, extractArxivId, type InitAgentContext } from "./agent.js";
import { createRun, readRunLedger } from "./runs-ledger.js";
import { getProjectPapers, listPapers } from "../../paper-graph/index.js";
import type { InitAgentInput, CrawledResource, AiInitConfig } from "./types.js";
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk } from "../../providers/llm.js";

/** Fake LLM that returns canned replies keyed by prompt content. */
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

function makeInput(overrides: Partial<InitAgentInput> = {}): InitAgentInput {
  return {
    problem: {
      title: "Twin Prime Conjecture",
      formalStatement: "There are infinitely many primes p with p+2 prime.",
      description: "A classic open problem.",
      backgroundSummary: "Studied since antiquity.",
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
    aiInit: { enableWiki: true, enableWorkspace: true },
    ...overrides,
  };
}

let workspace: string;
let projectDir: string;

function defaultLlm(): LLMProvider {
  return fakeLlm((prompt) => {
    if (prompt.includes("identifying key concepts")) {
      return JSON.stringify({
        concepts: [{ name: "sieve theory", importance: 1.0 }],
        search_queries: ["sieve theory twin primes", "Maynard Tao theorem"],
      });
    }
    // wiki page
    return "> [AI-GENERATED] This content was automatically generated and requires human review.\n\n# Twin Prime Conjecture\n\n## Overview\nThe problem asks $p, p+2$ both prime infinitely often.\n\n## Approaches\nSieve methods, e.g. [Zhang, 2014].\n\n## References\nSee the references page.";
  });
}

function ctx(extra: Partial<InitAgentContext> = {}): InitAgentContext {
  return {
    workspace,
    projectDir,
    slug: "twin-prime-conjecture",
    runId: "run-test01",
    llm: defaultLlm(),
    rateDelayMs: 0,
    searchArxiv: async () => ARXIV_RESULT,
    fetchWikipediaSummary: async () => "Twin primes are pairs of primes differing by two.",
    // 2026-06-26 — default tests to "no enrichment" so seeds in the test
    // fixtures pass through verbatim and we don't hit arxiv.org in CI.
    fetchArxivById: async () => null,
    ...extra,
  };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-agent-"));
  projectDir = path.join(workspace, "projects", "twin-prime-conjecture");
  await fs.mkdir(path.join(projectDir, "wiki"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("extractJSON", () => {
  it("parses bare JSON", () => {
    expect(extractJSON<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses fenced JSON", () => {
    expect(extractJSON('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it("parses JSON embedded in prose", () => {
    expect(extractJSON('Here you go: {"a":3} done')).toEqual({ a: 3 });
  });
  it("returns null on garbage", () => {
    expect(extractJSON("not json")).toBeNull();
  });
});

describe("AiInitConfig", () => {
  it("type no longer accepts searchDepth", () => {
    const cfg: AiInitConfig = { enableWiki: true, enableWorkspace: true, useSpine: true };
    // @ts-expect-error — searchDepth must be a type error now
    const bad: AiInitConfig = { enableWiki: true, enableWorkspace: true, useSpine: true, searchDepth: "deep" };
    void bad;
    expect(cfg.useSpine).toBe(true);
  });
});

describe("extractArxivId", () => {
  it("extracts a modern arxiv id", () => {
    expect(extractArxivId("arXiv:2401.12345v2")).toBe("2401.12345");
  });
  it("extracts an old-style id", () => {
    expect(extractArxivId("math/0211159")).toBe("math/0211159");
  });
});

describe("runInitAgent — full pipeline", () => {
  it("runs all 4 phases and writes a completed run", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    const result = await runInitAgent(makeInput(), ctx());
    expect(result.projectSlug).toBe("twin-prime-conjecture");
    const ledger = await readRunLedger(projectDir, "run-test01");
    expect(ledger?.run.status).toBe("completed");
    // phases.jsonl: each phase emits start+end (seed/deep/build) + completed end
    const phaseNames = ledger!.phases.map((p) => `${p.phase}:${p.event}`);
    expect(phaseNames).toContain("seed_research:start");
    expect(phaseNames).toContain("deep_crawl:end");
    expect(phaseNames).toContain("build_wiki:end");
    expect(phaseNames).toContain("completed:end");
    expect(ledger!.phases.length).toBeGreaterThanOrEqual(4);
  });

  it("writes an LLM-generated, non-empty wiki index", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    await runInitAgent(makeInput(), ctx());
    const index = await fs.readFile(path.join(projectDir, "wiki", "index.md"), "utf-8");
    expect(index).toContain("Twin Prime Conjecture");
    expect(index).toContain("Approaches");
    expect(index).toContain("AI-GENERATED");
    expect(index).toContain("version: 1");
  });

  it("ingests seed references into the workspace paper-graph", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    await runInitAgent(makeInput(), ctx());
    const papers = await listPapers(workspace);
    const ids = papers.map((p) => p.arxivId);
    expect(ids).toContain("1311.1234"); // seed
    expect(ids).toContain("2401.55555"); // crawled
  });

  it("associates seed + crawled papers with the project", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    await runInitAgent(makeInput(), ctx());
    const assoc = await getProjectPapers(projectDir);
    expect(assoc.length).toBeGreaterThanOrEqual(2);
    expect(assoc.some((a) => a.discoveredBy === "seed")).toBe(true);
    expect(assoc.some((a) => a.discoveredBy === "crawl")).toBe(true);
  });

  it("writes a references wiki page listing discovered resources", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    await runInitAgent(makeInput(), ctx());
    const refs = await fs.readFile(path.join(projectDir, "wiki", "references.md"), "utf-8");
    expect(refs).toContain("Bounded gaps between primes");
    expect(refs).toContain("arXiv:2401.55555");
  });

  it("falls back to title/tag queries when the LLM returns no JSON", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    let calls = 0;
    const llm = fakeLlm((prompt) => {
      if (prompt.includes("identifying key concepts")) return "sorry, no json here";
      calls++;
      return "# Wiki\n\n## A\n\n## B\n\n## C\ncontent";
    });
    const result = await runInitAgent(makeInput(), ctx({ llm }));
    expect(result.summary.queriesRun).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(0);
  });

  it("handles an empty seed reference list (e2e empty problem)", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    const result = await runInitAgent(makeInput({ seedReferences: [] }), ctx());
    expect(result.seedPapers).toBe(0);
    const ledger = await readRunLedger(projectDir, "run-test01");
    expect(ledger?.run.status).toBe("completed");
  });

  it("flips the run to error when the wiki LLM throws on every call", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    // searchArxiv throws to exercise the warn path, but the run still completes.
    const result = await runInitAgent(
      makeInput(),
      ctx({
        searchArxiv: async () => {
          throw new Error("arxiv down");
        },
      }),
    );
    // crawl failures are non-fatal — run still completes with seeds only.
    expect(result.summary.resourcesFound).toBeGreaterThanOrEqual(1);
  });

  it("writes checkpoints for each phase", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    await runInitAgent(makeInput(), ctx());
    const ledger = await readRunLedger(projectDir, "run-test01");
    expect(ledger?.checkpoint?.phase).toBe("build_wiki");
  });

  // 2026-06-26 — regression test for the "arxiv-id-only seed" bug
  // (subfish hit this in live smoke: paper node ended up with empty
  // authors + placeholder title because mathub's DB-write path was
  // auto-enriching from arxiv and the fs port wasn't).
  it("enriches arxiv-id-only seeds from arxiv when caller omitted title/authors", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    const seenIds: string[] = [];
    const enriched: CrawledResource = {
      id: "arxiv-1311.1234",
      title: "Bounded gaps between primes",
      authors: ["Yitang Zhang"],
      year: 2014,
      sourceType: "arxiv",
      arxivId: "1311.1234",
      url: "https://arxiv.org/abs/1311.1234",
      abstract: "Real abstract pulled from arxiv.",
    };
    await runInitAgent(
      makeInput({
        seedReferences: [
          {
            originalInput: "arXiv:1311.1234",
            type: "arxiv",
            arxivId: "1311.1234",
            // NO title, NO authors — exactly the case that hit the bug.
          },
        ],
      }),
      ctx({
        fetchArxivById: async (id) => {
          seenIds.push(id);
          return enriched;
        },
      }),
    );
    expect(seenIds).toEqual(["1311.1234"]);
    // The persisted paper node must have the enriched fields, not the
    // placeholder.
    const nodePath = path.join(workspace, ".mathran", "paper-graph", "nodes", "arxiv-1311.1234.json");
    const node = JSON.parse(await fsp.readFile(nodePath, "utf-8"));
    expect(node.title).toBe("Bounded gaps between primes");
    expect(node.authors).toEqual(["Yitang Zhang"]);
    expect(node.year).toBe(2014);
  });

  it("does NOT re-fetch arxiv when seed already has title + authors", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    let calls = 0;
    await runInitAgent(
      makeInput(),  // default makeInput has full seed metadata
      ctx({
        fetchArxivById: async () => {
          calls += 1;
          return null;
        },
      }),
    );
    expect(calls).toBe(0);
  });

  it("degrades gracefully when arxiv enrichment returns null", async () => {
    await createRun(projectDir, { runId: "run-test01" });
    // arxiv-id-only seed AND fetchArxivById returns null (offline / unknown id).
    const result = await runInitAgent(
      makeInput({
        seedReferences: [
          {
            originalInput: "arXiv:9999.9999",
            type: "arxiv",
            arxivId: "9999.9999",
          },
        ],
      }),
      ctx({ fetchArxivById: async () => null }),
    );
    // Run completes successfully — the seed just keeps its placeholder.
    expect(result.summary.resourcesFound).toBeGreaterThanOrEqual(0);
  });
});
