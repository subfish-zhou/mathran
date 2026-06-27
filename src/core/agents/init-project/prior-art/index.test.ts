import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { discoverPriorArt, loadPriorArt } from "./index.js";
import type { SpineLLM } from "../spine/llm.js";
import type { CrawledResource } from "../types.js";
import { getPaperByArxiv } from "../../../paper-graph/index.js";

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-priorart-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const problem = {
  title: "Lonely Runner Conjecture",
  tags: ["combinatorics"],
  slug: "lonely-runner",
};

function res(arxivId: string, title: string): CrawledResource {
  return {
    id: `arxiv-${arxivId}`,
    title,
    authors: ["A. Author"],
    sourceType: "arxiv",
    url: `https://arxiv.org/abs/${arxivId}`,
    abstract: "survey",
    arxivId,
  };
}

const BOURBAKI_HTML = `<a href="/s/1234.pdf">1234. J. Dupont — Lonely runner survey (2025)</a>`;

function moApi(): (url: string) => Promise<unknown> {
  return async (url: string) => {
    if (url.includes("/search/advanced"))
      return { items: [{ question_id: 9, title: "Status of the lonely runner conjecture", score: 30, link: "https://mathoverflow.net/q/9" }] };
    if (url.includes("/answers"))
      return { items: [{ answer_id: 1, question_id: 9, score: 75, body_markdown: "A long answer.", owner: { display_name: "Expert" } }] };
    return { items: [] };
  };
}

describe("discoverPriorArt", () => {
  it("merges all three sources, ingests arxiv surveys, and persists the corpus", async () => {
    const llm: SpineLLM = async () =>
      JSON.stringify([{ index: 0, surveyConfidence: 0.9, matchedReason: "Clear survey" }]);

    const corpus = await discoverPriorArt(problem, {
      workspace,
      llm,
      searchArxiv: async () => [res("2401.00001", "A Survey of the Lonely Runner Conjecture")],
      fetchBourbakiIndex: async () => BOURBAKI_HTML,
      fetchMathOverflowApi: moApi(),
      rateDelayMs: 0,
    });

    const sources = new Set(corpus.surveys.map((s) => s.source));
    expect(sources.has("arxiv")).toBe(true);
    expect(sources.has("bourbaki")).toBe(true);
    expect(sources.has("mathoverflow")).toBe(true);
    expect(corpus.expositoryAnswers).toHaveLength(1);
    expect(corpus.discoveredAt).toBeTruthy();

    // sorted by confidence descending
    for (let i = 1; i < corpus.surveys.length; i++) {
      expect(corpus.surveys[i - 1]!.confidence).toBeGreaterThanOrEqual(corpus.surveys[i]!.confidence);
    }

    // arxiv survey ingested into the paper graph with isSurvey=true
    const node = await getPaperByArxiv(workspace, "2401.00001");
    expect(node).not.toBeNull();
    expect(node!.isSurvey).toBe(true);

    // persisted to disk and loadable
    const file = path.join(workspace, ".mathran", "prior-art", "lonely-runner.json");
    await fs.access(file);
    const loaded = await loadPriorArt(workspace, "lonely-runner");
    expect(loaded).not.toBeNull();
    expect(loaded!.surveys.length).toBe(corpus.surveys.length);
  });

  it("external ids use bourbaki:/mo: prefixes", async () => {
    const llm: SpineLLM = async () => "[]";
    const corpus = await discoverPriorArt(problem, {
      workspace,
      llm,
      searchArxiv: async () => [],
      fetchBourbakiIndex: async () => BOURBAKI_HTML,
      fetchMathOverflowApi: moApi(),
      rateDelayMs: 0,
    });
    expect(corpus.surveys.some((s) => s.paperId.startsWith("bourbaki:"))).toBe(true);
    expect(corpus.surveys.some((s) => s.paperId.startsWith("mo:"))).toBe(true);
  });

  it("survives total failure of all sub-searches", async () => {
    const llm: SpineLLM = async () => {
      throw new Error("llm down");
    };
    const corpus = await discoverPriorArt(problem, {
      workspace,
      llm,
      searchArxiv: async () => {
        throw new Error("arxiv down");
      },
      fetchBourbakiIndex: async () => {
        throw new Error("bourbaki down");
      },
      fetchMathOverflowApi: async () => {
        throw new Error("mo down");
      },
      rateDelayMs: 0,
    });
    expect(corpus.surveys).toEqual([]);
    expect(corpus.expositoryAnswers).toEqual([]);
  });

  it("loadPriorArt returns null when no corpus persisted", async () => {
    expect(await loadPriorArt(workspace, "nonexistent")).toBeNull();
  });
});
