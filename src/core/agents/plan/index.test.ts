import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { runPlanAgent } from "./index.js";
import type { PlanAgentContext } from "./index.js";
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk } from "../../providers/llm.js";
import type { CrawledResource } from "../init-project/types.js";

/** Fake LLM that returns canned replies keyed by prompt content. */
function fakeLlm(router: (prompt: string) => string): LLMProvider {
  return {
    async describe() {
      return { name: "fake" };
    },
    async chat(req: LLMRequest): Promise<LLMResponse> {
      const prompt = req.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
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

const SINGLE_REPLY = JSON.stringify({
  status: "single",
  problem: {
    title: "Twin Prime Conjecture",
    formalStatement: "There are infinitely many primes p with p+2 prime.",
    description: "A classic open problem.",
    background: "Zhang 2014 bounded gaps; Maynard refinements.",
    tags: ["Analytic Number Theory", "Sieve Theory"],
    mscCodes: ["11N05"],
    mathStatus: "OPEN",
  },
});

const RANKING_REPLY = JSON.stringify([
  { index: 0, why: "recent landmark", topicalFit: 0.9, recencyScore: 0.9 },
  { index: 1, why: "survey", topicalFit: 0.8, recencyScore: 0.5 },
  { index: 2, why: "anchor", topicalFit: 0.7, recencyScore: 0.6 },
]);

function seedResources(): CrawledResource[] {
  return [0, 1, 2, 3].map((i) => ({
    id: `arxiv-240${i}.0000${i}`,
    title: `Seed paper ${i}`,
    authors: ["J. Maynard"],
    year: 2024,
    sourceType: "arxiv" as const,
    arxivId: `240${i}.0000${i}`,
    url: `https://arxiv.org/abs/240${i}.0000${i}`,
    abstract: "A sieve approach.",
  }));
}

function baseCtx(over: Partial<PlanAgentContext> = {}): PlanAgentContext {
  return {
    llm: fakeLlm(() => SINGLE_REPLY),
    model: "claude-sonnet-4",
    searchArxiv: async () => seedResources(),
    rateDelayMs: 0,
    fetchArxivById: async () => null,
    ...over,
  };
}

describe("runPlanAgent", () => {
  it("returns a FormalizedProblem for a SINGLE classification", async () => {
    const phases: string[] = [];
    const ctx = baseCtx({
      // Route: plan prompt → SINGLE; seed-ranking prompt → ranking.
      llm: fakeLlm((p) => (p.includes("recommending seed papers") ? RANKING_REPLY : SINGLE_REPLY)),
      emit: (e) => phases.push(e.phase),
    });
    const res = await runPlanAgent({ description: "Twin Prime Conjecture", referenceLinks: [] }, ctx);
    expect(res.status).toBe("single");
    expect(res.problem?.title).toBe("Twin Prime Conjecture");
    expect(res.problem?.mathStatus).toBe("OPEN");
    // No user refs → seed discovery ran and produced 3 seeds.
    expect(res.suggestedSeeds).toHaveLength(3);
    expect(phases).toContain("formalizing");
    expect(phases).toContain("seed_discovery");
    expect(phases).toContain("done");
  });

  it("returns candidates for a MULTIPLE classification", async () => {
    const multiple = JSON.stringify({
      status: "multiple",
      candidates: [
        { title: "Strong Goldbach", description: "even = p+p", why: "default" },
        { title: "Weak Goldbach", description: "odd = p+p+p", why: "Helfgott" },
      ],
    });
    const res = await runPlanAgent(
      { description: "Goldbach" },
      baseCtx({ llm: fakeLlm(() => multiple) }),
    );
    expect(res.status).toBe("multiple");
    expect(res.candidates).toHaveLength(2);
    expect(res.suggestedSeeds).toBeUndefined();
  });

  it("returns suggestions for an INSUFFICIENT classification", async () => {
    const insufficient = JSON.stringify({
      status: "insufficient",
      suggestions: ["Pick a specific sub-problem.", "Which field?"],
    });
    const res = await runPlanAgent(
      { description: "the Langlands program" },
      baseCtx({ llm: fakeLlm(() => insufficient) }),
    );
    expect(res.status).toBe("insufficient");
    expect(res.suggestions).toHaveLength(2);
    expect(res.suggestedSeeds).toBeUndefined();
  });

  it("skips seed discovery when the user supplied reference links", async () => {
    const ctx = baseCtx({
      llm: fakeLlm((p) => (p.includes("recommending seed papers") ? RANKING_REPLY : SINGLE_REPLY)),
      fetchArxivById: async (id) => ({
        id: `arxiv-${id}`,
        title: "Seed",
        authors: ["A"],
        year: 2020,
        sourceType: "arxiv",
        arxivId: id,
        url: `https://arxiv.org/abs/${id}`,
      }),
    });
    const res = await runPlanAgent(
      { description: "Twin Prime Conjecture", referenceLinks: ["2401.00001"] },
      ctx,
    );
    expect(res.status).toBe("single");
    expect(res.suggestedSeeds).toBeUndefined();
    expect(res.references[0]?.resolved).toBe(true);
  });

  it("persists a SINGLE result to <workspace>/.mathran/plans/<slug>.json", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plan-ws-"));
    try {
      const ctx = baseCtx({
        workspace,
        discoverSeeds: false,
        llm: fakeLlm(() => SINGLE_REPLY),
      });
      const res = await runPlanAgent({ description: "Twin Prime Conjecture" }, ctx);
      const expected = path.join(workspace, ".mathran", "plans", "twin-prime-conjecture.json");
      expect(res.savedTo).toBe(expected);
      const saved = JSON.parse(await fs.readFile(expected, "utf-8"));
      expect(saved.problem.title).toBe("Twin Prime Conjecture");
      expect(saved.status).toBe("single");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("propagates and emits an error when the LLM reply is unparseable", async () => {
    const phases: string[] = [];
    const ctx = baseCtx({ llm: fakeLlm(() => "not json"), emit: (e) => phases.push(e.phase) });
    await expect(runPlanAgent({ description: "x" }, ctx)).rejects.toThrow();
    expect(phases).toContain("error");
  });
});
