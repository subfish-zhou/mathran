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
  listPaperReadIds,
  readPaperReadFile,
  type PaperNodeInput,
  type PaperRead,
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
  InitAgentReport,
  CrawledResource,
  ParsedReference,
} from "./types.js";
import { makeSpineLLM } from "./spine/llm.js";
import { buildSpine, readSpine } from "./spine/builder.js";
import { generateEffortsFromSpine } from "./spine/effort-from-spine.js";
import { synthesizeWiki, wikiDir, extractWorkspaceRefs } from "./wiki-synthesis/index.js";
import { outlineWikiPages, persistWikiPlan } from "./wiki-plan/index.js";
import { addRelation, type RelationType } from "../../effort/store.js";
import { type NeighborPaper } from "./citation-explorer.js";
import { runReadingLoop, type PriorArtCorpus } from "./reading-loop.js";
import { reviewLinks, checkCompleteness } from "./link-review.js";
import type { SpinePipelineEvent, WikiPageOutput, WorkspaceEffortOutput } from "./spine/types.js";
import type { PaperNode } from "../../paper-graph/index.js";
import {
  resolveModelPair,
  persistModelPair,
  IDENTICAL_MODELS_WARNING,
} from "./model-pair.js";
import { LlmAccounting } from "./llm-accounting.js";
import { runDir } from "./runs-ledger.js";

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
    problem: {
      title: string;
      formalStatement: string;
      tags: string[];
      backgroundSummary?: string;
      mathStatus?: string;
      slug: string;
    };
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
      const reply = await llmComplete(llm, model, prompt, { temperature: 0.2 });
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
        // No maxTokens — full markdown home page can be long; let the
        // provider use its model cap. Same fix class as spine/reviewer/etc.
        { temperature: 0.3 },
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

  // [Task 37] Resolve, warn-on-identical, and persist the writer/reviewer
  // model pair. Resolution honours explicit config > env > persisted settings >
  // default (gpt-5.5 / opus-4.8). Persisting back to settings.json means a
  // later re-run reuses the same pair unless overridden.
  const modelPair = await resolveModelPair(
    { writerModel: input.aiInit.writerModel, reviewerModel: input.aiInit.reviewerModel },
    projectDir,
    model,
  );
  if (modelPair.identical) {
    console.warn(IDENTICAL_MODELS_WARNING);
    await appendLog(projectDir, runId, "warn", IDENTICAL_MODELS_WARNING);
  }
  await persistModelPair(projectDir, modelPair);
  await appendLog(projectDir, runId, "config", "model pair resolved", {
    writerModel: modelPair.writerModel,
    reviewerModel: modelPair.reviewerModel,
  });

  // ── LLMs ──────────────────────────────────────────────────────────────────
  // Two SpineLLMs over the SAME provider but with DIFFERENT model strings, so
  // the reader/writer path uses `writerModel` and the review-loop uses
  // `reviewerModel`. `spineLLM` (writer-equivalent) is kept under its legacy
  // name so the rest of the file stays terse; `spineReviewerLLM` is new.
  //
  // Dogfood run 2 caught a wiring bug: the prior `spineLLM = makeSpineLLM(llm, model)`
  // path used only `ctx.model` (the original "default" model), so even after
  // resolveModelPair returned distinct writer/reviewer models, every call (writer
  // AND reviewer) hit the same underlying model. We now route them properly.
  const spineLLM = makeSpineLLM(llm, modelPair.writerModel);
  const spineReviewerLLM = makeSpineLLM(llm, modelPair.reviewerModel);

  // [Task 38] LLM cost accounting. Wrap the base SpineLLMs per phase so calls
  // and (estimated) tokens are attributed to writer / reviewer / reader / plan
  // roles. The reader path used to be metered post-hoc via PaperRead stats,
  // but the reader never measured token counts so cost came out as $0; we now
  // wrap it inline like writer/reviewer. The post-hoc addReaderStats fold-in
  // is dropped at the report site to avoid double-counting calls.
  const accounting = new LlmAccounting(modelPair.writerModel, modelPair.reviewerModel);
  const planLLM = accounting.wrap(spineLLM, "build_spine", "plan");
  const effortsWriterLLM = accounting.wrap(spineLLM, "build_efforts", "writer");
  const effortsReviewerLLM = accounting.wrap(spineReviewerLLM, "build_efforts_review", "reviewer");
  const wikiWriterLLM = accounting.wrap(spineLLM, "spine_wiki", "writer");
  const wikiReviewerLLM = accounting.wrap(spineReviewerLLM, "spine_wiki_review", "reviewer");
  const readerLLM = accounting.wrap(spineLLM, "read_and_explore", "reader");
  const priorArtLLM = accounting.wrap(spineLLM, "prior_art_discovery", "reader");
  // Legacy aliases — keep so existing usages (build_spine pipeline) keep working.
  const wikiLLM = wikiWriterLLM;

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
    //
    // ctx.discoverPriorArt is an optional injection seam (used by tests to
    // stub the network calls); when absent we use the real implementation
    // from ./prior-art/index.ts. Without this default the production CLI
    // path silently skipped prior-art discovery entirely — caught in
    // dogfood-run-7 when canonical-landmarks logs never appeared.
    throwIfAborted();
    await appendPhase(projectDir, runId, "prior_art_discovery", "start");
    let priorArt: PriorArtCorpus | null = null;
    const discoverFn =
      ctx.discoverPriorArt ??
      (async (args) => {
        const { discoverPriorArt: realDiscover } = await import("./prior-art/index.js");
        return realDiscover(args.problem, {
          workspace: args.workspace,
          llm: args.llm,
          emitLog: (m) => void appendLog(args.projectDir, runId, "prior_art", m),
        });
      });
    try {
      priorArt = await discoverFn({
        workspace,
        projectDir,
        problem: {
          title: problem.title,
          formalStatement: problem.formalStatement,
          tags: problem.tags,
          backgroundSummary: input.problem.backgroundSummary,
          mathStatus: input.problem.mathStatus,
          slug,
        },
        llm: priorArtLLM,
      });
    } catch (err) {
      await appendLog(projectDir, runId, "prior_art", `discoverPriorArt failed (continuing): ${errMsg(err)}`);
      priorArt = null;
    }
    await writeCheckpoint(projectDir, runId, "prior_art_discovery", {
      surveys: priorArt?.surveys.length ?? 0,
      expositoryAnswers: priorArt?.expositoryAnswers.length ?? 0,
    });
    // Surface unresolved canonical landmarks to the project root so the user
    // sees the "papers we couldn't auto-ingest" list without digging into
    // report.json. Skipped silently when everything resolved (no file ⇒ no
    // friction). Failure-isolated.
    try {
      await writeCanonToVendor(projectDir, priorArt);
    } catch (err) {
      await appendLog(projectDir, runId, "prior_art", `canon-to-vendor.md write failed: ${errMsg(err)}`);
    }
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
        llm: readerLLM,
        modelName: modelPair.writerModel,
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
    // v3 read-driven path: pass the reads + priorArt + mathStatus through so
    // buildSpine routes into buildSpineFromReads (which knows how to splice
    // verbatim statements out of PaperReadMainResult and how to fall back to
    // a shallow skim/survey-derived spine when mainResults are all empty).
    // Without readsContext the legacy raw-.tex path runs and the shallow-
    // fallback never fires — caught in dogfood run 4.
    const spine = await buildSpine(
      { projectDir, workspace, paperIds: spinePaperIds, mode: "full", problem, signal: ctx.signal },
      planLLM,
      emit,
      {
        reads: loopResult.reads,
        paperNodes: [],
        // The reading-loop module has its own PriorArtCorpus shape with extra
        // source variants (annual-review / lecture-notes-pdf) that the spine
        // builder's prior-art import doesn't know about. The cast is safe — the
        // builder only reads `surveys[*]` shallowly for structural priors and
        // tolerates unknown source values.
        priorArt: priorArt as Parameters<typeof buildSpine>[3] extends infer P
          ? P extends { priorArt: infer Q }
            ? Q
            : never
          : never,
        mathStatus: input.problem.mathStatus,
      },
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
          effortsWriterLLM,
          emit,
          {
            reviewerLlm: effortsReviewerLLM,
            writerModel: modelPair.writerModel,
            reviewerModel: modelPair.reviewerModel,
            selfReviewMode: modelPair.identical,
          },
        )
      : { efforts: [], edges: [] };
    summary.effortsCreated = effortResult.efforts.length;

    // Reverse-link efforts back into the spine: each effort with a `spineNodeId`
    // gets its id pushed into the corresponding spine node's `effortIds`. This
    // is required for downstream `checkCompleteness` to report non-zero spine
    // coverage — without it the spine's `node.effortIds` stays at `[]` forever
    // (caught in dogfood-run-5: spine had 11 nodes + 3 efforts but coverage=0%).
    let effortIdsLinked = 0;
    for (const e of effortResult.efforts) {
      const targetId = e.spineNodeId;
      if (!targetId) continue;
      const node = spine.nodes.find((n) => n.id === targetId);
      if (!node) continue;
      if (!node.effortIds.includes(e.id)) {
        node.effortIds.push(e.id);
        effortIdsLinked++;
      }
    }
    if (effortIdsLinked > 0) {
      try {
        const { writeSpine } = await import("./spine/builder.js");
        await writeSpine(projectDir, spine);
        await appendLog(projectDir, runId, "spine", `linked ${effortIdsLinked} effort id(s) back into spine nodes`);
      } catch (err) {
        await appendLog(projectDir, runId, "warn", `effortId reverse-link persist failed: ${errMsg(err)}`);
      }
    }
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
    const wikiOut = input.aiInit.enableWiki
      ? await runWikiSynthesis({
          spine,
          reads: loopResult.reads,
          priorArt,
          efforts: effortResult.efforts,
          problem,
          mathStatus: input.problem.mathStatus,
          projectDir,
          llm: wikiWriterLLM,
          reviewerLlm: wikiReviewerLLM,
          writerModel: modelPair.writerModel,
          reviewerModel: modelPair.reviewerModel,
          selfReviewMode: modelPair.identical,
          emit,
        })
      : { pages: [] as WikiPageOutput[], pageReviewSummaries: [] as import("./wiki-synthesis/index.js").WikiSynthesisResult["pageReviewSummaries"] };
    const pages = wikiOut.pages;
    const wikiPageReviewSummaries = wikiOut.pageReviewSummaries;
    const wikiPages = pages.map((p) => p.slug);
    summary.wikiPagesGenerated = wikiPages.length;
    await writeCheckpoint(projectDir, runId, "spine_wiki", { wikiPages });
    await appendPhase(projectDir, runId, "spine_wiki", "end", { wikiPages: wikiPages.length });

    // ── Phase 7-8: link / completeness review (pure; only with wiki) ──
    // The LLM review/verify passes were replaced by the writer-reviewer
    // review-loop, which now runs inline during effort- and wiki-synthesis.
    if (input.aiInit.enableWiki && pages.length > 0) {
      const rvConfig = {
        pages,
        efforts: effortResult.efforts,
        spine,
      };

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

    // ── final report (Task 38) ─────────────────────────────────────────────
    // Reader calls are tracked inline via the wrapped `readerLLM` SpineLLM
    // (see Phase 2 wiring above). The legacy post-hoc `accounting.addReaderStats`
    // fold-in was removed because it relied on `PaperRead.totalTokensIn/Out`
    // fields the reader never populated (always 0), so the dollar figure for
    // the reader path was always $0 in the report. Inline wrapping prices
    // every actual call instead.
    const report = await buildInitReport({
      runId,
      projectSlug: slug,
      projectDir,
      writerModel: modelPair.writerModel,
      reviewerModel: modelPair.reviewerModel,
      accounting,
      reads: loopResult.reads,
      efforts: effortResult.efforts,
      unresolvedCitations: loopResult.unresolvedCitations,
      priorArt,
      convergence: loopResult.convergence,
      wikiPageReviewSummaries,
    });
    await persistInitReport(projectDir, runId, report);
    printInitReport(report);

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
      report,
    };
  } catch (err) {
    await appendPhase(projectDir, runId, "error", "end", { error: errMsg(err) });
    await finishRun(projectDir, runId, "error", errMsg(err));
    throw err;
  }
}

// ============================================================
//  Final report (Task 38)
// ============================================================

interface BuildReportArgs {
  runId: string;
  projectSlug: string;
  projectDir: string;
  writerModel: string;
  reviewerModel: string;
  accounting: LlmAccounting;
  reads: PaperRead[];
  efforts: WorkspaceEffortOutput[];
  unresolvedCitations: Array<{ citedTitle?: string; whyImportant: string; doi?: string; venue?: string }>;
  /**
   * Prior-art corpus (or null when discovery didn't run or no provider was
   * configured). Used for canon-resolution reporting.
   */
  priorArt: PriorArtCorpus | null;
  convergence: { reason: string; totalRoundsRun: number };
  /**
   * Wiki review summaries (slug + revisionCount + finalVerdict) produced by
   * wiki-synthesis. Empty when the reviewer wasn't wired, or when the wiki
   * phase was resumed (the prior run's summaries weren't persisted to disk).
   * Used to roll wiki review verdicts into revisionsSummary alongside the
   * per-effort documentRevisions read from disk.
   */
  wikiPageReviewSummaries: import("./wiki-synthesis/index.js").WikiSynthesisResult["pageReviewSummaries"];
}

/**
 * Per-revision verdict shape used by `summarizeRevisions`. Sourced from
 * `effort.json.documentRevisions[*].reviewerVerdict` and from the
 * `pageReviewSummaries[*].finalVerdict` collected in-process by the
 * wiki-synthesis pass.
 */
type ArtifactReviewSummary = {
  /** Total reviewer calls run for this artifact (initial draft + rewrites). */
  revisionCount: number;
  /** Final verdict reported by review-loop. */
  finalVerdict: "approve" | "flagged_persistent" | "reviewer_broken";
};

/**
 * Scan persisted effort.json files for the per-effort `documentRevisions`
 * array that review-loop populates (see effort-synthesis/index.ts:66
 * EffortDocumentRevision schema). Never throws.
 *
 * Final verdict heuristic for effort docs:
 *   - last revision verdict='approve'           → approve
 *   - last revision verdict='reviewer_broken'   → reviewer_broken
 *   - otherwise (verdict='rewrite_requested' on the last revision = budget
 *     ran out without an approve)                → flagged_persistent
 *
 * This matches how review-loop/index.ts.reviewLoop computes its own
 * finalVerdict, so effort + wiki summaries align in revisionsSummary.
 *
 * Bug history: this function previously read `revisionHistory` (the
 * in-memory ReviewLoopResult field), but effort.json stores the array under
 * `documentRevisions` (see EffortDocumentRevision[]). The mismatch silently
 * collapsed every report to avgRevisions=0 / maxRevisions=0 / flagged=0
 * regardless of how the review loop actually went. Caught in
 * dogfood-run-d79c820c42b7 (12 efforts, real verdicts split 7 approve /
 * 5 flagged_persistent; report falsely showed 17 approve / 0 flagged /
 * avgRevisions=0).
 */
async function collectEffortReviewSummaries(
  projectDir: string,
  efforts: WorkspaceEffortOutput[],
): Promise<ArtifactReviewSummary[]> {
  const summaries: ArtifactReviewSummary[] = [];
  for (const eff of efforts) {
    try {
      const raw = await fs.readFile(path.join(projectDir, "efforts", eff.id, "effort.json"), "utf-8");
      const parsed = JSON.parse(raw) as {
        documentRevisions?: Array<{ reviewerVerdict?: string }>;
      };
      const revs = Array.isArray(parsed.documentRevisions) ? parsed.documentRevisions : [];
      if (revs.length === 0) continue;
      const lastVerdict = revs[revs.length - 1]?.reviewerVerdict;
      let finalVerdict: ArtifactReviewSummary["finalVerdict"];
      if (lastVerdict === "approve") finalVerdict = "approve";
      else if (lastVerdict === "reviewer_broken") finalVerdict = "reviewer_broken";
      else finalVerdict = "flagged_persistent"; // rewrite_requested on last rev = budget exhausted
      summaries.push({ revisionCount: revs.length, finalVerdict });
    } catch {
      /* no effort.json or no documentRevisions — skip */
    }
  }
  return summaries;
}

/** Assemble the comprehensive InitAgentReport from run artifacts. */
async function buildInitReport(args: BuildReportArgs): Promise<InitAgentReport> {
  const {
    runId, projectSlug, projectDir, writerModel, reviewerModel,
    accounting, reads, efforts, unresolvedCitations, priorArt, convergence,
    wikiPageReviewSummaries,
  } = args;

  // Revisions summary — combine per-effort documentRevisions (read from disk)
  // with in-process wiki page review summaries (passed in from the orchestrator
  // since wiki-synthesis doesn't persist its review history to disk).
  const effortReviewSummaries = await collectEffortReviewSummaries(projectDir, efforts);
  const allSummaries: ArtifactReviewSummary[] = [
    ...effortReviewSummaries,
    ...wikiPageReviewSummaries.map((s) => ({
      revisionCount: s.revisionCount,
      finalVerdict: s.finalVerdict,
    })),
  ];

  const artifactsReviewed = allSummaries.length;
  const artifactsApproved = allSummaries.filter((s) => s.finalVerdict === "approve").length;
  const artifactsFlaggedPersistent = allSummaries.filter((s) => s.finalVerdict === "flagged_persistent").length;
  const artifactsReviewerBroken = allSummaries.filter((s) => s.finalVerdict === "reviewer_broken").length;
  const revisionCounts = allSummaries.map((s) => s.revisionCount);
  const sumRevisions = revisionCounts.reduce((a, b) => a + b, 0);
  const avgRevisionsPerArtifact = artifactsReviewed > 0 ? sumRevisions / artifactsReviewed : 0;
  const maxRevisionsAcrossArtifacts = revisionCounts.length > 0 ? Math.max(...revisionCounts) : 0;

  return {
    runId,
    projectSlug,
    generatedAt: new Date().toISOString(),
    writerModel,
    reviewerModel,
    llmAccounting: accounting.report(),
    revisionsSummary: {
      artifactsReviewed,
      artifactsApproved,
      artifactsFlaggedPersistent,
      artifactsReviewerBroken,
      avgRevisionsPerArtifact: Math.round(avgRevisionsPerArtifact * 100) / 100,
      maxRevisionsAcrossArtifacts,
    },
    unresolvedCitations: unresolvedCitations.map((u) => ({
      citedTitle: u.citedTitle ?? "(untitled)",
      whyImportant: u.whyImportant,
      ...(u.doi ? { doi: u.doi } : {}),
      ...(u.venue ? { venue: u.venue } : {}),
    })),
    unresolvedCanonicalLandmarks: (() => {
      const canon = priorArt?.canonicalLandmarks ?? [];
      const doiOnly = canon
        .filter((c) => !c.arxivId && c.doi)
        .map((c) => ({ title: c.title, authors: c.authors, year: c.year ?? c.crossrefYear, doi: c.doi!, why: c.why }));
      const unresolved = canon
        .filter((c) => !c.arxivId && !c.doi)
        .map((c) => ({ title: c.title, authors: c.authors, year: c.year, venue: c.venue, why: c.why }));
      if (doiOnly.length === 0 && unresolved.length === 0) return undefined;
      return { doiOnly, unresolved };
    })(),
    convergenceSummary: { reason: convergence.reason, rounds: convergence.totalRoundsRun },
    fieldTooLargeTripped: reads.some((r) => r.truncated),
  };
}

/** Persist the report to `<project>/.mathran/agent-runs/<run-id>/report.json`. */
/**
 * Write a human-readable `canon-to-vendor.md` to the project root listing the
 * canonical landmark papers that the resolver could NOT auto-ingest into the
 * paper-graph. Split into two sections:
 *   1. DOI-only — Crossref found a reprint/journal record but no arxiv copy.
 *      The user needs to fetch the PDF from the venue (Springer / AMS / etc.).
 *   2. Fully unresolved — neither arxiv nor Crossref matched. Usually pre-arxiv
 *      classics in foreign languages or obscure venues; the user has to source
 *      the paper manually.
 *
 * Skipped (no file written) when both lists are empty so a fully-resolved
 * project doesn't have a misleading stub in its root. Failure-isolated by
 * the caller.
 */
async function writeCanonToVendor(projectDir: string, priorArt: PriorArtCorpus | null): Promise<void> {
  const canon = priorArt?.canonicalLandmarks ?? [];
  const doiOnly = canon.filter((c) => !c.arxivId && c.doi);
  const unresolved = canon.filter((c) => !c.arxivId && !c.doi);
  if (doiOnly.length === 0 && unresolved.length === 0) return;

  const lines: string[] = [];
  lines.push("# Canonical landmarks to vendor manually");
  lines.push("");
  lines.push(
    "The init agent named the following canonical landmark papers for this problem, " +
    "but could not auto-ingest them into the paper-graph (no arxiv copy is available). " +
    "Vendor the PDFs yourself so they can be referenced from efforts and the wiki.",
  );
  lines.push("");
  lines.push("Generated: " + new Date().toISOString());
  lines.push("");

  if (doiOnly.length > 0) {
    lines.push("## DOI resolved — fetch from publisher");
    lines.push("");
    lines.push("These have a Crossref / DOI record. Follow the link, log in to the venue if needed, and download the PDF.");
    lines.push("");
    for (const c of doiOnly) {
      const yr = c.year ?? c.crossrefYear ?? "?";
      const venue = c.venue ?? c.crossrefVenue ?? "?";
      const authors = c.authors.length > 0 ? c.authors.join(", ") : "(unknown authors)";
      lines.push(`- **${c.title}** (${yr}, ${venue})`);
      lines.push(`  - Authors: ${authors}`);
      lines.push(`  - DOI: https://doi.org/${c.doi}`);
      lines.push(`  - Why canon: ${c.why}`);
      lines.push("");
    }
  }

  if (unresolved.length > 0) {
    lines.push("## Fully unresolved — find manually");
    lines.push("");
    lines.push(
      "Neither arxiv nor Crossref returned a match. Usually pre-arxiv classics in foreign languages " +
      "(Vinogradov 1937 in Russian, Brun 1920 in French, etc.) or papers in obscure venues. " +
      "Use Google Scholar, the venue's archive, or a librarian.",
    );
    lines.push("");
    for (const c of unresolved) {
      const yr = c.year ?? "?";
      const venue = c.venue ?? "?";
      const authors = c.authors.length > 0 ? c.authors.join(", ") : "(unknown authors)";
      lines.push(`- **${c.title}** (${yr}, ${venue})`);
      lines.push(`  - Authors: ${authors}`);
      lines.push(`  - Why canon: ${c.why}`);
      lines.push("");
    }
  }

  await fs.writeFile(path.join(projectDir, "canon-to-vendor.md"), lines.join("\n"), "utf8");
}

async function persistInitReport(projectDir: string, runId: string, report: InitAgentReport): Promise<void> {
  try {
    const dir = runDir(projectDir, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
  } catch {
    /* report persistence is best-effort */
  }
}

/** Print a human-readable summary of the report to stdout. */
function printInitReport(report: InitAgentReport): void {
  const a = report.llmAccounting;
  const r = report.revisionsSummary;
  const phaseLines: string[] = [];
  const entries = Object.entries(a.breakdownByPhase).sort((x, y) => y[1].estimatedUsd - x[1].estimatedUsd);
  for (const [phase, stat] of entries) {
    phaseLines.push(`    ${phase.padEnd(28)} ${String(stat.calls).padStart(4)} calls   $${stat.estimatedUsd.toFixed(4)}`);
  }
  const canonNote = report.unresolvedCanonicalLandmarks
    ? `  canon to vendor: ${report.unresolvedCanonicalLandmarks.doiOnly.length} DOI-only, ${report.unresolvedCanonicalLandmarks.unresolved.length} unresolved (see canon-to-vendor.md)`
    : "";
  const lines = [
    "",
    `── init report: ${report.projectSlug} (${report.runId}) ──`,
    `  writer=${report.writerModel}  reviewer=${report.reviewerModel}`,
    `  LLM calls: writer=${a.writerCallsTotal} reviewer=${a.reviewerCallsTotal} reader=${a.readerCallsTotal} plan=${a.planAgentCalls}`,
    `  estimated cost: $${a.estimatedTotalUsd.toFixed(4)} total`,
    ...(phaseLines.length > 0 ? ["  cost by phase:", ...phaseLines] : []),
    `  revisions: reviewed=${r.artifactsReviewed} approved=${r.artifactsApproved} flagged=${r.artifactsFlaggedPersistent} avg=${r.avgRevisionsPerArtifact} max=${r.maxRevisionsAcrossArtifacts}`,
    `  convergence: ${report.convergenceSummary.reason} (${report.convergenceSummary.rounds} rounds)`,
    `  unresolved citations: ${report.unresolvedCitations.length}`,
    canonNote,
    report.fieldTooLargeTripped ? "  ⚠ field-too-large tripped (a source was truncated)" : "",
  ].filter(Boolean);
  console.log(lines.join("\n"));
}


/**
 * Ordered Spine-First phases. `resumeInitAgent` uses this to decide which
 * phases are already complete (skip + reload artifacts) vs. still pending.
 */
const SPINE_PHASE_ORDER = [
  "explore_graph",
  "build_spine",
  "build_efforts",
  "spine_wiki",
  "link_review",
  "completeness_check",
] as const;

export interface ResumeOptions {
  /** Explicit phase to treat as the last *completed* one (default: checkpoint). */
  fromPhase?: string;
}

export class ResumeError extends Error {}

/** Reconstruct minimal efforts (id + document.md) from the persisted efforts/ dir. */
async function reloadEfforts(projectDir: string): Promise<WorkspaceEffortOutput[]> {
  const effortsRoot = path.join(projectDir, "efforts");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(effortsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((d) => d.isDirectory());
  return Promise.all(
    dirs.map(async (d) => {
      let document = "";
      try {
        document = await fs.readFile(path.join(effortsRoot, d.name, "document.md"), "utf-8");
      } catch {
        /* no document.md — leave empty */
      }
      return {
        id: d.name,
        type: "REFERENCE",
        title: d.name,
        description: "",
        status: "DRAFT",
        subject: "",
        sources: [],
        document,
        tags: [],
        difficultyEstimate: "MODERATE",
      } as WorkspaceEffortOutput;
    }),
  );
}

/** Reload all persisted PaperReads for a workspace (resume path). */
async function reloadReads(workspace: string): Promise<PaperRead[]> {
  let ids: string[];
  try {
    ids = await listPaperReadIds(workspace);
  } catch {
    return [];
  }
  const reads = await Promise.all(ids.map((id) => readPaperReadFile(workspace, id)));
  return reads.filter((r): r is PaperRead => r != null);
}

/**
 * Wiki synthesis (v3): outline an LLM-decided WikiPlan, then write each page
 * sequentially with cross-references and citation enforcement, persisting to
 * `<project>/wiki/<slug>.md` plus a `_index.md` TOC. Replaces the legacy
 * fixed-5-page `generateWikiFromSpine`.
 */
async function runWikiSynthesis(args: {
  spine: import("./spine/types.js").NarrativeSpine;
  reads: PaperRead[];
  priorArt: PriorArtCorpus | null;
  efforts: WorkspaceEffortOutput[];
  problem: { title: string; formalStatement: string; description: string; tags: string[] };
  mathStatus?: string;
  projectDir: string;
  llm: ReturnType<typeof makeSpineLLM>;
  /** Writer-reviewer dual-model wiring; omit to skip the review loop. */
  reviewerLlm?: ReturnType<typeof makeSpineLLM>;
  writerModel?: string;
  reviewerModel?: string;
  /** Forwarded to reviewLoop; see review-loop/reviewer.ts. */
  selfReviewMode?: boolean;
  estimateCost?: (model: string, tokens: { in: number; out: number }) => number;
  emit: (e: SpinePipelineEvent) => void;
}): Promise<{
  pages: WikiPageOutput[];
  pageReviewSummaries: import("./wiki-synthesis/index.js").WikiSynthesisResult["pageReviewSummaries"];
}> {
  const emitLog = (m: string): void => args.emit({ type: "log", message: m });

  const plan = await outlineWikiPages(
    {
      problem: { ...args.problem, mathStatus: args.mathStatus },
      spine: args.spine,
      reads: args.reads,
      priorArt: args.priorArt as Parameters<typeof outlineWikiPages>[0]["priorArt"],
    },
    { llm: args.llm, emitLog },
  );
  await persistWikiPlan(args.projectDir, plan);

  const effortDocuments = new Map<string, string>(
    args.efforts.map((e) => [e.id, e.document ?? ""]),
  );

  const result = await synthesizeWiki(
    {
      plan,
      spine: args.spine,
      reads: args.reads,
      effortDocuments,
      problem: { title: args.problem.title, formalStatement: args.problem.formalStatement, mathStatus: args.mathStatus },
      projectDir: args.projectDir,
    },
    {
      llm: args.llm,
      reviewerLlm: args.reviewerLlm,
      writerModel: args.writerModel,
      reviewerModel: args.reviewerModel,
      selfReviewMode: args.selfReviewMode,
      estimateCost: args.estimateCost,
      emitLog,
    },
  );

  return {
    pages: result.pages.map((p) => ({
      slug: p.slug,
      title: p.title,
      content: p.content,
      workspaceRefs: p.workspaceRefs,
    })),
    pageReviewSummaries: result.pageReviewSummaries,
  };
}

/** Reconstruct wiki pages from persisted wiki/*.md (frontmatter-aware). */
async function reloadPages(projectDir: string): Promise<WikiPageOutput[]> {
  const dir = wikiDir(projectDir);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
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

  // Resume reuses the persisted writer/reviewer model pair so a re-run after
  // partial completion uses the same dual-model setup as the original run.
  const modelPair = await resolveModelPair(
    { writerModel: input.aiInit.writerModel, reviewerModel: input.aiInit.reviewerModel },
    projectDir,
    ctx.model,
  );
  const spineLLM = makeSpineLLM(ctx.llm, modelPair.writerModel);
  const spineReviewerLLM = makeSpineLLM(ctx.llm, modelPair.reviewerModel);
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
        {
          reviewerLlm: spineReviewerLLM,
          writerModel: modelPair.writerModel,
          reviewerModel: modelPair.reviewerModel,
        },
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
    let wikiPageReviewSummaries: import("./wiki-synthesis/index.js").WikiSynthesisResult["pageReviewSummaries"] = [];
    if (done("spine_wiki")) {
      pages = await reloadPages(projectDir);
      // No review summaries available when resuming past spine_wiki: the
      // pageReviewSummaries weren't persisted by the original run, so the
      // resumed report's revisionsSummary will be missing wiki contributions.
      // Effort revisions are still re-collected from disk below.
    } else if (input.aiInit.enableWiki) {
      await appendPhase(projectDir, runId, "spine_wiki", "start", { resumed: true });
      // Reload the persisted prior-art corpus so the wiki writer still has the
      // canonical-landmarks bibliography and survey context the original run
      // had. Without this, resume produces a thinner wiki than the main run
      // (caught when resume from build_efforts produced 3 wiki pages vs the
      // original's 8). loadPriorArt returns null when nothing was persisted,
      // which preserves the prior behaviour.
      const { loadPriorArt } = await import("./prior-art/index.js");
      const reloadedPriorArt = await loadPriorArt(ctx.workspace, slug);
      const wikiOut = await runWikiSynthesis({
        spine,
        reads: await reloadReads(ctx.workspace),
        priorArt: reloadedPriorArt,
        efforts,
        problem,
        mathStatus: input.problem.mathStatus,
        projectDir,
        llm: spineLLM,
        reviewerLlm: spineReviewerLLM,
        writerModel: modelPair.writerModel,
        reviewerModel: modelPair.reviewerModel,
        selfReviewMode: modelPair.identical,
        emit,
      });
      pages = wikiOut.pages;
      wikiPageReviewSummaries = wikiOut.pageReviewSummaries;
      await writeCheckpoint(projectDir, runId, "spine_wiki", { wikiPages: pages.map((p) => p.slug) });
      await appendPhase(projectDir, runId, "spine_wiki", "end", { wikiPages: pages.length });
    } else {
      pages = [];
    }
    summary.wikiPagesGenerated = pages.length;

    // ── review / verify / link / completeness ─────────────────────────────
    if (input.aiInit.enableWiki && pages.length > 0) {
      const rvConfig = { pages, efforts, spine };

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
