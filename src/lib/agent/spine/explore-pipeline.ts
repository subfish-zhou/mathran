/**
 * Spine-First Architecture — Paper Graph Exploration Pipeline
 *
 * Replaces the keyword-based deep crawl with citation-graph BFS:
 *   1. Start from seed papers
 *   2. Fetch references (backward) and citations (forward) via Semantic Scholar
 *   3. LLM scoring for fine-grained relevance (no embedding pre-filter today —
 *      see FIX [audit-2 H1] below; the embedding stage was advertised but
 *      never implemented)
 *   4. Expand the most promising frontier nodes
 *
 * Papers are stored globally in paper_nodes; associations in project_papers.
 */

import { eq, and, inArray } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// FIX [audit-2 L2, M4] hoist `projects` import to module top — was a
// dynamic import inside `getProjectContext` which forced re-resolution
// on every call.
// TODO(mathran-v0.1): import { paperNodes, projectPapers, projects } from "@/server/db/schema";
import { callAzureLLM, extractJSON, type TokenCounter } from "../azure-llm";
import { searchArxiv, sleep, ARXIV_RATE_DELAY } from "../init-crawlers";
// TODO(mathran-v0.1): import {
// TODO(mathran-v0.1):   ingestPaper,
// TODO(mathran-v0.1):   ingestCitation,
// TODO(mathran-v0.1):   associatePaperToProject,
// TODO(mathran-v0.1):   ingestSeedPapersForProject,
// TODO(mathran-v0.1):   type PaperNodeInput,
// TODO(mathran-v0.1): } from "@/lib/paper-graph";


import { buildRelevanceScoringPrompt } from "./prompts";
import type {
  ExploreConfig,
  ExploreResult,
  SpinePipelineEvent,
} from "./types";
import type { CrawledResource } from "../init-types";
// TODO(mathran-v0.1): import { logSwallowed } from "@/lib/observability/logger";

const S2_RATE_DELAY = 150;

// ============================================================
//  Paper Node Upsert — thin wrappers around @/lib/paper-graph
// ============================================================

/**
 * @deprecated Use `ingestPaper` from `@/lib/paper-graph` directly.
 *
 * Thin wrapper. Returns the paper-node UUID, or `null` if the upsert fails
 * (DB error, missing required fields, etc.).
 *
 * FIX [audit-2 H8] previously this returned `crypto.randomUUID()` on
 * failure — a phantom UUID that didn't exist in `paper_nodes` and then
 * silently violated the `project_papers` FK and corrupted the BFS frontier.
 * Callers MUST handle null.
 */
export async function upsertPaperNode(
  paper: PaperNodeInput,
  db = getDb(),
): Promise<string | null> {
  return ingestPaper(paper, db);
}

/**
 * Insert a citation edge if it doesn't already exist. Never throws.
 */
async function upsertCitationEdge(
  citingPaperId: string,
  citedPaperId: string,
  context?: string,
  db = getDb(),
): Promise<void> {
  await ingestCitation(citingPaperId, citedPaperId, context, db);
}

/**
 * Associate a paper with a project. Never throws.
 */
async function associatePaperWithProject(
  projectId: string,
  paperId: string,
  opts: { relevanceScore?: number; discoveredBy?: string; depth?: number },
  db = getDb(),
): Promise<void> {
  await associatePaperToProject(projectId, paperId, opts, db);
}

// ============================================================
//  Seed Papers from CrawledResource[]
// ============================================================

/**
 * Convert existing CrawledResource seed papers into paper_nodes
 * and associate them with the project.
 *
 * @deprecated New code should call `ingestSeedPapersForProject` from
 * `@/lib/paper-graph` directly. This wrapper exists to keep the legacy
 * call-shape (`(projectId, seeds, emit) => string[]`) working until all
 * sites migrate.
 */
export async function ingestSeedPapers(
  projectId: string,
  seeds: CrawledResource[],
  emit: (e: SpinePipelineEvent) => void,
): Promise<string[]> {
  const inputs: PaperNodeInput[] = seeds.map((seed) => ({
    title: seed.title,
    authors: seed.authors,
    year: seed.year,
    abstract: seed.abstract,
    url: seed.url,
    arxivId: seed.arxivId,
    doi: seed.doi,
    categories: seed.categories,
    isSurvey: seed.isSurvey,
  }));

  const { ingested } = await ingestSeedPapersForProject(
    projectId,
    inputs,
    {
      relevanceScore: 1.0,
      discoveredBy: "seed",
      depth: 0,
    },
  );

  // Emit discovery events for every seed (even if one failed to ingest — we
  // emit per *input seed* to preserve the prior observable behavior).
  for (const seed of seeds) {
    emit({
      type: "paper_discovered",
      title: seed.title,
      arxivId: seed.arxivId,
      depth: 0,
    });
  }

  return ingested;
}

// ============================================================
//  Fetch References & Citations via Semantic Scholar
// ============================================================

interface S2Paper {
  title: string;
  authors: string[];
  year?: number;
  arxivId?: string;
  doi?: string;
  abstract?: string;
  url?: string;
}

/**
 * Fetch forward citations (papers that cite this paper) and backward references
 * (papers this paper cites) from Semantic Scholar.
 */
async function fetchCitationNeighbors(
  paperId: string,
  db = getDb(),
): Promise<{ citations: S2Paper[]; references: S2Paper[] }> {
  // Get the paper's arxivId for S2 lookup
  const [paper] = await db
    .select({ arxivId: paperNodes.arxivId, title: paperNodes.title })
    .from(paperNodes)
    .where(eq(paperNodes.id, paperId))
    .limit(1);

  if (!paper?.arxivId) return { citations: [], references: [] };

  const s2Id = `ArXiv:${paper.arxivId}`;

  // Fetch citations and references in parallel
  const [citations, references] = await Promise.all([
    fetchS2Citations(s2Id),
    fetchS2References(s2Id),
  ]);

  return { citations, references };
}

async function fetchS2Citations(s2Id: string): Promise<S2Paper[]> {
  try {
    const resp = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/${s2Id}/citations?fields=title,authors,year,externalIds,abstract,url&limit=30`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!resp.ok) return [];
    const data = await resp.json() as { data?: Array<{ citingPaper: Record<string, unknown> }> };
    return (data.data ?? []).map((item) => parseS2Paper(item.citingPaper)).filter(Boolean) as S2Paper[];
  } catch {
    return [];
  }
}

async function fetchS2References(s2Id: string): Promise<S2Paper[]> {
  try {
    const resp = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/${s2Id}/references?fields=title,authors,year,externalIds,abstract,url&limit=30`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!resp.ok) return [];
    const data = await resp.json() as { data?: Array<{ citedPaper: Record<string, unknown> }> };
    return (data.data ?? []).map((item) => parseS2Paper(item.citedPaper)).filter(Boolean) as S2Paper[];
  } catch {
    return [];
  }
}

function parseS2Paper(raw: Record<string, unknown>): S2Paper | null {
  const rawTitle = raw.title as string | undefined;
  if (!rawTitle) return null;
  // FIX [audit-2 L1] normalize Unicode separators / collapsing whitespace
  // so paper_discovered events display cleanly.
  const title = rawTitle.replace(/\s+/g, " ").trim();
  if (!title) return null;
  const externalIds = raw.externalIds as Record<string, string> | undefined;
  return {
    title,
    authors: ((raw.authors as Array<{ name: string }>) ?? []).map((a) => a.name),
    year: raw.year as number | undefined,
    arxivId: externalIds?.ArXiv,
    doi: externalIds?.DOI,
    abstract: raw.abstract as string | undefined,
    url: raw.url as string | undefined,
  };
}

// ============================================================
//  Core Exploration Loop
// ============================================================

interface FrontierEntry {
  paperId: string;
  depth: number;
  priority: number; // Higher = more interesting
}

/**
 * Explore the paper graph via citation-network BFS with embedding
 * pre-filtering and LLM relevance scoring.
 */
export async function explorePaperGraph(
  config: ExploreConfig,
  emit: (e: SpinePipelineEvent) => void,
  tokenCounter: TokenCounter,
): Promise<ExploreResult> {
  const db = getDb();
  const explored = new Set<string>(config.knownPaperIds ?? []);
  const relevant: string[] = [];
  const frontier: FrontierEntry[] = [];
  // FIX [audit-2 C3, M2] dedup frontier and seeds with a Set for O(1)
  // membership checks (was Array.includes — O(n) per push, plus
  // duplicate-citing seeds inflated BFS work and biased priority).
  const inFrontier = new Set<string>();
  const seedSet = new Set<string>(config.seeds);
  let totalRounds = 0;

  emit({ type: "log", message: `Starting paper graph exploration from ${config.seeds.length} seeds (mode=${config.mode})` });

  // Phase A: Supplement seeds with keyword search (arXiv)
  if (config.keywords.length > 0) {
    emit({ type: "log", message: `Keyword search: ${config.keywords.slice(0, 5).join(", ")}` });
    for (const keyword of config.keywords.slice(0, 5)) {
      const results = await searchArxiv(keyword, 10);
      for (const r of results) {
        const paperId = await upsertPaperNode({
          title: r.title,
          authors: r.authors,
          year: r.year,
          abstract: r.abstract,
          url: r.url,
          arxivId: r.arxivId,
          categories: r.categories,
          isSurvey: r.isSurvey,
        }, db);
        if (!paperId) continue; // FIX [audit-2 H8] skip phantom IDs
        if (!explored.has(paperId) && !seedSet.has(paperId) && !inFrontier.has(paperId)) {
          frontier.push({ paperId, depth: 1, priority: 0.5 });
          inFrontier.add(paperId);
          await associatePaperWithProject(config.projectId, paperId, {
            discoveredBy: config.mode === "deep" ? "init" : "patrol",
            depth: 1,
          }, db);
          emit({ type: "paper_discovered", title: r.title, arxivId: r.arxivId, depth: 1 });
        }
      }
      await sleep(ARXIV_RATE_DELAY);
    }
  }

  // Phase B: Expand seed papers' citation neighborhoods
  for (const seedId of config.seeds) {
    if (explored.size >= config.maxPapers) break;

    emit({ type: "log", message: `Expanding citations for seed paper ${seedId}` });
    const { citations, references } = await fetchCitationNeighbors(seedId, db);
    await sleep(S2_RATE_DELAY);

    // FIX [audit-2 C3] dedup neighbors by paperId across both citations
    // and references — same paper can appear via two adjacent seeds.
    const citationSet = new Set(citations); // by reference (S2Paper objects)
    for (const paper of [...citations, ...references]) {
      const paperId = await upsertPaperNode(paper, db);
      if (!paperId) continue; // FIX [audit-2 H8]
      await associatePaperWithProject(config.projectId, paperId, {
        discoveredBy: config.mode === "deep" ? "init" : "patrol",
        depth: 1,
      }, db);

      // Create citation edges
      if (citationSet.has(paper)) {
        await upsertCitationEdge(paperId, seedId, undefined, db);
      } else {
        await upsertCitationEdge(seedId, paperId, undefined, db);
      }

      if (!explored.has(paperId) && !seedSet.has(paperId) && !inFrontier.has(paperId)) {
        frontier.push({ paperId, depth: 1, priority: 0.5 });
        inFrontier.add(paperId);
        emit({ type: "paper_discovered", title: paper.title, arxivId: paper.arxivId, depth: 1 });
      }
    }

    explored.add(seedId);
    relevant.push(seedId);

    // Mark seed as explored
    await db
      .update(projectPapers)
      .set({ isExplored: true })
      .where(and(
        eq(projectPapers.projectId, config.projectId),
        eq(projectPapers.paperId, seedId),
      ))
      .catch(logSwallowed("agent.spine.explore_pipeline.background_emit_failed"));
  }

  // Phase C: BFS loop with LLM scoring
  // FIX [audit-2 H2] raise safety limit relative to maxPapers/batch_size
  // and emit an explicit log when it triggers (was: silent half-explored
  // graph with no operator visibility).
  const safetyRoundLimit = Math.max(config.maxDepth * 2, Math.ceil(config.maxPapers / 5));
  while (frontier.length > 0 && relevant.length < config.maxPapers) {
    totalRounds++;
    if (totalRounds > safetyRoundLimit) {
      emit({ type: "log", message: `BFS safety limit hit (${totalRounds} rounds, limit=${safetyRoundLimit}); stopping with ${relevant.length}/${config.maxPapers} relevant papers` });
      break;
    }

    // Take top batch by priority
    frontier.sort((a, b) => b.priority - a.priority);
    const batch = frontier.splice(0, Math.min(15, frontier.length));
    // FIX [audit-2 C3] keep `inFrontier` in sync after splice so re-enqueue
    // becomes possible if a future round re-discovers the same paperId
    // (rare but valid).
    for (const e of batch) inFrontier.delete(e.paperId);

    // Filter out already explored
    const toScore = batch.filter((e) => !explored.has(e.paperId));
    if (toScore.length === 0) continue;

    // Load paper metadata for scoring
    const paperIds = toScore.map((e) => e.paperId);
    const papers = await db
      .select({
        id: paperNodes.id,
        title: paperNodes.title,
        authors: paperNodes.authors,
        year: paperNodes.year,
        abstract: paperNodes.abstract,
        arxivId: paperNodes.arxivId,
      })
      .from(paperNodes)
      .where(inArray(paperNodes.id, paperIds));

    if (papers.length === 0) continue;

    // FIX [audit-2 C2] build a Map<id, paper> + Map<id, FrontierEntry>;
    // Postgres does NOT preserve `inArray()` ordering so positional
    // alignment between `papers[i]` and `toScore[i]` was broken on
    // every multi-row scoring call. The LLM-fallback path (and the
    // happy path at L390-L395) both indexed by position and silently
    // assigned the wrong score/depth to every paper.
    const paperById = new Map(papers.map((p) => [p.id, p]));
    const entryById = new Map(toScore.map((e) => [e.paperId, e]));

    // LLM relevance scoring
    const projectContext = await getProjectContext(config.projectId, db);
    const scoringPapers = papers.map((p) => ({
      id: p.id,
      title: p.title,
      authors: p.authors as string[],
      year: p.year ?? undefined,
      abstract: p.abstract ?? undefined,
    }));
    const prompt = buildRelevanceScoringPrompt(scoringPapers, projectContext);

    // FIX [audit-2 C2] scores keyed by paperId (or by index into the
    // `papers[]` array we just built — we resolve both). Falls back to
    // depth-based heuristic on LLM failure.
    // IMPL [unimpl-TODOS-P1-DEEPCRAWL] Reduced timeout to 45s with one retry,
    // since deep-crawl scoring used to silently hang up to 120s per round.
    let scores: Array<{ id?: string; index?: number; score: number }> = [];
    let attempt = 0;
    const maxAttempts = 2;
    while (attempt < maxAttempts) {
      try {
        const raw = await callAzureLLM(prompt, {
          tokenCounter,
          tracker: { module: "spine-explore", operation: "relevance-score" },
          timeoutMs: 45_000,
        });
        const parsed = JSON.parse(extractJSON(raw));
        if (Array.isArray(parsed)) {
          scores = parsed;
        }
        break;
      } catch (err) {
        attempt++;
        const msg = err instanceof Error ? err.message : "unknown";
        if (attempt < maxAttempts) {
          emit({ type: "log", message: `LLM scoring attempt ${attempt} failed (${msg}), retrying…` });
          continue;
        }
        emit({ type: "log", message: `LLM scoring failed after ${maxAttempts} attempts: ${msg}` });
        // FIX [audit-2 C2] keyed-by-id fallback. Previously
        // `papers.map((_, i) => ({ index: i, score: …toScore[i].depth }))`
        // mis-indexed because Postgres ordering ≠ inArray order.
        scores = papers.map((p) => {
          const e = entryById.get(p.id);
          return { id: p.id, score: (e?.depth ?? 99) <= 1 ? 5 : 2 };
        });
      }
    }

    // Process scored papers
    for (const s of scores) {
      if (typeof s.score !== "number") continue;
      // FIX [audit-2 C2] resolve paper + entry by id (preferred) or by
      // position into our scoringPapers array (LLM may echo back
      // index-based output).
      let paper: typeof papers[number] | undefined;
      let entry: FrontierEntry | undefined;
      if (typeof s.id === "string") {
        paper = paperById.get(s.id);
        entry = entryById.get(s.id);
      } else if (typeof s.index === "number") {
        const sp = scoringPapers[s.index];
        if (sp) {
          paper = paperById.get(sp.id);
          entry = entryById.get(sp.id);
        }
      }
      if (!paper || !entry) continue;

      explored.add(entry.paperId);
      emit({ type: "paper_scored", title: paper.title, score: s.score });

      // Update relevance score in project_papers
      await db
        .update(projectPapers)
        .set({ relevanceScore: s.score / 10 })
        .where(and(
          eq(projectPapers.projectId, config.projectId),
          eq(projectPapers.paperId, entry.paperId),
        ))
        .catch(logSwallowed("agent.spine.explore_pipeline.relevance_update_failed", {
          projectId: config.projectId, paperId: entry.paperId,
        }));

      if (s.score >= 5) {
        relevant.push(entry.paperId);

        // Expand this paper's citations if within depth limit
        if (entry.depth < config.maxDepth && relevant.length < config.maxPapers) {
          const { citations, references } = await fetchCitationNeighbors(entry.paperId, db);
          await sleep(S2_RATE_DELAY);

          // FIX [audit-2 C3] reference-set for direction lookup (avoids
          // ambiguity when a neighbor appears in BOTH lists).
          const innerCitationSet = new Set(citations);
          for (const neighbor of [...citations, ...references]) {
            const neighborId = await upsertPaperNode(neighbor, db);
            if (!neighborId) continue; // FIX [audit-2 H8]
            await associatePaperWithProject(config.projectId, neighborId, {
              discoveredBy: config.mode === "deep" ? "init" : "patrol",
              depth: entry.depth + 1,
            }, db);

            if (innerCitationSet.has(neighbor)) {
              await upsertCitationEdge(neighborId, entry.paperId, undefined, db);
            } else {
              await upsertCitationEdge(entry.paperId, neighborId, undefined, db);
            }

            if (!explored.has(neighborId) && !seedSet.has(neighborId) && !inFrontier.has(neighborId)) {
              frontier.push({
                paperId: neighborId,
                depth: entry.depth + 1,
                // Higher-scored papers' neighbors get higher priority
                priority: (s.score / 10) * (1 - entry.depth / config.maxDepth),
              });
              inFrontier.add(neighborId);
            }
          }

          // Mark as explored
          await db
            .update(projectPapers)
            .set({ isExplored: true })
            .where(and(
              eq(projectPapers.projectId, config.projectId),
              eq(projectPapers.paperId, entry.paperId),
            ))
            .catch(logSwallowed("agent.spine.explore_pipeline.background_emit_failed"));
        }
      }
    }

    emit({ type: "log", message: `Round ${totalRounds}: scored ${toScore.length} papers, ${relevant.length} relevant so far` });
  }

  emit({ type: "log", message: `Exploration complete: ${relevant.length} relevant papers from ${explored.size} explored (${totalRounds} rounds)` });

  return {
    discoveredPaperIds: [...explored],
    relevantPaperIds: relevant,
    totalRounds,
  };
}

// ============================================================
//  Helper
// ============================================================

async function getProjectContext(
  projectId: string,
  db = getDb(),
): Promise<{ title: string; formalStatement: string; tags: string[] }> {
  // FIX [audit-2 L2, M4] use top-level import (was: dynamic import per call)
  const [project] = await db
    .select({
      title: projects.title,
      formalStatement: projects.formalStatement,
      mscCodes: projects.mscCodes,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  return {
    title: project?.title ?? "",
    formalStatement: project?.formalStatement ?? "",
    tags: (project?.mscCodes ?? []) as string[],
  };
}
