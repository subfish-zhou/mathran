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
