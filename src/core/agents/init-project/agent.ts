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
  readCheckpoint,
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
import { buildSpine, readSpine } from "./spine/builder.js";
import { generateEffortsFromSpine } from "./spine/effort-from-spine.js";
import { generateWikiFromSpine, wikiDir, extractWorkspaceRefs } from "./spine/wiki-from-spine.js";
import { explorePaperGraph } from "./spine/explore-pipeline.js";
import { CITATION_MAX_DEPTH, CITATION_MAX_NODES, type NeighborPaper } from "./citation-explorer.js";
import {
  reviewAndRefinePages,
  verifyPages,
  reviewLinks,
  checkCompleteness,
} from "./review-verify.js";
import type { SpinePipelineEvent, WikiPageOutput, WorkspaceEffortOutput } from "./spine/types.js";
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

  const summary: NonNullable<InitAgentResult["summary"]> & {
    pagesRefined?: number;
    pagesFlagged?: number;
    spineCoverage?: number;
  } = {
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

    // ── Phase 5-8: review / verify / link / completeness (only with wiki) ──
    if (input.aiInit.enableWiki && pages.length > 0) {
      const rvConfig = {
        projectDir,
        pages,
        problem,
        efforts: effortResult.efforts,
        spine,
        tags: problem.tags,
      };

      // Phase 5: review_refine
      await appendPhase(projectDir, runId, "review_refine", "start");
      const review = await reviewAndRefinePages(rvConfig, spineLLM, emit);
      summary.pagesRefined = review.refinedCount;
      await writeCheckpoint(projectDir, runId, "review_refine", {
        refined: review.refinedCount,
        scores: review.scores,
      });
      await appendPhase(projectDir, runId, "review_refine", "end", { refined: review.refinedCount });

      // Phase 6: verify
      await appendPhase(projectDir, runId, "verify", "start");
      const verify = await verifyPages(rvConfig, spineLLM, emit);
      summary.pagesFlagged = verify.flaggedCount;
      await writeCheckpoint(projectDir, runId, "verify", {
        flagged: verify.flaggedCount,
        results: verify.results,
      });
      await appendPhase(projectDir, runId, "verify", "end", { flagged: verify.flaggedCount });

      // Phase 7: link_review (pure)
      await appendPhase(projectDir, runId, "link_review", "start");
      const links = reviewLinks(rvConfig, emit);
      await writeCheckpoint(projectDir, runId, "link_review", {
        brokenWsRefs: links.brokenWsRefs.length,
        brokenWikiLinks: links.brokenWikiLinks.length,
      });
      await appendPhase(projectDir, runId, "link_review", "end", {
        brokenWsRefs: links.brokenWsRefs.length,
        brokenWikiLinks: links.brokenWikiLinks.length,
      });

      // Phase 8: completeness_check (pure)
      await appendPhase(projectDir, runId, "completeness_check", "start");
      const completeness = checkCompleteness(rvConfig, emit);
      summary.spineCoverage = completeness.coverage;
      await writeCheckpoint(projectDir, runId, "completeness_check", {
        coverage: completeness.coverage,
        uncovered: completeness.uncoveredNodeIds,
      });
      await appendPhase(projectDir, runId, "completeness_check", "end", {
        coverage: completeness.coverage,
      });
    }

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

// ============================================================
//  Resume (Spine-First pipeline)
// ============================================================

/**
 * Ordered Spine-First phases. `resumeInitAgent` uses this to decide which
 * phases are already complete (skip + reload artifacts) vs. still pending.
 */
const SPINE_PHASE_ORDER = [
  "explore_graph",
  "build_spine",
  "build_efforts",
  "spine_wiki",
  "review_refine",
  "verify",
  "link_review",
  "completeness_check",
] as const;

export interface ResumeOptions {
  /** Explicit phase to treat as the last *completed* one (default: checkpoint). */
  fromPhase?: string;
}

export class ResumeError extends Error {}

/** Reconstruct minimal efforts (id-only) from the persisted efforts/ dir. */
async function reloadEfforts(projectDir: string): Promise<WorkspaceEffortOutput[]> {
  const effortsRoot = path.join(projectDir, "efforts");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(effortsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory())
    .map((d) => ({
      id: d.name,
      type: "REFERENCE",
      title: d.name,
      description: "",
      status: "DRAFT",
      subject: "",
      sources: [],
      document: "",
      tags: [],
      difficultyEstimate: "MODERATE",
    })) as WorkspaceEffortOutput[];
}

/** Reconstruct wiki pages from persisted wiki/*.md (frontmatter-aware). */
async function reloadPages(projectDir: string): Promise<WikiPageOutput[]> {
  const dir = wikiDir(projectDir);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const pages: WikiPageOutput[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf-8");
      const { slug, title, content } = parseWikiMarkdown(raw, file.replace(/\.md$/, ""));
      pages.push({ slug, title, content, workspaceRefs: extractWorkspaceRefs(content) });
    } catch {
      /* skip unreadable page */
    }
  }
  return pages;
}

function parseWikiMarkdown(raw: string, fallbackSlug: string): { slug: string; title: string; content: string } {
  let slug = fallbackSlug;
  let title = fallbackSlug;
  let content = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = raw.slice(3, end);
      const bodyStart = raw.indexOf("\n", end + 1);
      content = bodyStart === -1 ? "" : raw.slice(bodyStart + 1);
      const slugMatch = fm.match(/^slug:\s*(.+)$/m);
      if (slugMatch) slug = slugMatch[1]!.trim();
      const titleMatch = fm.match(/^title:\s*(.+)$/m);
      if (titleMatch) {
        const t = titleMatch[1]!.trim();
        try {
          title = JSON.parse(t) as string;
        } catch {
          title = t.replace(/^"|"$/g, "");
        }
      }
    }
  }
  return { slug, title, content: content.trim() };
}

/**
 * Resume a Spine-First run from its last checkpoint. Phases at or before the
 * checkpoint are skipped (their fs artifacts are reloaded); pending phases run
 * normally. If the spine itself was never built (checkpoint earlier than
 * `build_spine`), the whole pipeline is re-run from scratch.
 *
 * Throws `ResumeError` when there is no checkpoint to resume from.
 */
export async function resumeInitAgent(
  input: InitAgentInput,
  ctx: InitAgentContext,
  opts: ResumeOptions = {},
): Promise<InitAgentResult> {
  const started = Date.now();
  const { projectDir, slug, runId } = ctx;

  const checkpoint = await readCheckpoint(projectDir, runId);
  const fromPhase = opts.fromPhase ?? checkpoint?.phase;
  if (!fromPhase) {
    throw new ResumeError(`no checkpoint to resume run ${runId}`);
  }

  const fromIdx = SPINE_PHASE_ORDER.indexOf(fromPhase as (typeof SPINE_PHASE_ORDER)[number]);
  const spine = await readSpine(projectDir);

  // Can't do a partial resume without a built spine — restart the full pipeline.
  if (!spine || fromIdx < SPINE_PHASE_ORDER.indexOf("build_spine")) {
    return runInitAgent(input, ctx);
  }

  const spineLLM = makeSpineLLM(ctx.llm, ctx.model);
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
  /** `true` when `phase` already completed (≤ checkpoint) → skip + reload. */
  const done = (phase: (typeof SPINE_PHASE_ORDER)[number]): boolean =>
    fromIdx >= SPINE_PHASE_ORDER.indexOf(phase);

  const summary: NonNullable<InitAgentResult["summary"]> = {
    conceptsExtracted: spine.nodes.length,
    queriesRun: 0,
    resourcesFound: 0,
    wikiPagesGenerated: 0,
    durationMs: 0,
    spineNodes: spine.nodes.length,
    effortsCreated: 0,
    papersDiscovered: 0,
    papersRelevant: 0,
  };

  await appendLog(projectDir, runId, "resume", `resuming run ${runId} from phase ${fromPhase}`);

  try {
    // ── build_efforts ─────────────────────────────────────────────────────
    let efforts: WorkspaceEffortOutput[];
    if (done("build_efforts")) {
      efforts = await reloadEfforts(projectDir);
    } else if (input.aiInit.enableWorkspace) {
      await appendPhase(projectDir, runId, "build_efforts", "start", { resumed: true });
      const effortResult = await generateEffortsFromSpine(
        { spine, projectDir, workspace: ctx.workspace, problemTitle: problem.title },
        spineLLM,
        emit,
      );
      efforts = effortResult.efforts;
      await writeCheckpoint(projectDir, runId, "build_efforts", { efforts: efforts.length });
      await appendPhase(projectDir, runId, "build_efforts", "end", { efforts: efforts.length });
    } else {
      efforts = [];
    }
    summary.effortsCreated = efforts.length;

    // ── spine_wiki ────────────────────────────────────────────────────────
    let pages: WikiPageOutput[];
    if (done("spine_wiki")) {
      pages = await reloadPages(projectDir);
    } else if (input.aiInit.enableWiki) {
      await appendPhase(projectDir, runId, "spine_wiki", "start", { resumed: true });
      pages = await generateWikiFromSpine(
        {
          spine,
          projectDir,
          problem: { ...problem, mathStatus: input.problem.mathStatus },
          paperIds: spine.nodes.flatMap((n) => n.paperIds),
          workspaceEfforts: efforts,
        },
        spineLLM,
        emit,
      );
      await writeCheckpoint(projectDir, runId, "spine_wiki", { wikiPages: pages.map((p) => p.slug) });
      await appendPhase(projectDir, runId, "spine_wiki", "end", { wikiPages: pages.length });
    } else {
      pages = [];
    }
    summary.wikiPagesGenerated = pages.length;

    // ── review / verify / link / completeness ─────────────────────────────
    if (input.aiInit.enableWiki && pages.length > 0) {
      const rvConfig = { projectDir, pages, problem, efforts, spine, tags: problem.tags };

      if (!done("review_refine")) {
        await appendPhase(projectDir, runId, "review_refine", "start", { resumed: true });
        const review = await reviewAndRefinePages(rvConfig, spineLLM, emit);
        await writeCheckpoint(projectDir, runId, "review_refine", { refined: review.refinedCount });
        await appendPhase(projectDir, runId, "review_refine", "end", { refined: review.refinedCount });
      }
      if (!done("verify")) {
        await appendPhase(projectDir, runId, "verify", "start", { resumed: true });
        const verify = await verifyPages(rvConfig, spineLLM, emit);
        await writeCheckpoint(projectDir, runId, "verify", { flagged: verify.flaggedCount });
        await appendPhase(projectDir, runId, "verify", "end", { flagged: verify.flaggedCount });
      }
      if (!done("link_review")) {
        await appendPhase(projectDir, runId, "link_review", "start", { resumed: true });
        const links = reviewLinks(rvConfig, emit);
        await writeCheckpoint(projectDir, runId, "link_review", {
          brokenWsRefs: links.brokenWsRefs.length,
          brokenWikiLinks: links.brokenWikiLinks.length,
        });
        await appendPhase(projectDir, runId, "link_review", "end", {
          brokenWsRefs: links.brokenWsRefs.length,
          brokenWikiLinks: links.brokenWikiLinks.length,
        });
      }
      if (!done("completeness_check")) {
        await appendPhase(projectDir, runId, "completeness_check", "start", { resumed: true });
        const completeness = checkCompleteness(rvConfig, emit);
        await writeCheckpoint(projectDir, runId, "completeness_check", { coverage: completeness.coverage });
        await appendPhase(projectDir, runId, "completeness_check", "end", { coverage: completeness.coverage });
      }
    }

    summary.durationMs = Date.now() - started;
    await appendPhase(projectDir, runId, "completed", "end", { summary, resumed: true });
    await finishRun(projectDir, runId, "completed");

    return {
      projectSlug: slug,
      wikiPages: pages.map((p) => p.slug),
      crawledResources: 0,
      seedPapers: 0,
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
