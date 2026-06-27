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
  fetchArxivById as realFetchArxivById,
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
import { addRelation, type RelationType } from "../../effort/store.js";
import { type NeighborPaper } from "./citation-explorer.js";
import { runReadingLoop, type PriorArtCorpus } from "./reading-loop.js";
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
  /**
   * [Design-Audit D-2b 2026-06-26] Optional abort signal. The agent
   * checks this at each major phase boundary and on each long-loop
   * iteration; when aborted, it flips the run to status:"error" with
   * error:"aborted by user" and throws. Wired through the CancelToken
   * created in init-project-routes when POST /:runId/cancel is hit.
   */
  signal?: AbortSignal;
  /** Test seams — default to the real network crawlers. */
  searchArxiv?: (query: string, maxResults: number) => Promise<CrawledResource[]>;
  fetchWikipediaSummary?: (topic: string) => Promise<string | null>;
  /**
   * Fetch one arxiv paper by id (for seed enrichment). Default: real
   * crawlers.fetchArxivById. Tests inject a fake that returns null
   * (= "no enrichment available") to avoid network.
   */
  fetchArxivById?: (arxivId: string) => Promise<CrawledResource | null>;
  /** Override the arXiv rate-limit delay (tests pass 0). */
  rateDelayMs?: number;
  /**
   * Citation-neighbor discovery seam for the Spine-First pipeline. mathran
   * ships no network citation source, so the host wires this (arXiv / S2);
   * tests inject a fake. Default: graph-only BFS.
   */
  fetchNeighbors?: (paper: PaperNode) => Promise<NeighborPaper[]>;
  /**
   * Reader source-fetch seams (Phase D). The reading loop drives the 3-pass
   * reader, which loads each paper's full source from arxiv. Tests inject a
   * stub so the pipeline runs offline; production defaults to the real
   * fetchArxivSource / pdftotext.
   */
  fetchArxivSource?: typeof import("../../paper-graph/arxiv-source.js").fetchArxivSource;
  runPdfToText?: (pdfPath: string) => Promise<string | null>;
  /**
   * Prior-art discovery seam (Phase D, Task 19). The real implementation lives
   * in `./prior-art/index.js` (W3-α) and is wired here at merge; injecting it
   * keeps this module decoupled from the concurrently-developed prior-art
   * package and lets tests run without network. When absent, the pipeline
   * proceeds with `priorArt: null` (surveys simply aren't promoted).
   */
  discoverPriorArt?: (args: {
    workspace: string;
    projectDir: string;
    problem: { title: string; formalStatement: string; tags: string[]; slug: string };
    llm: import("./spine/llm.js").SpineLLM;
  }) => Promise<PriorArtCorpus | null>;
}


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

/**
 * Auto-enrich a seed resource from arxiv when the caller only gave us
 * an arxivId (or an `arXiv:NNNN.NNNNN` placeholder title). Mathub's
 * DB-write path did this automatically; mathran's fs path didn't,
 * which is why early test runs produced paper nodes with empty
 * authors and `"Yitang Zhang seed"` for the title instead of the
 * real arxiv metadata. 2026-06-26.
 *
 * Returns the input untouched when:
 *   - It's not an arxiv resource (no `arxivId`)
 *   - The caller already supplied a real title (not the placeholder
 *     `arXiv:<id>` form) AND non-empty authors
 *   - The arxiv API fetch fails (network down, unknown id, etc.) —
 *     graceful degrade, never throws.
 *
 * Otherwise we splice in title / authors / year / abstract / url /
 * categories from the live arxiv record, keeping the caller's id.
 */
async function enrichSeedFromArxiv(
  res: CrawledResource,
  fetchById: (id: string) => Promise<CrawledResource | null>,
): Promise<CrawledResource> {
  if (!res.arxivId) return res;
  const placeholderTitle = res.title === `arXiv:${res.arxivId}`;
  const hasAuthors = Array.isArray(res.authors) && res.authors.length > 0;
  if (!placeholderTitle && hasAuthors && res.title.length > 0) {
    // Caller supplied enough metadata; trust it.
    return res;
  }
  const fetched = await fetchById(res.arxivId);
  if (!fetched) return res;
  return {
    ...res,
    // Keep the existing id (it's already `arxiv-<id>` and stable),
    // but pull every other field from arxiv when ours is empty.
    title: fetched.title || res.title,
    authors: fetched.authors.length > 0 ? fetched.authors : res.authors,
    year: res.year ?? fetched.year,
    abstract: res.abstract ?? fetched.abstract,
    url: res.url ?? fetched.url,
    categories: res.categories ?? fetched.categories,
    sourceType: res.sourceType ?? fetched.sourceType,
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
  // [Design-Audit D-2b 2026-06-26] Same abort helper as the spine path.
  const throwIfAborted = (): void => {
    if (ctx.signal?.aborted) throw new Error("aborted by user");
  };
  const searchArxiv = ctx.searchArxiv ?? ((q, n) => realSearchArxiv(q, n));
  const fetchWiki = ctx.fetchWikipediaSummary ?? ((t) => realFetchWiki(t));
  const fetchArxivById = ctx.fetchArxivById ?? ((id: string) => realFetchArxivById(id));
  const rateDelay = ctx.rateDelayMs ?? ARXIV_RATE_DELAY;

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
    // [Design-Audit D-3 2026-06-26] Parallel enrichment of seeds (was
    // serial in a for-loop). arxiv recommends ≤ 3 req/s, so we cap
    // concurrency at 3 and let `enrichSeedFromArxiv`'s internal
    // catch handle per-seed failures. 10 seeds went from ~30s
    // sequential to ~3s with this change.
    const ENRICH_CONCURRENCY = 3;
    const candidates: CrawledResource[] = [];
    for (const ref of input.seedReferences) {
      const r = refToResource(ref);
      if (r) candidates.push(r);
    }
    const seeds: CrawledResource[] = new Array(candidates.length);
    for (let i = 0; i < candidates.length; i += ENRICH_CONCURRENCY) {
      throwIfAborted();
      const slice = candidates.slice(i, i + ENRICH_CONCURRENCY);
      const enriched = await Promise.all(
        slice.map((res) => enrichSeedFromArxiv(res, fetchArxivById)),
      );
      for (let j = 0; j < enriched.length; j++) {
        seeds[i + j] = enriched[j]!;
      }
      // [Re-audit RE-7 2026-06-26] Respect arxiv rate-limit between
      // bursts (3 concurrent in burst is fine; firing the next burst
      // immediately would average > 3/sec).
      if (i + ENRICH_CONCURRENCY < candidates.length && rateDelay > 0) {
        await sleep(rateDelay);
      }
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
      queries = [input.problem.title, ...(input.problem.tags ?? [])].filter(Boolean);
    }
    // keep all generated queries; concept-extraction prompt already returns a sensible count.
    queries = queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0);
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
        const found = await searchArxiv(query, 20);
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
  // [Design-Audit D-2b 2026-06-26] Check abort at every phase
  // boundary. Helper closes over ctx.signal so individual sites stay
  // one-liners.
  const throwIfAborted = (): void => {
    if (ctx.signal?.aborted) {
      throw new Error("aborted by user");
    }
  };
  const searchArxiv = ctx.searchArxiv ?? ((q, n) => realSearchArxiv(q, n));
  const fetchArxivById = ctx.fetchArxivById ?? ((id: string) => realFetchArxivById(id));
  const rateDelay = ctx.rateDelayMs ?? ARXIV_RATE_DELAY;
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
    // ── Phase 1a: prior_art_discovery ─────────────────────────────────────
    // DESIGN-REFERENCE Part 3 / §7.1: before the reading loop, look for
    // surveys / Bourbaki / MathOverflow expositions. These are promoted to the
    // front of the reading queue (max priority). Failure-isolated: any error
    // degrades to priorArt:null and the loop simply doesn't promote surveys.
    throwIfAborted();
    await appendPhase(projectDir, runId, "prior_art_discovery", "start");
    let priorArt: PriorArtCorpus | null = null;
    if (ctx.discoverPriorArt) {
      try {
        priorArt = await ctx.discoverPriorArt({
          workspace,
          projectDir,
          problem: {
            title: problem.title,
            formalStatement: problem.formalStatement,
            tags: problem.tags,
            slug,
          },
          llm: spineLLM,
        });
      } catch (err) {
        await appendLog(projectDir, runId, "prior_art", `discoverPriorArt failed (continuing): ${errMsg(err)}`);
        priorArt = null;
      }
    }
    await writeCheckpoint(projectDir, runId, "prior_art_discovery", {
      surveys: priorArt?.surveys.length ?? 0,
      expositoryAnswers: priorArt?.expositoryAnswers.length ?? 0,
    });
    await appendPhase(projectDir, runId, "prior_art_discovery", "end", {
      surveys: priorArt?.surveys.length ?? 0,
      expositoryAnswers: priorArt?.expositoryAnswers.length ?? 0,
    });

    // ── Phase 1b: read_and_explore ────────────────────────────────────────
    throwIfAborted();
    await appendPhase(projectDir, runId, "read_and_explore", "start");
    const seeds: CrawledResource[] = [];
    // [Design-Audit D-3 2026-06-26] Parallel enrich (same as the
    // non-spine path) — 3-wide concurrency keeps us under arxiv's
    // suggested 3 req/s ceiling.
    const ENRICH_CONCURRENCY_SPINE = 3;
    const cands: CrawledResource[] = [];
    for (const ref of input.seedReferences) {
      const r = refToResource(ref);
      if (r) cands.push(r);
    }
    for (let i = 0; i < cands.length; i += ENRICH_CONCURRENCY_SPINE) {
      throwIfAborted();
      const slice = cands.slice(i, i + ENRICH_CONCURRENCY_SPINE);
      const enriched = await Promise.all(slice.map((res) => enrichSeedFromArxiv(res, fetchArxivById)));
      seeds.push(...enriched);
      // [Re-audit RE-7 2026-06-26] arxiv rate-limit between bursts.
      if (i + ENRICH_CONCURRENCY_SPINE < cands.length && rateDelay > 0) {
        await sleep(rateDelay);
      }
    }
    const seedResult = await ingestSeedPapersForProject(
      workspace,
      projectDir,
      seeds.map(resourceToNodeInput),
      { discoveredBy: "seed", relevanceScore: 1.0, depth: 0 },
    );
    await appendLog(projectDir, runId, "seed_ingest", `ingested ${seedResult.ingested.length} seeds (${seedResult.failed} failed)`);

    const KEYWORD_CAP = 8;
    const keywords = [input.problem.title, ...(input.problem.tags ?? [])]
      .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      .slice(0, KEYWORD_CAP);
    void keywords; // retained for downstream/patrol use; reading loop is biblio-driven

    // The reading loop (Phase D, Task 18) replaces the citation-graph BFS: it
    // reads each paper (skim→read→audit), harvests its bibliography into new
    // candidates, prioritises surveys, and converges naturally.
    const loopResult = await runReadingLoop(
      {
        workspace,
        projectDir,
        problem: {
          title: problem.title,
          formalStatement: problem.formalStatement,
          tags: problem.tags,
          slug,
        },
        seedPaperIds: seedResult.ingested,
        priorArt,
        llm: spineLLM,
        modelName: model ?? "",
      },
      {
        fetchArxivById: (id: string) => fetchArxivById(id),
        searchArxivByTitle: async (q, max) => {
          const res = await searchArxiv(q, max);
          return res
            .filter((r): r is CrawledResource & { arxivId: string } => typeof r.arxivId === "string")
            .map((r) => ({ arxivId: r.arxivId, title: r.title, authors: r.authors, year: r.year, abstract: r.abstract }));
        },
        rateDelayMs: rateDelay,
        fetchArxivSource: ctx.fetchArxivSource,
        runPdfToText: ctx.runPdfToText,
        emit,
      },
    );

    const rejectedSet = new Set(loopResult.rejectedPaperIds);
    // Downstream (build_spine) consumes a flat list of relevant paper ids. The
    // richer ReadingLoopResult (PaperReads, surveys, unresolved) is rewired into
    // the spine builder by W3-γ (Task 20). For now: all successfully-read papers
    // minus the hard-deleted (rejected) ones.
    const spinePaperIds = loopResult.reads.map((r) => r.paperId).filter((id) => !rejectedSet.has(id));

    summary.papersDiscovered = loopResult.reads.length + loopResult.rejectedPaperIds.length;
    summary.papersRelevant = spinePaperIds.length;
    summary.resourcesFound = loopResult.reads.length;

    await writeCheckpoint(projectDir, runId, "read_and_explore", {
      seedPapers: seedResult.ingested.length,
      read: loopResult.reads.length,
      rejected: loopResult.rejectedPaperIds.length,
      unresolved: loopResult.unresolvedCitations.length,
      convergence: loopResult.convergence.reason,
      rounds: loopResult.convergence.totalRoundsRun,
    });
    await appendPhase(projectDir, runId, "read_and_explore", "end", {
      read: loopResult.reads.length,
      relevant: spinePaperIds.length,
      rejected: loopResult.rejectedPaperIds.length,
      convergence: loopResult.convergence.reason,
    });

    // ── Phase 2: build_spine ──────────────────────────────────────────────
    throwIfAborted();
    await appendPhase(projectDir, runId, "build_spine", "start", { papers: spinePaperIds.length });
    const spine = await buildSpine(
      { projectDir, workspace, paperIds: spinePaperIds, mode: "full", problem, signal: ctx.signal },
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
    throwIfAborted();
    await appendPhase(projectDir, runId, "build_efforts", "start");
    const effortResult = input.aiInit.enableWorkspace
      ? await generateEffortsFromSpine(
          { spine, projectDir, workspace, problemTitle: problem.title },
          spineLLM,
          emit,
        )
      : { efforts: [], edges: [] };
    summary.effortsCreated = effortResult.efforts.length;
    // 2026-06-26 (sync-upgrade P0-A): persist the dep edges the spine
    // pipeline computed. Until now `effortResult.edges` was only used
    // for a count in the checkpoint and then discarded — schema, CLI,
    // and REST routes existed but the writer was missing. This loop
    // closes the gap so the effort dep graph is actually populated by
    // an init run.
    let edgesPersisted = 0;
    let edgesFailed = 0;
    for (const edge of effortResult.edges) {
      // spine relation type is a subset of the store's RelationType.
      const relType = edge.relation as RelationType;
      try {
        await addRelation(workspace, slug, {
          from: edge.fromId,
          to: edge.toId,
          type: relType,
          description: edge.description,
          confidence: edge.confidence,
          source: "spine",
        });
        edgesPersisted += 1;
      } catch (err) {
        edgesFailed += 1;
        await appendLog(projectDir, runId, "warn", `edge persist failed: ${edge.fromId}→${edge.toId} (${errMsg(err)})`);
      }
    }
    if (effortResult.edges.length > 0) {
      await appendLog(projectDir, runId, "spine", `persisted ${edgesPersisted}/${effortResult.edges.length} effort relations` + (edgesFailed > 0 ? ` (${edgesFailed} failed)` : ""));
    }
    await writeCheckpoint(projectDir, runId, "build_efforts", {
      efforts: effortResult.efforts.length,
      edges: effortResult.edges.length,
      edgesPersisted,
    });
    await appendPhase(projectDir, runId, "build_efforts", "end", {
      efforts: effortResult.efforts.length,
    });

    // ── Phase 4: spine_wiki ───────────────────────────────────────────────
    throwIfAborted();
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
      throwIfAborted();
      await appendPhase(projectDir, runId, "review_refine", "start");
      const review = await reviewAndRefinePages(rvConfig, spineLLM, emit);
      summary.pagesRefined = review.refinedCount;
      await writeCheckpoint(projectDir, runId, "review_refine", {
        refined: review.refinedCount,
        scores: review.scores,
      });
      await appendPhase(projectDir, runId, "review_refine", "end", { refined: review.refinedCount });

      // Phase 6: verify
      throwIfAborted();
      await appendPhase(projectDir, runId, "verify", "start");
      const verify = await verifyPages(rvConfig, spineLLM, emit);
      summary.pagesFlagged = verify.flaggedCount;
      await writeCheckpoint(projectDir, runId, "verify", {
        flagged: verify.flaggedCount,
        results: verify.results,
      });
      await appendPhase(projectDir, runId, "verify", "end", { flagged: verify.flaggedCount });

      // Phase 7: link_review (pure)
      throwIfAborted();
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
      throwIfAborted();
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
      crawledResources: loopResult.reads.length,
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
