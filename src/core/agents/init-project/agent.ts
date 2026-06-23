/**
 * init-project agent — fs-only, DB-free port of mathub's init-agent.ts.
 *
 * v1a pipeline (4 core phases):
 *   seed_research → deep_crawl → build_wiki → completed
 *
 * (review/verify/spine pipeline are v1b — see PLAN.)
 *
 * All persistence is fs: the workspace paper-graph, the project↔paper
 * associations, the runs ledger, and the generated wiki pages. The LLM
 * provider is mathran's own `LLMProvider` abstraction (injected).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { LLMProvider, LLMStreamChunk } from "../../providers/llm.js";
import {
  ingestSeedPapersForProject,
  ingestPaper,
  associatePaperToProject,
  type PaperNodeInput,
} from "../../paper-graph/index.js";
import {
  appendPhase,
  appendLog,
  writeCheckpoint,
  finishRun,
} from "./runs-ledger.js";
import {
  searchArxiv as realSearchArxiv,
  fetchWikipediaSummary as realFetchWiki,
  sleep,
  ARXIV_RATE_DELAY,
} from "./crawlers.js";
import { buildConceptExtractionPrompt, buildWikiPagePrompt } from "./prompts.js";
import type {
  InitAgentInput,
  InitAgentResult,
  CrawledResource,
  ParsedReference,
} from "./types.js";
import { makeSpineLLM } from "./spine/llm.js";
import { buildSpine } from "./spine/builder.js";
import { generateEffortsFromSpine } from "./spine/effort-from-spine.js";
import { generateWikiFromSpine } from "./spine/wiki-from-spine.js";
import { explorePaperGraph } from "./spine/explore-pipeline.js";
import { CITATION_MAX_DEPTH, CITATION_MAX_NODES, type NeighborPaper } from "./citation-explorer.js";
import type { SpinePipelineEvent } from "./spine/types.js";
import type { PaperNode } from "../../paper-graph/index.js";

export interface InitAgentContext {
  workspace: string;
  projectDir: string;
  slug: string;
  runId: string;
  llm: LLMProvider;
  model?: string;
  /** Test seams — default to the real network crawlers. */
  searchArxiv?: (query: string, maxResults: number) => Promise<CrawledResource[]>;
  fetchWikipediaSummary?: (topic: string) => Promise<string | null>;
  /** Override the arXiv rate-limit delay (tests pass 0). */
  rateDelayMs?: number;
  /**
   * Citation-neighbor discovery seam for the Spine-First pipeline. mathran
   * ships no network citation source, so the host wires this (arXiv / S2);
   * tests inject a fake. Default: graph-only BFS.
   */
  fetchNeighbors?: (paper: PaperNode) => Promise<NeighborPaper[]>;
}

const DEPTH_PARAMS: Record<string, { maxQueries: number; perQuery: number }> = {
  quick: { maxQueries: 2, perQuery: 3 },
  standard: { maxQueries: 4, perQuery: 5 },
  deep: { maxQueries: 8, perQuery: 8 },
};

/** Consume an LLM stream and return concatenated text. */
async function collectText(stream: AsyncIterable<LLMStreamChunk>): Promise<string> {
  let out = "";
  for await (const ch of stream) {
    if (ch.type === "text") out += ch.delta;
  }
  return out;
}

async function llmComplete(
  llm: LLMProvider,
  model: string | undefined,
  prompt: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const resp = await llm.chat({
    model: model ?? "",
    messages: [{ role: "user", content: prompt }],
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  });
  return collectText(resp.stream());
}

/** Best-effort extraction of a JSON object from an LLM reply. */
export function extractJSON<T = unknown>(text: string): T | null {
  if (!text) return null;
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidate = fence[1].trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function refToResource(ref: ParsedReference): CrawledResource | null {
  const arxivId = ref.arxivId ?? (ref.type === "arxiv" ? extractArxivId(ref.originalInput) : undefined);
  const url = ref.url ?? (arxivId ? `https://arxiv.org/abs/${arxivId}` : ref.originalInput);
  if (!ref.title && !arxivId && !ref.doi) {
    // Nothing resolvable — keep as a bare webpage resource.
    return {
      id: `seed-${slugifyId(ref.originalInput)}`,
      title: ref.originalInput,
      authors: [],
      sourceType: "webpage",
      url,
    };
  }
  return {
    id: arxivId ? `arxiv-${arxivId}` : ref.doi ? `doi-${slugifyId(ref.doi)}` : `seed-${slugifyId(ref.originalInput)}`,
    title: ref.title ?? (arxivId ? `arXiv:${arxivId}` : ref.originalInput),
    authors: ref.authors ?? [],
    year: ref.year,
    sourceType: arxivId ? "arxiv" : "journal",
    arxivId,
    doi: ref.doi,
    url,
    abstract: ref.abstract,
  };
}

export function extractArxivId(input: string): string | undefined {
  const m = input.match(/(\d{4}\.\d{4,5})(?:v\d+)?/) || input.match(/([a-z\-]+\/\d{7})(?:v\d+)?/);
  return m?.[1];
}

function slugifyId(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
}

function resourceToNodeInput(r: CrawledResource): PaperNodeInput {
  return {
    title: r.title,
    authors: r.authors,
    year: r.year,
    abstract: r.abstract,
    url: r.url,
    arxivId: r.arxivId,
    doi: r.doi,
    categories: r.categories,
    isSurvey: r.isSurvey,
  };
}

function wikiFrontmatter(title: string, slug: string, tags: string[]): string {
  const createdAt = new Date().toISOString();
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `slug: ${slug}`,
    `createdAt: ${createdAt}`,
    `tags: [${[...new Set([...tags, "ai-generated"])].map((t) => JSON.stringify(t)).join(", ")}]`,
    "version: 1",
    "---",
    "",
  ].join("\n");
}

/**
 * Run the 4-phase init pipeline. Never throws — failures are recorded in the
 * runs ledger and the run is flipped to `error`. Returns the result on success.
 */
export async function runInitAgent(
  input: InitAgentInput,
  ctx: InitAgentContext,
): Promise<InitAgentResult> {
  if (input.aiInit.useSpine) {
    return runInitAgentSpine(input, ctx);
  }
  const started = Date.now();
  const { workspace, projectDir, slug, runId, llm, model } = ctx;
  const searchArxiv = ctx.searchArxiv ?? ((q, n) => realSearchArxiv(q, n));
  const fetchWiki = ctx.fetchWikipediaSummary ?? ((t) => realFetchWiki(t));
  const rateDelay = ctx.rateDelayMs ?? ARXIV_RATE_DELAY;
  const depth = DEPTH_PARAMS[input.aiInit.searchDepth] ?? DEPTH_PARAMS.standard!;

  const summary = {
    conceptsExtracted: 0,
    queriesRun: 0,
    resourcesFound: 0,
    wikiPagesGenerated: 0,
    durationMs: 0,
  };

  try {
    // ── Phase 1: seed_research ────────────────────────────────────────────
    await appendPhase(projectDir, runId, "seed_research", "start");
    const seeds: CrawledResource[] = [];
    for (const ref of input.seedReferences) {
      const res = refToResource(ref);
      if (res) seeds.push(res);
    }

    const seedResult = await ingestSeedPapersForProject(
      workspace,
      projectDir,
      seeds.map(resourceToNodeInput),
      { discoveredBy: "seed", relevanceScore: 1.0, depth: 0 },
    );
    await appendLog(projectDir, runId, "seed_ingest", `ingested ${seedResult.ingested.length} seeds (${seedResult.failed} failed)`);

    let wikiSummary: string | null = null;
    try {
      wikiSummary = await fetchWiki(input.problem.title);
    } catch {
      wikiSummary = null;
    }

    let queries: string[] = [];
    let concepts: Array<{ name: string; importance?: number }> = [];
    try {
      const prompt = buildConceptExtractionPrompt(input.problem, seeds, wikiSummary);
      const reply = await llmComplete(llm, model, prompt, { temperature: 0.2, maxTokens: 1500 });
      await appendLog(projectDir, runId, "llm_call", "concept extraction", { chars: reply.length });
      const parsed = extractJSON<{ concepts?: Array<{ name: string; importance?: number }>; search_queries?: string[] }>(reply);
      concepts = parsed?.concepts ?? [];
      queries = (parsed?.search_queries ?? []).filter((q): q is string => typeof q === "string" && q.trim().length > 0);
    } catch (err) {
      await appendLog(projectDir, runId, "warn", `concept extraction failed: ${errMsg(err)}`);
    }
    if (queries.length === 0) {
      // Fallback: derive queries from the problem title + tags so deep_crawl
      // still has something to chew on even if the LLM call failed.
      queries = [input.problem.title, ...(input.problem.tags ?? [])].filter(Boolean).slice(0, depth.maxQueries);
    }
    queries = queries.slice(0, depth.maxQueries);
    summary.conceptsExtracted = concepts.length;

    await writeCheckpoint(projectDir, runId, "seed_research", {
      seedPapers: seedResult.ingested.length,
      concepts: concepts.length,
      queries,
    });
    await appendPhase(projectDir, runId, "seed_research", "end", {
      seedPapers: seedResult.ingested.length,
      concepts: concepts.length,
      queries: queries.length,
    });

    // ── Phase 2: deep_crawl ───────────────────────────────────────────────
    await appendPhase(projectDir, runId, "deep_crawl", "start", { queries: queries.length });
    const seenArxiv = new Set<string>(seeds.map((s) => s.arxivId).filter(Boolean) as string[]);
    const allResources: CrawledResource[] = [...seeds];

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i]!;
      try {
        const found = await searchArxiv(query, depth.perQuery);
        summary.queriesRun += 1;
        for (const r of found) {
          if (r.arxivId && seenArxiv.has(r.arxivId)) continue;
          if (r.arxivId) seenArxiv.add(r.arxivId);
          allResources.push(r);
          const paperId = await ingestPaper(workspace, resourceToNodeInput(r));
          if (paperId) {
            await associatePaperToProject(projectDir, paperId, { discoveredBy: "crawl", depth: 1, relevanceScore: 0.6 });
          }
        }
        await appendLog(projectDir, runId, "crawl_query", query, { found: found.length });
      } catch (err) {
        await appendLog(projectDir, runId, "warn", `arxiv query failed: ${errMsg(err)}`, { query });
      }
      if (i < queries.length - 1 && rateDelay > 0) await sleep(rateDelay);
    }
    summary.resourcesFound = allResources.length;

    await writeCheckpoint(projectDir, runId, "deep_crawl", { resourcesFound: allResources.length });
    await appendPhase(projectDir, runId, "deep_crawl", "end", { resourcesFound: allResources.length });

    // ── Phase 3: build_wiki ───────────────────────────────────────────────
    await appendPhase(projectDir, runId, "build_wiki", "start");
    const wikiDir = path.join(projectDir, "wiki");
    await fs.mkdir(wikiDir, { recursive: true });
    const tags = input.problem.tags ?? [];
    const wikiPages: string[] = [];

    let indexBody = "";
    try {
      indexBody = await llmComplete(
        llm,
        model,
        buildWikiPagePrompt(input.problem, allResources, {
          slug: "index",
          title: input.problem.title,
          instruction:
            "Write the project home page: introduce the problem, summarize its background and current status, and survey the key references and approaches found. Provide a roadmap of the research landscape.",
        }),
        { temperature: 0.3, maxTokens: 3000 },
      );
      await appendLog(projectDir, runId, "llm_call", "wiki index generation", { chars: indexBody.length });
    } catch (err) {
      await appendLog(projectDir, runId, "warn", `wiki generation failed: ${errMsg(err)}`);
    }
    if (!indexBody.trim()) {
      indexBody = `> [AI-GENERATED] Wiki generation produced no content.\n\n# ${input.problem.title}\n\n${input.problem.description ?? ""}`;
    }
    await fs.writeFile(
      path.join(wikiDir, "index.md"),
      wikiFrontmatter(input.problem.title, "index", tags) + indexBody.trim() + "\n",
      "utf-8",
    );
    wikiPages.push("index");

    // References page — generated deterministically from the crawl corpus.
    const refBody = buildReferencesMarkdown(allResources);
    await fs.writeFile(
      path.join(wikiDir, "references.md"),
      wikiFrontmatter("References", "references", [...tags, "references"]) + refBody + "\n",
      "utf-8",
    );
    wikiPages.push("references");
    summary.wikiPagesGenerated = wikiPages.length;

    await writeCheckpoint(projectDir, runId, "build_wiki", { wikiPages });
    await appendPhase(projectDir, runId, "build_wiki", "end", { wikiPages: wikiPages.length });

    // ── Phase 4: completed ────────────────────────────────────────────────
    summary.durationMs = Date.now() - started;
    await appendPhase(projectDir, runId, "completed", "end", { summary });
    await finishRun(projectDir, runId, "completed");

    return {
      projectSlug: slug,
      wikiPages,
      crawledResources: allResources.length,
      seedPapers: seedResult.ingested.length,
      summary,
    };
  } catch (err) {
    await appendPhase(projectDir, runId, "error", "end", { error: errMsg(err) });
    await finishRun(projectDir, runId, "error", errMsg(err));
    throw err;
  }
}

/**
 * Spine-First pipeline (v1b, useSpine=true). Four phases:
 *   explore_graph → build_spine → build_efforts → spine_wiki → completed
 *
 * Never throws on the happy path beyond the v1a contract: failures inside a
 * phase are isolated by the underlying spine modules (console.warn + fallback);
 * a hard failure flips the run to `error` and rethrows, exactly like v1a.
 */
async function runInitAgentSpine(
  input: InitAgentInput,
  ctx: InitAgentContext,
): Promise<InitAgentResult> {
  const started = Date.now();
  const { workspace, projectDir, slug, runId, llm, model } = ctx;
  const searchArxiv = ctx.searchArxiv ?? ((q, n) => realSearchArxiv(q, n));
  const rateDelay = ctx.rateDelayMs ?? ARXIV_RATE_DELAY;
  const depth = DEPTH_PARAMS[input.aiInit.searchDepth] ?? DEPTH_PARAMS.standard!;
  const spineLLM = makeSpineLLM(llm, model);

  // Forward spine pipeline events into the runs ledger as logs (fire-and-forget;
  // appendLog is failure-isolated and never throws).
  const emit = (e: SpinePipelineEvent): void => {
    const msg = e.type === "log" ? e.message : e.type;
    void appendLog(projectDir, runId, "spine", msg, e as unknown as Record<string, unknown>);
  };

  const problem = {
    title: input.problem.title,
    formalStatement: input.problem.formalStatement ?? "",
    description: input.problem.description ?? "",
    tags: input.problem.tags ?? [],
  };

  const summary = {
    conceptsExtracted: 0,
    queriesRun: 0,
    resourcesFound: 0,
    wikiPagesGenerated: 0,
    durationMs: 0,
    spineNodes: 0,
    effortsCreated: 0,
    papersDiscovered: 0,
    papersRelevant: 0,
  };

  try {
    // ── Phase 1: explore_graph ────────────────────────────────────────────
    await appendPhase(projectDir, runId, "explore_graph", "start");
    const seeds: CrawledResource[] = [];
    for (const ref of input.seedReferences) {
      const res = refToResource(ref);
      if (res) seeds.push(res);
    }
    const seedResult = await ingestSeedPapersForProject(
      workspace,
      projectDir,
      seeds.map(resourceToNodeInput),
      { discoveredBy: "seed", relevanceScore: 1.0, depth: 0 },
    );
    await appendLog(projectDir, runId, "seed_ingest", `ingested ${seedResult.ingested.length} seeds (${seedResult.failed} failed)`);

    const keywords = [input.problem.title, ...(input.problem.tags ?? [])]
      .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      .slice(0, Math.max(1, Math.min(5, depth.maxQueries)));

    const explore = await explorePaperGraph(
      {
        projectDir,
        workspace,
        seeds: seedResult.ingested,
        keywords,
        mode: "deep",
        maxDepth: CITATION_MAX_DEPTH,
        maxPapers: CITATION_MAX_NODES,
        problem: { title: problem.title, formalStatement: problem.formalStatement, tags: problem.tags },
      },
      { llm: spineLLM, searchArxiv, fetchNeighbors: ctx.fetchNeighbors, rateDelayMs: rateDelay, emit },
    );
    summary.papersDiscovered = explore.discoveredPaperIds.length;
    summary.papersRelevant = explore.relevantPaperIds.length;
    summary.resourcesFound = explore.discoveredPaperIds.length;

    const spinePaperIds =
      explore.relevantPaperIds.length > 0 ? explore.relevantPaperIds : explore.discoveredPaperIds;

    await writeCheckpoint(projectDir, runId, "explore_graph", {
      seedPapers: seedResult.ingested.length,
      discovered: explore.discoveredPaperIds.length,
      relevant: explore.relevantPaperIds.length,
    });
    await appendPhase(projectDir, runId, "explore_graph", "end", {
      discovered: explore.discoveredPaperIds.length,
      relevant: explore.relevantPaperIds.length,
    });

    // ── Phase 2: build_spine ──────────────────────────────────────────────
    await appendPhase(projectDir, runId, "build_spine", "start", { papers: spinePaperIds.length });
    const spine = await buildSpine(
      { projectDir, workspace, paperIds: spinePaperIds, mode: "full", problem },
      spineLLM,
      emit,
    );
    summary.spineNodes = spine.nodes.length;
    summary.conceptsExtracted = spine.nodes.length;
    await writeCheckpoint(projectDir, runId, "build_spine", {
      nodes: spine.nodes.length,
      edges: spine.edges.length,
      threads: spine.threads.length,
    });
    await appendPhase(projectDir, runId, "build_spine", "end", {
      nodes: spine.nodes.length,
      threads: spine.threads.length,
    });

    // ── Phase 3: build_efforts ────────────────────────────────────────────
    await appendPhase(projectDir, runId, "build_efforts", "start");
    const effortResult = input.aiInit.enableWorkspace
      ? await generateEffortsFromSpine(
          { spine, projectDir, workspace, problemTitle: problem.title },
          spineLLM,
          emit,
        )
      : { efforts: [], edges: [] };
    summary.effortsCreated = effortResult.efforts.length;
    await writeCheckpoint(projectDir, runId, "build_efforts", {
      efforts: effortResult.efforts.length,
      edges: effortResult.edges.length,
    });
    await appendPhase(projectDir, runId, "build_efforts", "end", {
      efforts: effortResult.efforts.length,
    });

    // ── Phase 4: spine_wiki ───────────────────────────────────────────────
    await appendPhase(projectDir, runId, "spine_wiki", "start");
    const wikiProblem = { ...problem, mathStatus: input.problem.mathStatus };
    const pages = input.aiInit.enableWiki
      ? await generateWikiFromSpine(
          {
            spine,
            projectDir,
            problem: wikiProblem,
            paperIds: spinePaperIds,
            workspaceEfforts: effortResult.efforts,
          },
          spineLLM,
          emit,
        )
      : [];
    const wikiPages = pages.map((p) => p.slug);
    summary.wikiPagesGenerated = wikiPages.length;
    await writeCheckpoint(projectDir, runId, "spine_wiki", { wikiPages });
    await appendPhase(projectDir, runId, "spine_wiki", "end", { wikiPages: wikiPages.length });

    // ── completed ─────────────────────────────────────────────────────────
    summary.durationMs = Date.now() - started;
    await appendPhase(projectDir, runId, "completed", "end", { summary });
    await finishRun(projectDir, runId, "completed");

    return {
      projectSlug: slug,
      wikiPages,
      crawledResources: explore.discoveredPaperIds.length,
      seedPapers: seedResult.ingested.length,
      mode: "spine",
      summary,
    };
  } catch (err) {
    await appendPhase(projectDir, runId, "error", "end", { error: errMsg(err) });
    await finishRun(projectDir, runId, "error", errMsg(err));
    throw err;
  }
}

function buildReferencesMarkdown(resources: CrawledResource[]): string {
  const lines = ["> [AI-GENERATED] This reference list was assembled automatically and requires human review.", "", "# References", ""];
  if (resources.length === 0) {
    lines.push("_No references were discovered during initialization._");
    return lines.join("\n");
  }
  for (const r of resources) {
    const auth = r.authors.length > 0 ? r.authors.join(", ") : "Unknown";
    const year = r.year ? ` (${r.year})` : "";
    lines.push(`- **${r.title}** — ${auth}${year}. [${r.arxivId ? `arXiv:${r.arxivId}` : r.sourceType}](${r.url})`);
  }
  return lines.join("\n");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
