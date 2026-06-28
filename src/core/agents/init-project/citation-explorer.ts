/**
 * Citation-graph BFS explorer (fs port of mathub's explore-pipeline citation
 * BFS, minus Semantic Scholar / DB).
 *
 * Starting from seed paper node IDs, it walks the citation graph breadth-first:
 *   1. Pull neighbors that already exist in the fs paper-graph (citations.jsonl)
 *   2. Optionally discover new neighbors via an injected `fetchNeighbors` seam
 *      (the host wires this to arXiv / Semantic Scholar; tests inject a fake —
 *      mathran ships no network citation source)
 *   3. LLM batch relevance scoring; papers scoring >= threshold are kept and
 *      their neighborhood is expanded (until depth / node caps).
 *
 * Hard caps mirror mathub: max depth = 2, max nodes = 80.
 */

import { slugify } from "../../../lib/slug.js";
import {
  getPaper,
  listCitations,
  ingestPaper,
  ingestCitation,
  associatePaperToProject,
} from "../../paper-graph/index.js";
import type { PaperNode, PaperNodeInput } from "../../paper-graph/index.js";
import { buildRelevanceScoringPrompt } from "./spine/prompts.js";
import { extractSpineJSON, errMsg, noopEmit, type SpineLLM, type EmitFn } from "./spine/llm.js";
import type { ExploreResult } from "./spine/types.js";

export const CITATION_MAX_DEPTH = 2;
export const CITATION_MAX_NODES = 80;
const SCORE_BATCH = 15;
const RELEVANCE_THRESHOLD = 5;

/** A citation neighbor returned by the `fetchNeighbors` discovery seam. */
export interface NeighborPaper {
  title: string;
  authors: string[];
  year?: number;
  arxivId?: string;
  doi?: string;
  abstract?: string;
  url?: string;
  /** "citation" = cites the source paper; "reference" = cited by it. */
  direction: "citation" | "reference";
}

export interface CitationExplorerConfig {
  workspace: string;
  projectDir: string;
  /** Seed paper node IDs to start from. */
  seeds: string[];
  problem: { title: string; formalStatement: string; tags: string[] };
  maxDepth?: number;
  maxNodes?: number;
  mode?: "deep" | "incremental";
}

export interface CitationExplorerDeps {
  llm: SpineLLM;
  /** Discover new citation neighbors for a paper (default: graph-only). */
  fetchNeighbors?: (paper: PaperNode) => Promise<NeighborPaper[]>;
  emit?: EmitFn;
}

interface FrontierEntry {
  paperId: string;
  depth: number;
  priority: number;
}

function neighborToInput(n: NeighborPaper): PaperNodeInput {
  return {
    title: n.title,
    authors: n.authors ?? [],
    year: n.year,
    abstract: n.abstract,
    url: n.url,
    arxivId: n.arxivId,
    doi: n.doi,
  };
}

/**
 * Walk the citation graph from `seeds`, scoring relevance with the LLM. Never
 * throws — discovery/scoring failures degrade to a depth heuristic.
 */
export async function exploreCitationGraph(
  config: CitationExplorerConfig,
  deps: CitationExplorerDeps,
): Promise<ExploreResult> {
  const { workspace, projectDir } = config;
  const maxDepth = Math.min(config.maxDepth ?? CITATION_MAX_DEPTH, CITATION_MAX_DEPTH);
  const maxNodes = Math.min(config.maxNodes ?? CITATION_MAX_NODES, CITATION_MAX_NODES);
  const discoveredBy = (config.mode ?? "deep") === "deep" ? "init" : "patrol";
  const emit = deps.emit ?? noopEmit;
  const fetchNeighbors = deps.fetchNeighbors ?? (async () => []);

  const explored = new Set<string>();
  const relevant: string[] = [];
  const discovered = new Set<string>(config.seeds);
  const frontier: FrontierEntry[] = [];
  const inFrontier = new Set<string>();
  const seedSet = new Set<string>(config.seeds);
  let totalRounds = 0;

  // Build an adjacency map from existing fs citation edges.
  const graphAdj = await buildGraphAdjacency(workspace);

  emit({ type: "log", message: `Citation BFS from ${config.seeds.length} seeds (maxDepth=${maxDepth}, maxNodes=${maxNodes})` });

  const enqueueNeighbors = async (sourceId: string, depth: number, priority: number): Promise<void> => {
    if (discovered.size >= maxNodes) return;
    const source = await getPaper(workspace, sourceId);

    // 1. Existing graph neighbors.
    for (const neighborId of graphAdj.get(sourceId) ?? new Set<string>()) {
      if (discovered.size >= maxNodes) break;
      await considerNeighbor(neighborId, depth, priority);
    }

    // 2. Newly discovered neighbors via the injected seam.
    if (source) {
      let neighbors: NeighborPaper[] = [];
      try {
        neighbors = await fetchNeighbors(source);
      } catch (err) {
        emit({ type: "log", message: `fetchNeighbors failed for ${sourceId}: ${errMsg(err)}` });
      }
      for (const n of neighbors) {
        if (discovered.size >= maxNodes) break;
        const neighborId = await ingestPaper(workspace, neighborToInput(n));
        if (!neighborId) continue;
        // Citation edge direction.
        if (n.direction === "citation") await ingestCitation(workspace, neighborId, sourceId);
        else await ingestCitation(workspace, sourceId, neighborId);
        emit({ type: "paper_discovered", title: n.title, arxivId: n.arxivId, depth });
        await considerNeighbor(neighborId, depth, priority);
      }
    }
  };

  const considerNeighbor = async (neighborId: string, depth: number, priority: number): Promise<void> => {
    await associatePaperToProject(projectDir, neighborId, { discoveredBy, depth });
    discovered.add(neighborId);
    if (!explored.has(neighborId) && !seedSet.has(neighborId) && !inFrontier.has(neighborId)) {
      frontier.push({ paperId: neighborId, depth, priority });
      inFrontier.add(neighborId);
    }
  };

  // Phase A: seeds are relevant by construction; expand their neighborhoods.
  for (const seedId of config.seeds) {
    if (discovered.size >= maxNodes) break;
    explored.add(seedId);
    relevant.push(seedId);
    await enqueueNeighbors(seedId, 1, 0.9);
  }

  // Phase B: BFS with LLM scoring.
  const safetyRoundLimit = Math.max(maxDepth * 2, Math.ceil(maxNodes / 5));
  while (frontier.length > 0 && relevant.length < maxNodes) {
    totalRounds++;
    if (totalRounds > safetyRoundLimit) {
      emit({ type: "log", message: `BFS safety limit hit (${totalRounds} rounds); stopping with ${relevant.length} relevant` });
      break;
    }

    frontier.sort((a, b) => b.priority - a.priority);
    const batch = frontier.splice(0, Math.min(SCORE_BATCH, frontier.length));
    for (const e of batch) inFrontier.delete(e.paperId);

    const toScore = batch.filter((e) => !explored.has(e.paperId));
    if (toScore.length === 0) continue;

    const papers = (await Promise.all(toScore.map((e) => getPaper(workspace, e.paperId)))).filter(
      (p): p is PaperNode => p != null,
    );
    if (papers.length === 0) continue;

    const entryById = new Map(toScore.map((e) => [e.paperId, e]));
    const scoringPapers = papers.map((p) => ({
      id: p.id,
      title: p.title,
      authors: p.authors ?? [],
      year: p.year,
      abstract: p.abstract,
    }));

    const scores = await scoreRelevance(scoringPapers, config.problem, deps.llm, emit, entryById);

    for (const s of scores) {
      const entry = entryById.get(s.id);
      const paper = papers.find((p) => p.id === s.id);
      if (!entry || !paper) continue;

      explored.add(entry.paperId);
      emit({ type: "paper_scored", title: paper.title, score: s.score });

      if (s.score >= RELEVANCE_THRESHOLD) {
        relevant.push(entry.paperId);
        await associatePaperToProject(projectDir, entry.paperId, {
          discoveredBy,
          depth: entry.depth,
          relevanceScore: s.score / 10,
        });
        if (entry.depth < maxDepth && relevant.length < maxNodes) {
          await enqueueNeighbors(
            entry.paperId,
            entry.depth + 1,
            (s.score / 10) * (1 - entry.depth / maxDepth),
          );
        }
      }
    }

    emit({ type: "log", message: `Round ${totalRounds}: scored ${toScore.length}, ${relevant.length} relevant so far` });
  }

  emit({ type: "log", message: `Citation BFS complete: ${relevant.length} relevant / ${discovered.size} discovered (${totalRounds} rounds)` });

  return {
    discoveredPaperIds: [...discovered],
    relevantPaperIds: relevant,
    totalRounds,
  };
}

async function buildGraphAdjacency(workspace: string): Promise<Map<string, Set<string>>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const edge of await listCitations(workspace)) {
    add(edge.citingPaperId, edge.citedPaperId);
    add(edge.citedPaperId, edge.citingPaperId);
  }
  return adj;
}

async function scoreRelevance(
  papers: Array<{ id: string; title: string; authors: string[]; year?: number; abstract?: string }>,
  problem: { title: string; formalStatement: string; tags: string[] },
  llm: SpineLLM,
  emit: EmitFn,
  entryById: Map<string, FrontierEntry>,
): Promise<Array<{ id: string; score: number }>> {
  const prompt = buildRelevanceScoringPrompt(papers, {
    title: problem.title,
    formalStatement: problem.formalStatement,
    tags: problem.tags,
  });
  try {
    const raw = await llm(prompt, { temperature: 0 });
    const parsed = extractSpineJSON<Array<{ index?: number; id?: string; score?: number }>>(raw);
    if (Array.isArray(parsed)) {
      const out: Array<{ id: string; score: number }> = [];
      for (const s of parsed) {
        if (typeof s.score !== "number") continue;
        let id: string | undefined;
        if (typeof s.id === "string" && papers.some((p) => p.id === s.id)) id = s.id;
        else if (typeof s.index === "number") id = papers[s.index]?.id;
        if (id) out.push({ id, score: s.score });
      }
      if (out.length > 0) return out;
    }
  } catch (err) {
    emit({ type: "log", message: `Relevance scoring failed: ${errMsg(err)}` });
  }
  // Fallback: depth heuristic.
  return papers.map((p) => {
    const e = entryById.get(p.id);
    return { id: p.id, score: (e?.depth ?? 99) <= 1 ? RELEVANCE_THRESHOLD : 2 };
  });
}

/** Convenience: derive arXiv keyword-search seeds → paper ids (unused helper kept thin). */
export function deriveExploreId(title: string): string {
  return slugify(title, "paper");
}
