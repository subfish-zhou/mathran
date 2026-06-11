/**
 * Initialization Agent — Spine-First Deep Research project initialization
 *
 * New Pipeline (Spine-First Architecture):
 *   Phase 1: Seed & Explore — Citation-graph BFS with embedding pre-filter + LLM scoring
 *   Phase 2: Build Spine — Batch node extraction → structure assembly → validation
 *   Phase 3: Build Efforts — Spine nodes/threads → workspace efforts with rich documents
 *   Phase 4: Generate Wiki — Spine-driven page generation (structure dictates content)
 *   Phase 5: Review & Verify — Self-review + claim verification
 *   Phase 6: Apply — Write results to DB
 *
 * Uses the unified spine pipeline from ./spine/.
 */

import { TokenCounter } from "./azure-llm";
// TODO(mathran-v0.1): import type { JobContext } from "@/lib/jobs/job-manager";
import type {
  InitAgentInput,
  InitAgentEvent,
  InitPhase,
  CrawledResource,
  WikiPageOutput,
  InitAgentResult,
  VerificationResult,
  WorkspaceResult,
} from "./init-types";
import { checkCompleteness } from "./init-spec";
import { collectWikiWorkspaceRefStats, extractWorkspaceRefs, repairWorkspaceRefs } from "./ref-utils";
// TODO(mathran-v0.1): import { slugify } from "@/lib/utils";
import { buildSinglePagePrompt } from "./init-prompts";
import { extractArxivIdFromUrl, chunkString } from "./init-parsers";
import { searchArxiv, fetchWikipediaSummary } from "./init-crawlers";
import { buildConceptExtractionPrompt } from "./init-prompts";
import { callAzureLLM, extractJSON } from "./azure-llm";
import { verifyContent, reviewAndRefinePages } from "./shared/review-verify";
import {
  explorePaperGraph,
  buildSpine,
  generateEffortsFromSpine,
  generateWikiFromSpine,
  type SpinePipelineEvent,
  type NarrativeSpine,
} from "./spine";
// TODO(mathran-v0.1): import {
// TODO(mathran-v0.1):   ingestSeedPapersForProject,
// TODO(mathran-v0.1):   type PaperNodeInput,
// TODO(mathran-v0.1): } from "@/lib/paper-graph";
// FIX [audit-2 M4] hoist paper-graph schema imports to top-level (was:
// duplicate dynamic imports inside the explore phase). Module cache hits
// only once now.
// TODO(mathran-v0.1): import { paperNodes as paperNodesTable } from "@/server/db/schema";
import { inArray, sql } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";

// ========== Configuration ==========

const EXPLORE_DEEP = { maxDepth: 4, maxPapers: 80 } as const;
// Per-run token caps removed. They were killing legitimate large projects
// mid-pipeline (e.g. 73a1b479 at 432k tokens after build_workspace) and
// duplicated what the global daily budget + Azure-side billing already
// enforce. Set non-zero values via env if you need per-run guardrails back.
const TOKEN_BUDGET_WARNING = Number(process.env.INIT_TOKEN_BUDGET_WARNING ?? 0);
const TOKEN_BUDGET_HARD_LIMIT = Number(process.env.INIT_TOKEN_BUDGET_HARD_LIMIT ?? 0);

// ========== Content Moderation ==========

// M7: moderation patterns are deliberately narrow for a math-research
// platform. We scope the CS/security patterns so they don't fire on legit
// crypto/adversarial-learning math papers (e.g. "breaking the security of
// lattice-based schemes"). Flagged content still proceeds to DB — the flag
// is surfaced as a warning event only. Callers who need hard-blocking should
// consume the event and short-circuit.
const MODERATION_PATTERNS = [
  // Concrete CS attack vocabulary — avoids raw "hack"/"crack"/"exploit"
  // which collide with combinatorics ("exploit", "break") papers.
  /\b(?:zero[- ]?day\s+exploit|security\s+exploit|malicious\s+payload)\b/i,
  /\b(?:weapon|bomb|explosive)\b/i,
  /\b(?:illegal|illicit)\s+(?:drug|substance)\b/i,
  /\b(?:self[- ]?harm|suicide\s+method)\b/i,
];

function moderateContent(text: string): string[] {
  const flags: string[] = [];
  for (const pattern of MODERATION_PATTERNS) {
    const match = text.match(pattern);
    if (match) flags.push(`Flagged pattern: "${match[0]}"`);
  }
  return flags;
}

// ========== Paper Graph Seed Ingest (defense-in-depth wrapper) ==========

/**
 * Ingest a list of CrawledResources as seed papers into the paper graph.
 * Wraps `ingestSeedPapersForProject` with an extra try/catch so that *any*
 * uncaught error in the paper-graph layer still can't abort the init run.
 *
 * FIX [audit-2 C1, H8, H9] returns the per-seed results array (aligned with
 * `seeds[]` by index) so callers can correlate input → paperId WITHOUT
 * positional remapping that breaks on partial failures. Also surfaces
 * failures via the optional `emit` parameter (operator visibility).
 */
async function safeIngestSeedPapers(
  projectId: string | null | undefined,
  seeds: CrawledResource[],
  discoveredBy: "seed" | "init" | "patrol" = "seed",
  depth = 0,
  emit?: (event: InitAgentEvent) => void,
): Promise<{ ingested: string[]; results: Array<{ seedIndex: number; paperId: string | null; associated: boolean }> }> {
  // FIX [audit-2 C1, C4] previously the legacy branch passed the literal
  // string "pending" as projectId, which then violated the project_papers
  // FK (silently swallowed) — every seed counted as failed. Skip ingest
  // entirely when no real projectId is available.
  if (!projectId || projectId === "pending") {
    if (emit && seeds.length > 0) {
      emit({ type: "log", message: `Skipping paper-graph seed ingest (no projectId; ${seeds.length} seeds will not be associated)` });
    }
    return { ingested: [], results: seeds.map((_, i) => ({ seedIndex: i, paperId: null, associated: false })) };
  }
  try {
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
    const { ingested, failed, results } = await ingestSeedPapersForProject(
      projectId,
      inputs,
      { relevanceScore: 1.0, discoveredBy, depth },
    );
    if (failed > 0) {
      const msg = `paper-graph seed ingest: ${failed} of ${seeds.length} failed`;
      console.warn(`[init-agent] ${msg}`);
      // FIX [audit-2 H9] surface failures via SSE event stream (was console.warn only).
      emit?.({ type: "log", message: msg });
      if (failed === seeds.length) {
        emit?.({ type: "log", message: `All ${seeds.length} seed papers failed to associate with project — downstream wiki/spine will be empty` });
      }
    }
    return { ingested, results: results.map((r) => ({ seedIndex: r.seedIndex, paperId: r.paperId, associated: r.associated })) };
  } catch (err) {
    const msg = `paper-graph seed ingest threw (should never happen): ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[init-agent] ${msg}`);
    emit?.({ type: "log", message: msg });
    return { ingested: [], results: seeds.map((_, i) => ({ seedIndex: i, paperId: null, associated: false })) };
  }
}

// ========== Retry Helper ==========

async function withRetry<T>(
  fn: () => Promise<T>,
  stepName: string,
  critical: boolean,
  emit: (e: InitAgentEvent) => void
): Promise<T> {
  try {
    return await fn();
  } catch (firstErr) {
    const errMsg = firstErr instanceof Error ? firstErr.message : "unknown error";
    emit({ type: "log", message: `Step "${stepName}" failed (attempt 1/2): ${errMsg}. Retrying...` });
    try {
      return await fn();
    } catch (secondErr) {
      const errMsg2 = secondErr instanceof Error ? secondErr.message : "unknown error";
      if (critical) {
        emit({ type: "log", message: `Critical step "${stepName}" failed (attempt 2/2): ${errMsg2}. Aborting.` });
        throw secondErr;
      } else {
        emit({ type: "log", message: `Non-critical step "${stepName}" failed (attempt 2/2): ${errMsg2}. Skipping.` });
        throw secondErr;
      }
    }
  }
}

// ========== Spine Event → Init Event Adapter ==========

function spineToInitEmit(emit: (e: InitAgentEvent) => void): (e: SpinePipelineEvent) => void {
  return (e: SpinePipelineEvent) => {
    switch (e.type) {
      case "log":
        emit({ type: "log", message: e.message });
        break;
      case "paper_discovered":
        emit({ type: "seed_paper_found", paper: { title: e.title, authors: [], arxivId: e.arxivId, url: e.arxivId ? `https://arxiv.org/abs/${e.arxivId}` : "" } });
        break;
      case "spine_node_extracted":
        emit({ type: "workspace_effort_created", effort: { id: e.nodeId, type: e.nodeType, title: e.title, status: "DRAFT" } });
        break;
      case "effort_created":
        emit({ type: "workspace_effort_created", effort: { id: e.effortId, type: "METHOD", title: e.title, status: "DRAFT" } });
        break;
      case "wiki_page_start":
        emit({ type: "wiki_page_start", slug: e.slug, title: e.title });
        break;
      case "wiki_page_chunk":
        emit({ type: "wiki_page_chunk", slug: e.slug, chunk: e.chunk });
        break;
      case "wiki_page_complete":
        emit({ type: "wiki_page_complete", slug: e.slug });
        break;
      case "checkpoint":
        emit({ type: "checkpoint", phase: e.phase, data: e.data });
        break;
      default:
        // Pass through unrecognized events (crawl pipeline: resource_found, crawl_round_start, etc.)
        emit(e as unknown as InitAgentEvent);
        break;
    }
  };
}

// ========== Main Entry ==========

/**
 * Create an SSE stream for the Initialization Agent pipeline.
 * Now uses the Spine-First architecture.
 */
export function createInitAgentStream(input: InitAgentInput, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      signal?.addEventListener("abort", () => { stopKeepAlive(); try { controller.close(); } catch { /* already closed */ } });
      const startTime = Date.now();

      function emit(event: InitAgentEvent) {
        try {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        } catch { /* controller already closed */ }
      }

      let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
      function startKeepAlive() {
        keepAliveTimer = setInterval(() => {
          try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { /* closed */ }
        }, 15_000);
      }
      function stopKeepAlive() {
        if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
      }

      try {
        startKeepAlive();

        const tokenCounter = new TokenCounter();
        const spineEmit = spineToInitEmit(emit);
        let checkpoint = input.resumeCheckpoint;

        /** Check token budget after each major phase. Caps default to 0 =
         *  disabled; set INIT_TOKEN_BUDGET_HARD_LIMIT / _WARNING env vars
         *  to non-zero values to re-enable. */
        let skipVerify = false;
        function checkTokenBudget(phase: string) {
          if (TOKEN_BUDGET_HARD_LIMIT > 0 && tokenCounter.exceeds(TOKEN_BUDGET_HARD_LIMIT)) {
            emit({ type: "log", message: `TOKEN HARD LIMIT exceeded after ${phase}: ${tokenCounter.totalTokens} tokens (limit: ${TOKEN_BUDGET_HARD_LIMIT}). Skipping remaining LLM-heavy phases.` });
            throw new Error(`Token budget exceeded after ${phase}`);
          } else if (TOKEN_BUDGET_WARNING > 0 && tokenCounter.exceeds(TOKEN_BUDGET_WARNING)) {
            emit({ type: "log", message: `Token budget warning after ${phase}: ${tokenCounter.totalTokens} tokens — verify phase will be skipped to conserve tokens` });
            skipVerify = true;
          }
        }

        // Phase ordering. Includes both legacy and Spine-First phases so
        // checkpoints emitted by either pipeline can be resumed correctly.
        const phaseOrder: InitPhase[] = [
          "seed_research",
          "explore_graph",
          "deep_crawl",
          "build_spine",
          "build_efforts",
          "build_workspace",
          "generate_wiki",
          "spine_wiki",
          "review_refine",
          "verify",
          "link_review",
          "completeness_check",
        ];
        if (checkpoint) {
          const isValid = checkpoint.phase && phaseOrder.includes(checkpoint.phase as InitPhase);
          if (!isValid) { checkpoint = undefined; }
        }
        const _resumePhaseIndex = checkpoint ? phaseOrder.indexOf(checkpoint.phase as InitPhase) : -1;

        // Stage-level resume gates. We classify each valid checkpoint phase
        // into a stage and ask "has the run progressed past stage X?" so we
        // can safely skip earlier work regardless of which pipeline emitted
        // the checkpoint. Phases are mutually exclusive across pipelines.
        const exploreDonePhases: InitPhase[] = ["explore_graph", "deep_crawl", "build_spine", "build_efforts", "build_workspace", "generate_wiki", "spine_wiki", "review_refine", "verify", "link_review", "completeness_check"];
        const workspaceDonePhases: InitPhase[] = ["build_workspace", "generate_wiki", "spine_wiki", "review_refine", "verify", "link_review", "completeness_check"];
        const wikiDonePhases: InitPhase[] = ["generate_wiki", "spine_wiki", "review_refine", "verify", "link_review", "completeness_check"];
        const resumeExploreDone = !!checkpoint && exploreDonePhases.includes(checkpoint.phase as InitPhase);
        const resumeWorkspaceDone = !!checkpoint && workspaceDonePhases.includes(checkpoint.phase as InitPhase);
        const resumeWikiDone = !!checkpoint && wikiDonePhases.includes(checkpoint.phase as InitPhase);

        // Determine pipeline mode: Spine-First (has projectId) vs Legacy (no projectId)
        const useSpinePipeline = !!input.projectId;

        // ──────────────────────────────────
        // Phase 1: Explore / Seed & Crawl
        // ──────────────────────────────────
        let allResources: CrawledResource[] = [];

        if (resumeExploreDone && Array.isArray(checkpoint?.data?.allResources) && (checkpoint.data.allResources as unknown[]).length > 0) {
          const restored = checkpoint.data.allResources as CrawledResource[];
          // H3: validate restored paper IDs still exist in paperNodes. If any
          // are missing (DB rotated, or ingest skipped) we refetch from the
          // surviving IDs only. If nothing is valid, re-run explore from scratch.
          // FIX [audit-2 M4] use top-level imports (was dynamic).
          try {
            const db = getDb();
            const ids = restored.map((r) => r.id).filter((x): x is string => !!x);
            const rows = ids.length > 0
              ? await db.select().from(paperNodesTable).where(inArray(paperNodesTable.id, ids))
              : [];
            const existingIds = new Set(rows.map((r) => r.id));
            const validated = restored.filter((r) => existingIds.has(r.id));
            if (validated.length === 0) {
              emit({ type: "log", message: "Checkpoint allResources no longer match DB; re-running explore" });
              // Fall through to regular explore by not assigning allResources
               
              allResources = [];
            } else {
              if (validated.length < restored.length) {
                emit({ type: "log", message: `Dropped ${restored.length - validated.length} stale paper IDs from checkpoint` });
              }
              emit({ type: "log", message: "Skipping explore (restored from checkpoint)" });
              allResources = validated;
            }
          } catch (e) {
            emit({ type: "log", message: `Paper ID validation failed, using restored as-is: ${e instanceof Error ? e.message : "unknown"}` });
            allResources = restored;
          }
        }

        // When resumed from an explore-complete checkpoint we already have
        // allResources populated above; skip the entire explore/seed phase so
        // we don't fall into the legacy `else` branch (which would iterate
        // input.seedReferences — that may be absent on old resume runs —
        // and re-run keyword crawl against a pipeline we already finished).
        if (allResources.length > 0) {
          // no-op: explore already done, fall through to spine build
        } else if (useSpinePipeline) {
          // ── Spine-First: Paper Graph BFS exploration ──
          emit({ type: "init_phase_change", phase: "explore_graph", message: "Exploring citation network..." });

          // Convert seed references to paper nodes and ingest into Paper Graph
          const seedResources: CrawledResource[] = [];
          for (const ref of input.seedReferences) {
            if (ref.resolved && ref.title) {
              const arxivId = extractArxivIdFromUrl(ref.url);
              seedResources.push({
                id: arxivId ? `arxiv-${arxivId}` : `seed-${slugify(ref.title)}`,
                title: ref.title, authors: ref.authors ?? [],
                sourceType: ref.type === "arxiv" ? "arxiv" : "webpage",
                arxivId: arxivId ?? undefined,
                url: ref.url ?? ref.originalInput, abstract: ref.abstract,
              });
            }
          }

          // Also add arXiv title search results as seeds
          const titlePapers = await searchArxiv(input.problem.title, 10);
          for (const p of titlePapers) {
            if (!seedResources.some((ep) => ep.id === p.id)) seedResources.push(p);
          }

          // Ingest seeds into paper graph DB
          const seedIngest = await safeIngestSeedPapers(
            input.projectId!,
            seedResources,
            "seed",
            0,
            emit,
          );
          const seedPaperIds = seedIngest.ingested;
          // Also emit discovery events to preserve legacy observable behavior.
          for (const seed of seedResources) {
            spineEmit({ type: "paper_discovered", title: seed.title, arxivId: seed.arxivId, depth: 0 });
          }
          emit({ type: "log", message: `Ingested ${seedPaperIds.length} seed papers into Paper Graph` });

          // Run citation-graph BFS exploration
          const exploreResult = await explorePaperGraph(
            {
              projectId: input.projectId!,
              seeds: seedPaperIds,
              keywords: input.problem.tags,
              mode: "deep",
              maxDepth: EXPLORE_DEEP.maxDepth,
              maxPapers: EXPLORE_DEEP.maxPapers,
            },
            spineEmit,
            tokenCounter,
          );

          emit({ type: "log", message: `Explored ${exploreResult.discoveredPaperIds.length} papers, ${exploreResult.relevantPaperIds.length} relevant` });

          // Convert relevant paper IDs back to CrawledResource format for downstream compatibility
          // FIX [audit-2 M4] use top-level imports (was dynamic).
          const db = getDb();
          const relevantPapers = exploreResult.relevantPaperIds.length > 0
            ? await db.select().from(paperNodesTable).where(inArray(paperNodesTable.id, exploreResult.relevantPaperIds))
            : [];
          allResources = relevantPapers.map((p) => ({
            id: p.id,
            title: p.title,
            authors: (p.authors as string[]) ?? [],
            year: p.year ?? undefined,
            sourceType: "arxiv" as const,
            arxivId: p.arxivId ?? undefined,
            url: p.url ?? "",
            abstract: p.abstract ?? undefined,
            isSurvey: p.isSurvey,
          }));

          emit({ type: "checkpoint", phase: "explore_graph", data: { allResources } });
          checkTokenBudget("explore");
        } else {
          // ── Legacy: keyword-based deep crawl (no projectId, e.g. new project) ──
          emit({ type: "init_phase_change", phase: "seed_research", message: "Starting seed research..." });

          const seedResources: CrawledResource[] = [];
          for (const ref of input.seedReferences) {
            if (ref.resolved && ref.title) {
              const arxivId = extractArxivIdFromUrl(ref.url);
              seedResources.push({
                id: arxivId ? `arxiv-${arxivId}` : `seed-${slugify(ref.title)}`,
                title: ref.title, authors: ref.authors ?? [],
                sourceType: ref.type === "arxiv" ? "arxiv" : "webpage",
                arxivId: arxivId ?? undefined,
                url: ref.url ?? ref.originalInput, abstract: ref.abstract,
              });
            }
          }
          const titlePapers = await searchArxiv(input.problem.title, 10);
          for (const p of titlePapers) {
            if (!seedResources.some((ep) => ep.id === p.id)) seedResources.push(p);
          }

          emit({ type: "init_phase_change", phase: "deep_crawl", message: "Deep literature search..." });

          const keywords = input.problem.tags.slice(0);
          try {
            const wikiSummary = await fetchWikipediaSummary(input.problem.title);
            const conceptPrompt = buildConceptExtractionPrompt(input.problem, seedResources, wikiSummary);
            const conceptRaw = await callAzureLLM(conceptPrompt, { tokenCounter, tracker: { module: "init-agent", operation: "init-concept" } });
            const conceptJson = JSON.parse(extractJSON(conceptRaw));
            if (Array.isArray(conceptJson.concepts)) {
              for (const c of conceptJson.concepts) {
                const name = typeof c === "string" ? c : c.name;
                if (name) keywords.push(name);
              }
            }
            if (Array.isArray(conceptJson.search_queries)) keywords.push(...conceptJson.search_queries);
          } catch {
            emit({ type: "log", message: "Concept extraction failed, using tags as keywords" });
          }

          const { runDeepCrawl } = await import("./shared/crawl-pipeline");
          const crawlResult = await runDeepCrawl(
            {
              keywords: keywords.slice(0, 15), title: input.problem.title,
              tags: input.problem.tags, formalStatement: input.problem.formalStatement,
              maxRounds: 3, maxQueriesPerRound: 8, maxPapers: 60,
              seedPapers: seedResources, seedSearchQueries: keywords.slice(0, 8),
            },
            spineEmit as (event: Record<string, unknown>) => void,
            tokenCounter,
          );
          allResources = crawlResult.resources;

          // Ingest crawled resources into paperNodes so buildSpine can find them
          // FIX [audit-2 C1, H4-side-effect] previously passed literal "pending"
          // when projectId was null — that violated the project_papers FK.
          // safeIngestSeedPapers now skips ingest cleanly when projectId is missing.
          const legacyIngest = await safeIngestSeedPapers(
            input.projectId,
            allResources,
            "init",
            0,
            emit,
          );
          const legacyPaperIds = legacyIngest.ingested;
          emit({ type: "log", message: `Ingested ${legacyPaperIds.length} papers into Paper Graph for spine building` });

          // FIX [audit-2 C1] update IDs by per-seed result (positional within
          // the original seeds[] array) instead of the broken
          // `allResources[i].id = legacyPaperIds[i]` loop, which silently
          // attached wrong UUIDs whenever `ingested[]` was shorter than
          // `seeds[]`. Now we look up by `seedIndex` so every position is
          // either updated correctly or left alone.
          for (const r of legacyIngest.results) {
            if (r.paperId && allResources[r.seedIndex]) {
              allResources[r.seedIndex]!.id = r.paperId;
            }
          }
          // Drop resources for which we have no paper-graph node — downstream
          // buildSpine / wiki / applyInitResult require a real paperNodes.id.
          const beforeFilter = allResources.length;
          allResources = allResources.filter((r) => !!r.id);
          if (allResources.length < beforeFilter) {
            emit({ type: "log", message: `Dropped ${beforeFilter - allResources.length} crawled resources that failed paper-graph ingest` });
          }

          emit({ type: "checkpoint", phase: "deep_crawl", data: { allResources } });
          checkTokenBudget("explore");
        }

        // ──────────────────────────────────
        // Phase 2: Build Spine + Efforts
        // ──────────────────────────────────
        let spine: NarrativeSpine;
        let workspaceResult: WorkspaceResult;

        if (resumeWorkspaceDone && checkpoint?.data?.workspaceResult && (checkpoint.data.workspaceResult as WorkspaceResult).efforts?.length > 0) {
          emit({ type: "log", message: "Skipping build (restored from checkpoint)" });
          workspaceResult = checkpoint.data.workspaceResult as WorkspaceResult;
          spine = (checkpoint.data as Record<string, unknown>).spine as NarrativeSpine ?? {
            version: 1, updatedAt: new Date().toISOString(), globalThesis: "", eras: [], nodes: [], edges: [], threads: [], openQuestions: [],
          };
        } else {
          emit({ type: "init_phase_change", phase: useSpinePipeline ? "build_spine" : "build_workspace", message: "Building narrative spine..." });

          const paperIds = allResources.map((r) => r.id);
          spine = await withRetry(
            () => buildSpine(
              {
                projectId: input.projectId ?? "pending",
                paperIds,
                mode: "full",
                problem: {
                  title: input.problem.title,
                  formalStatement: input.problem.formalStatement,
                  description: input.problem.description,
                  tags: input.problem.tags,
                },
              },
              spineEmit,
              tokenCounter,
            ),
            "build_spine",
            true,
            emit,
          );

          emit({ type: "init_phase_change", phase: useSpinePipeline ? "build_efforts" : "build_workspace", message: "Generating workspace efforts from spine..." });

          const effortResult = await withRetry(
            () => generateEffortsFromSpine(
              {
                spine,
                projectId: input.projectId ?? "pending",
                problemTitle: input.problem.title,
              },
              spineEmit,
              tokenCounter,
            ),
            "build_efforts",
            true,
            emit,
          );

          workspaceResult = { efforts: effortResult.efforts, edges: effortResult.edges };
          emit({ type: "checkpoint", phase: "build_workspace", data: { allResources, workspaceResult, spine } });
          checkTokenBudget("build_workspace");
        }

        // ──────────────────────────────────
        // Phase 3: Generate Wiki (Spine-Driven)
        // ──────────────────────────────────
        let wikiPages: WikiPageOutput[] = [];
        if (input.aiInit.enableWiki) {
          if (resumeWikiDone && Array.isArray(checkpoint?.data?.wikiPages) && (checkpoint.data.wikiPages as unknown[]).length > 0) {
            emit({ type: "log", message: "Skipping generate_wiki (restored from checkpoint)" });
            wikiPages = checkpoint.data.wikiPages as WikiPageOutput[];
          } else {
            emit({ type: "init_phase_change", phase: useSpinePipeline ? "spine_wiki" : "generate_wiki", message: "Generating wiki from spine..." });

            wikiPages = await withRetry(
              () => generateWikiFromSpine(
                {
                  spine,
                  problem: {
                    title: input.problem.title,
                    formalStatement: input.problem.formalStatement,
                    description: input.problem.description,
                    tags: input.problem.tags,
                    mathStatus: "OPEN",
                  },
                  paperIds: allResources.map((r) => r.id),
                  workspaceEfforts: workspaceResult.efforts,
                },
                spineEmit,
                tokenCounter,
              ),
              "generate_wiki",
              true,
              emit,
            );

            emit({ type: "checkpoint", phase: "generate_wiki", data: { allResources, workspaceResult, wikiPages, spine } });
            checkTokenBudget("generate_wiki");

            // Content moderation
            for (const page of wikiPages) {
              const flags = moderateContent(page.content);
              if (flags.length > 0) {
                emit({ type: "log", message: `⚠️ Content moderation warning on "${page.title}": ${flags.join("; ")}` });
              }
            }
          }
        }

        // ──────────────────────────────────
        // Phase 4: Review & Refine
        // ──────────────────────────────────
        if (input.aiInit.enableWiki && wikiPages.length > 0) {
          emit({ type: "init_phase_change", phase: "review_refine", message: "Phase 4: Self-reviewing..." });
          try {
            const reviewResult = await reviewAndRefinePages(
              { pages: wikiPages, resources: allResources },
              emit as (event: Record<string, unknown>) => void,
              tokenCounter,
            );
            wikiPages = reviewResult.pages;
            if (reviewResult.refinedCount > 0) {
              emit({ type: "log", message: `Refined ${reviewResult.refinedCount} page(s)` });
            }
          } catch (err) {
            emit({ type: "log", message: `Review failed: ${err instanceof Error ? err.message : "unknown"}` });
          }
        }

        // ──────────────────────────────────
        // Phase 5: Verify
        // ──────────────────────────────────
        let verificationResult: VerificationResult | undefined;
        if (input.aiInit.enableWiki && wikiPages.length > 0 && !skipVerify) {
          emit({ type: "init_phase_change", phase: "verify", message: "Phase 5: Verifying content accuracy..." });
          try {
            const verifyOutput = await withRetry(
              () => verifyContent(
                wikiPages,
                { problem: input.problem, workspace: workspaceResult, resources: allResources },
                emit as (event: Record<string, unknown>) => void,
              ),
              "verify",
              false,
              emit,
            );
            verificationResult = verifyOutput.result;
            wikiPages = verifyOutput.correctedPages;
          } catch (verifyErr) {
            emit({ type: "log", message: `Verify skipped: ${verifyErr instanceof Error ? verifyErr.message : "unknown"}` });
          }
        }

        // ──────────────────────────────────
        // Phase 6: Link Review + Completeness Check
        // ──────────────────────────────────
        emit({ type: "init_phase_change", phase: "link_review", message: "Phase 6: Cross-reference check..." });

        let repairedRefs = 0;
        let removedRefs = 0;
        for (const page of wikiPages) {
          const repaired = repairWorkspaceRefs(page.content, workspaceResult.efforts);
          if (repaired.fixedRefs > 0 || repaired.removedRefs > 0) {
            page.content = repaired.content;
            page.workspaceRefs = extractWorkspaceRefs(repaired.content);
            repairedRefs += repaired.fixedRefs;
            removedRefs += repaired.removedRefs;
          }
        }
        if (repairedRefs > 0 || removedRefs > 0) {
          emit({ type: "log", message: `Auto-repaired @ws references: ${repairedRefs} fixed, ${removedRefs} removed` });
        }

        const { validRefs, brokenRefs, uncoveredItems } = collectWikiWorkspaceRefStats(wikiPages, workspaceResult.efforts);
        emit({ type: "link_check_result", valid: validRefs, broken: brokenRefs, uncovered: uncoveredItems });

        emit({ type: "review_complete", summary: `Cross-reference check: ${validRefs} valid, ${brokenRefs} broken, ${uncoveredItems} uncovered` });

        // Completeness check
        if (input.aiInit.enableWiki) {
          emit({ type: "init_phase_change", phase: "completeness_check", message: "Running completeness check..." });
          const intermediateResult: InitAgentResult = {
            wikiPages,
            workspaceEfforts: workspaceResult.efforts,
            dependencyEdges: workspaceResult.edges,
            crawledResources: allResources,
            summary: { wikiPagesGenerated: wikiPages.length, workspaceEffortsCreated: workspaceResult.efforts.length, referencesFound: allResources.length, depGraphEdges: workspaceResult.edges.length, totalDurationMs: 0 },
          };
          let checkResult = checkCompleteness(intermediateResult, "deep", { strictQualityGate: true });
          emit({ type: "completeness_check_result", passed: checkResult.passed, errors: checkResult.errors.length, warnings: checkResult.warnings.length, summary: checkResult.summary });

          // Re-generate missing required pages using spine-driven prompts
          if (checkResult.pagesToGenerate.length > 0) {
            const pageIndexBySlug = new Map(wikiPages.map((p, index) => [p.slug, index]));
            for (const spec of checkResult.pagesToGenerate) {
              const title = spec.titleTemplate.replace("{title}", input.problem.title);
              const existingIndex = pageIndexBySlug.get(spec.slug);
              emit({ type: "wiki_page_start", slug: spec.slug, title });
              const prompt = buildSinglePagePrompt(input.problem, workspaceResult, { slug: spec.slug, title, instruction: spec.instruction }, undefined, wikiPages.map((p) => p.title));
              try {
                const raw = await callAzureLLM(prompt, { tokenCounter, tracker: { module: "init-agent", operation: "init-wiki" } });
                let content: string;
                try { const parsed = JSON.parse(extractJSON(raw)); content = String(parsed.content ?? parsed.text ?? raw); } catch { content = raw.trim(); }
                if (!content.includes("[AI-GENERATED]")) content = `> [AI-GENERATED] This content was automatically generated and requires human review.\n\n${content}`;
                const newPage: WikiPageOutput = { slug: spec.slug, title, content, workspaceRefs: extractWorkspaceRefs(content) };
                if (existingIndex == null) { wikiPages.push(newPage); pageIndexBySlug.set(spec.slug, wikiPages.length - 1); }
                else { wikiPages[existingIndex] = newPage; }
                const chunks = chunkString(newPage.content, 300);
                for (const chunk of chunks) emit({ type: "wiki_page_chunk", slug: newPage.slug, chunk });
                emit({ type: "wiki_page_complete", slug: newPage.slug });
              } catch (err) {
                emit({ type: "log", message: `Supplementary page "${title}" failed: ${err instanceof Error ? err.message : "unknown"}` });
              }
            }
          }

          if (checkResult.pagesToGenerate.length > 0) {
            for (const page of wikiPages) {
              const repaired = repairWorkspaceRefs(page.content, workspaceResult.efforts);
              if (repaired.fixedRefs > 0 || repaired.removedRefs > 0) {
                page.content = repaired.content;
                page.workspaceRefs = extractWorkspaceRefs(repaired.content);
              }
            }
          }

          const finalCheckInput: InitAgentResult = {
            wikiPages,
            workspaceEfforts: workspaceResult.efforts,
            dependencyEdges: workspaceResult.edges,
            crawledResources: allResources,
            summary: { wikiPagesGenerated: wikiPages.length, workspaceEffortsCreated: workspaceResult.efforts.length, referencesFound: allResources.length, depGraphEdges: workspaceResult.edges.length, totalDurationMs: 0 },
          };
          checkResult = checkCompleteness(finalCheckInput, "deep", { strictQualityGate: true });
          emit({ type: "completeness_check_result", passed: checkResult.passed, errors: checkResult.errors.length, warnings: checkResult.warnings.length, summary: checkResult.summary });
          if (!checkResult.passed) {
            const details = checkResult.errors.slice(0, 5).map((issue) => issue.message).join("; ");
            throw new Error(`Init quality gate failed: ${details}`);
          }
        }

        // ──────────────────────────────────
        // Complete
        // ──────────────────────────────────
        const totalDuration = Date.now() - startTime;
        const result: InitAgentResult = {
          wikiPages,
          workspaceEfforts: workspaceResult.efforts,
          dependencyEdges: workspaceResult.edges,
          crawledResources: allResources,
          verification: verificationResult,
          summary: {
            wikiPagesGenerated: wikiPages.length,
            workspaceEffortsCreated: workspaceResult.efforts.length,
            referencesFound: allResources.length,
            depGraphEdges: workspaceResult.edges.length,
            totalDurationMs: totalDuration,
            claimsVerified: verificationResult?.verified,
            correctionsApplied: verificationResult?.corrected,
            contentConfidence: verificationResult?.confidenceScore,
          },
        };

        emit({ type: "init_phase_change", phase: "completed", message: "Project initialization complete!" });
        emit({ type: "init_completed", result });
        emit({ type: "log", message: `Initialization complete (${Math.round(totalDuration / 1000)}s)` });
      } catch (err) {
        emit({ type: "init_error", message: err instanceof Error ? err.message : "Unknown error" });
        emit({ type: "init_phase_change", phase: "error", message: "Initialization failed" });
      } finally {
        stopKeepAlive();
        controller.close();
      }
    },
  });
}

// ========== JobManager Integration ==========

/**
 * Run the init agent pipeline within a JobManager context.
 * Consumes the SSE stream from createInitAgentStream and maps events
 * to ctx.checkpoint / ctx.log / ctx.progress / ctx.emit.
 *
 * After the stream completes, performs auto-save draft and auto-finalize.
 */
export async function runInitWithJobContext(
  input: InitAgentInput,
  ctx: JobContext,
  opts: {
    projectSlug?: string;
    userId: string;
    resumeCheckpoint?: { phase: string; data: Record<string, unknown> };
    /**
     * Persist generated wiki/efforts inside this function only for non-interactive
     * callers that explicitly opt in. New-project and rebuild review flows return
     * an InitAgentResult and let a separate finalize/apply step write it.
     */
    applyMode?: "none" | "append";
  },
): Promise<unknown> {
// TODO(mathran-v0.1):   const { applyInitResult } = await import("@/lib/agent/apply-init-result");
// TODO(mathran-v0.1):   const { getDb } = await import("@/server/db");
// TODO(mathran-v0.1):   const { drafts, projects, programProjects, programs } = await import("@/server/db/schema");
  const { eq, and, isNull } = await import("drizzle-orm");
// TODO(mathran-v0.1):   const { createNotification } = await import("@/lib/notifications");

  const db = getDb();
  const { projectSlug, userId, resumeCheckpoint, applyMode = "none" } = opts;

  await ctx.log(resumeCheckpoint
    ? `Resuming from checkpoint: ${resumeCheckpoint.phase}`
    : "Starting project initialization (Spine-First)...");
  await ctx.progress(5);

  const streamInput = resumeCheckpoint
    ? { ...input, resumeCheckpoint }
    : input;
  const stream = createInitAgentStream(streamInput, ctx.signal);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let initResult: unknown = null;

  try {

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Check if aborted after each read
    if (ctx.signal?.aborted) {
      throw new Error("Init agent aborted");
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let event: any;
      try {
        event = JSON.parse(trimmed.slice(6));
      } catch {
        // Skip malformed SSE payloads. Previously a wider try/catch wrapped
        // the whole switch and swallowed real errors thrown from the
        // `init_error` case, masking upstream failures as the misleading
        // "stream ended without producing a result".
        continue;
      }

      switch (event.type) {
          // ── Phase & Progress (control flow) ──
          case "init_phase_change":
            await ctx.log(event.message ?? event.phase ?? "Processing...");
            await ctx.progress(event.progress ?? 20);
            // H1: do NOT overwrite the last data-bearing checkpoint with a
            // bare phase-change event. The rich checkpoint is saved by the
            // explicit `checkpoint` event (below) — phase changes just
            // announce progress. Previously we wrote the event object into
            // checkpoint_data, clobbering allResources/workspaceResult/etc.
            ctx.emit(event);
            break;

          case "init_progress":
            if (event.message) await ctx.log(event.message);
            if (event.progress) await ctx.progress(event.progress);
            ctx.emit(event);
            break;

          case "checkpoint":
            await ctx.checkpoint(event.phase, event.data ?? {});
            ctx.emit(event);
            break;

          case "init_completed":
            initResult = event.result ?? event;
            await ctx.progress(100);
            ctx.emit(event);
            break;

          case "init_error":
          case "error":
            throw new Error(event.message ?? "Unknown init error");

          // ── Seed Research ──
          case "seed_paper_found":
          case "concept_extracted":
          case "concept_detected":
          case "seed_complete":
            ctx.emit(event);
            break;

          // ── Deep Crawl ──
          case "crawl_round_start":
          case "resource_found":
          case "crawl_converged":
            ctx.emit(event);
            break;

          // ── Spine / Paper Graph ──
          case "paper_discovered":
          case "paper_scored":
          case "effort_created":
            ctx.emit(event);
            break;

          // ── Workspace Build ──
          case "workspace_effort_created":
          case "workspace_complete":
          case "dependency_edge_created":
          case "file_parsed":
          case "reference_parsed":
            ctx.emit(event);
            break;

          // ── Wiki Generation ──
          case "wiki_page_start":
          case "wiki_page_chunk":
          case "wiki_page_complete":
          case "wiki_complete":
            ctx.emit(event);
            break;

          // ── Review & Verify ──
          case "review_page_start":
          case "review_page_complete":
          case "verify_start":
          case "verify_page_start":
          case "verify_claim_checked":
          case "verify_page_complete":
          case "verify_complete":
          case "verify_correction_start":
          case "verify_correction_complete":
          case "review_complete":
            ctx.emit(event);
            break;

          // ── Link Review & Completeness ──
          case "link_check_result":
          case "completeness_check_start":
          case "completeness_check_result":
          case "completeness_regenerate_start":
            ctx.emit(event);
            break;

          // ── Misc ──
          case "log":
            if (event.message) await ctx.log(event.message);
            ctx.emit(event);
            break;

          case "run_started":
            ctx.emit(event);
            break;

          default:
            // Unknown event type — still forward to not lose data, but log a warning
            console.warn(`[init-agent] Unknown event type: ${event.type}`);
            ctx.emit(event);
            break;
        }
    }
  }

  // If stream ended without init_completed, check if aborted or incomplete
  if (!initResult) {
    if (ctx.signal?.aborted) {
      throw new Error("Init agent aborted before completion");
    }
    throw new Error("Init agent stream ended without producing a result");
  }

  } catch (runErr) {
    // Hard failure while the pipeline was running. If the init-project route
    // eagerly created a projects row (status='INITIALIZING'), mark it
    // ARCHIVED so it doesn't linger invisibly. Rebuild flows pass an
    // already-ACTIVE projectId; the narrow status guard below prevents us
    // from archiving an active project on a failed rebuild.
    if (input.projectId) {
      try {
        await db
          .update(projects)
          .set({ status: "ARCHIVED" })
          .where(and(eq(projects.id, input.projectId), eq(projects.status, "INITIALIZING")));
      } catch (archErr) {
        console.error("[runInitWithJobContext] failed to archive INITIALIZING project on error:", archErr);
      }
    }
    throw runErr;
  }

  // Auto-save draft (upserts on (userId, agentRunId) so resume/replay doesn't
  // accumulate duplicates — see drafts_user_agent_run_uniq in schema, C4).
  // Capture the (inserted or updated) draft id so the INIT_COMPLETE
  // notification can deep-link to it (sourceType:"DRAFT") instead of the old
  // /repo/<slug> target that didn't open the awaiting-review draft (BUG-4).
  let initDraftId: string | null = null;
  if (initResult && userId) {
    const result = initResult as Record<string, unknown>;
    const title = (result.projectTitle as string) || input.problem.title || "Untitled Project";
    // projectSlug must be slugified (C3). Previously we stored the raw title as
    // a fallback which caused broken /project/<slug> redirects for drafts.
    const draftSlug = projectSlug ?? (input.problem.title ? slugify(input.problem.title) : null);
    try {
      const [savedDraft] = await db
        .insert(drafts)
        .values({
          userId,
          type: "init",
          title,
          payload: JSON.stringify(initResult),
          agentRunId: ctx.runId,
          projectSlug: draftSlug,
        })
        .onConflictDoUpdate({
          target: [drafts.userId, drafts.agentRunId],
          // drafts_user_agent_run_uniq is a PARTIAL unique index
          // (WHERE agent_run_id IS NOT NULL), so Postgres requires the
          // same predicate on ON CONFLICT for the inference to match.
          // Without this targetWhere the insert raises
          // "there is no unique or exclusion constraint matching the
          //  ON CONFLICT specification" and the entire draft auto-save
          // is lost (the run still completes; the user just can't open
          // the init result from /drafts).
          targetWhere: sql`${drafts.agentRunId} IS NOT NULL`,
          set: {
            title,
            payload: JSON.stringify(initResult),
            projectSlug: draftSlug,
            updatedAt: new Date(),
          },
        })
        .returning({ id: drafts.id });
      initDraftId = savedDraft?.id ?? null;
    } catch (e) {
      // Don't fail the run on draft-save errors; log so it's visible.
      console.error("[init-agent] draft auto-save failed:", e);
    }
  }

  // Notify the draft owner that init finished and is awaiting their review.
  // Deep-link to the saved draft (DRAFT source type → /drafts/<id>, which
  // renders the init draft in place). Fall back to the old REPO_ITEM slug
  // link only when no draft was saved (e.g. draft-save failed above).
  if (userId) {
    createNotification(
      initDraftId
        ? { userId, type: "INIT_COMPLETE", title: "Your init agent completed successfully", sourceType: "DRAFT", sourceId: initDraftId }
        : { userId, type: "INIT_COMPLETE", title: "Your init agent completed successfully", sourceType: "REPO_ITEM", sourceId: projectSlug ?? "" },
    ).catch(console.error);
  }

  // Notify program creator
  if (projectSlug && initResult) {
    void (async () => {
      try {
        const [project] = await db.select({ id: projects.id, title: projects.title }).from(projects).where(and(eq(projects.slug, projectSlug), isNull(projects.deletedAt))).limit(1);
        if (project) {
          const [pp] = await db.select({ programId: programProjects.programId }).from(programProjects).where(eq(programProjects.projectId, project.id)).limit(1);
          if (pp) {
            const [program] = await db.select({ createdBy: programs.createdBy }).from(programs).where(eq(programs.id, pp.programId)).limit(1);
            if (program && program.createdBy !== userId) {
              await createNotification({ userId: program.createdBy, type: "INIT_COMPLETE", title: `Project '${project.title}' initialization complete`, sourceType: "REPO_ITEM", sourceId: project.id, priority: "HIGH" });
            }
          }
        }
      } catch (e) { console.error("[runInitWithJobContext] program notification error:", e); }
    })();
  }

  // Optional server-side apply. This used to infer intent from project status
  // (`status !== INITIALIZING`), which made completed init runs fragile: if the
  // project had already become ACTIVE, the same InitAgentResult could be written
  // here and then again by the client Finish flow. Callers must now opt in.
  if (applyMode === "append" && projectSlug && initResult) {
    try {
      const typedResult = initResult as InitAgentResult;
      const [project] = await db
        .select({ id: projects.id, status: projects.status })
        .from(projects)
        .where(and(eq(projects.slug, projectSlug), isNull(projects.deletedAt)))
        .limit(1);
      if (!project) {
        // Rebuild / program flow expects an existing row; new-project flow
        // expects INITIALIZING. If we find neither, something has gone wrong
        // (e.g. project soft-deleted mid-init) — log so it doesn't fail silently.
        console.warn(
          `[auto-finalize] No active project row for slug='${projectSlug}' (runId=${ctx.runId}) — skipping applyInitResult. Draft will linger for manual recovery.`,
        );
      } else if (project.status === "ACTIVE") {
        await applyInitResult(typedResult, { projectId: project.id, userId, cleanExisting: false, label: "auto-finalize" }, db);

        // Persist paper graph ingest for rebuild flows.
        // H6: skip re-ingest when the Spine-First pipeline already ran
        // (projectId was provided to runInitWithJobContext). In that case
        // `explorePaperGraph` + `ingestSeedPapers` already persisted every
        // discovered paper, and re-running with `typedResult.crawledResources`
        // only risks duplicate rows for entries that lack an arxivId
        // (`upsertPaperNode` dedupes on arxivId only).
        try {
          if (!input.projectId) {
            const seedResources = typedResult.crawledResources ?? [];
            await safeIngestSeedPapers(project.id, seedResources, "init", 0);
          }
        } catch (e) { console.error("[auto-finalize] Paper graph ingestion failed:", e); }

        // Project exists & was updated → the draft we saved above is now
        // redundant. Delete it to avoid orphan drafts for rebuild flows.
        try {
          await db.delete(drafts).where(
            and(eq(drafts.agentRunId, ctx.runId), eq(drafts.type, "init"))
          );
        } catch { /* best-effort */ }
      } else {
        console.warn(
          `[auto-finalize] Refusing to apply to project slug='${projectSlug}' in status='${project.status}' (runId=${ctx.runId}).`,
        );
      }
    } catch (e) {
      console.error(`[auto-finalize] Failed for ${projectSlug}:`, e);
    }
  }

  return initResult;
}
