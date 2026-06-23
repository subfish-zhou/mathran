/**
 * Spine-First Architecture — Explore Pipeline (fs orchestrator).
 *
 * Replaces mathub's Semantic-Scholar/DB explore-pipeline with an fs-only
 * driver that:
 *   1. Supplements seeds with arXiv keyword search (reusing the v1a crawler,
 *      3.5s rate limit honoured)
 *   2. Runs the citation-graph BFS (see citation-explorer.ts)
 *
 * All persistence is the fs paper-graph. Network access is injectable so tests
 * never hit arXiv / a citation source.
 */

import {
  ingestPaper,
  associatePaperToProject,
  type PaperNodeInput,
} from "../../../paper-graph/index.js";
import {
  searchArxiv as realSearchArxiv,
  sleep,
  ARXIV_RATE_DELAY,
} from "../crawlers.js";
import type { CrawledResource } from "../types.js";
import {
  exploreCitationGraph,
  CITATION_MAX_DEPTH,
  CITATION_MAX_NODES,
  type CitationExplorerDeps,
  type NeighborPaper,
} from "../citation-explorer.js";
import { noopEmit, type SpineLLM, type EmitFn } from "./llm.js";
import type { ExploreConfig, ExploreResult } from "./types.js";

export interface ExplorePipelineDeps {
  llm: SpineLLM;
  /** arXiv keyword search seam (defaults to the real crawler). */
  searchArxiv?: (query: string, maxResults: number) => Promise<CrawledResource[]>;
  /** Citation-neighbor discovery seam (default: graph-only). */
  fetchNeighbors?: (paper: import("../../../paper-graph/index.js").PaperNode) => Promise<NeighborPaper[]>;
  rateDelayMs?: number;
  emit?: EmitFn;
}

function resourceToInput(r: CrawledResource): PaperNodeInput {
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

/**
 * Explore the paper graph: keyword search + citation BFS. Returns the
 * discovered / relevant paper id sets. Never throws.
 */
export async function explorePaperGraph(
  config: ExploreConfig,
  deps: ExplorePipelineDeps,
): Promise<ExploreResult> {
  const emit = deps.emit ?? noopEmit;
  const searchArxiv = deps.searchArxiv ?? ((q, n) => realSearchArxiv(q, n));
  const rateDelay = deps.rateDelayMs ?? ARXIV_RATE_DELAY;
  const maxNodes = Math.min(config.maxPapers ?? CITATION_MAX_NODES, CITATION_MAX_NODES);
  const maxDepth = Math.min(config.maxDepth ?? CITATION_MAX_DEPTH, CITATION_MAX_DEPTH);
  const discoveredBy = config.mode === "deep" ? "init" : "patrol";

  const seedIds = new Set<string>(config.seeds);

  // Phase A: keyword arXiv search supplements the seed set.
  const keywords = (config.keywords ?? []).slice(0, 5);
  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i]!;
    if (seedIds.size >= maxNodes) break;
    try {
      const results = await searchArxiv(keyword, 10);
      for (const r of results) {
        if (seedIds.size >= maxNodes) break;
        const paperId = await ingestPaper(config.workspace, resourceToInput(r));
        if (!paperId) continue;
        await associatePaperToProject(config.projectDir, paperId, { discoveredBy, depth: 1, relevanceScore: 0.5 });
        seedIds.add(paperId);
        emit({ type: "paper_discovered", title: r.title, arxivId: r.arxivId, depth: 1 });
      }
      emit({ type: "log", message: `Keyword "${keyword}": ${results.length} results` });
    } catch (err) {
      emit({ type: "log", message: `Keyword search failed for "${keyword}": ${err instanceof Error ? err.message : String(err)}` });
    }
    if (i < keywords.length - 1 && rateDelay > 0) await sleep(rateDelay);
  }

  // Phase B: citation-graph BFS from the (possibly augmented) seed set.
  const citationDeps: CitationExplorerDeps = {
    llm: deps.llm,
    fetchNeighbors: deps.fetchNeighbors,
    emit,
  };
  return exploreCitationGraph(
    {
      workspace: config.workspace,
      projectDir: config.projectDir,
      seeds: [...seedIds],
      problem: config.problem ?? { title: "", formalStatement: "", tags: [] },
      maxDepth,
      maxNodes,
      mode: config.mode,
    },
    citationDeps,
  );
}
