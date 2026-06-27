/**
 * Spine-First Architecture — Spine Builder (fs port of mathub's
 * `spine-builder.ts`).
 *
 * Builds the Narrative Spine from the fs paper graph:
 *   Step 1: Batch node extraction — per-cluster LLM calls to identify key contributions
 *   Step 2: Structure assembly — single LLM call to organize nodes into eras/threads/edges
 *   Step 3: Validation — verify spine consistency (paperIds exist, edges valid, …)
 *
 * The assembled spine is persisted to `<project>/.mathran/spine/spine.json`.
 * The DB layer (mathub) is replaced by the fs paper-graph; full-text fetch is
 * dropped (abstracts only). Pure helpers (dedupe/normalize/validate) are kept
 * verbatim so the original unit tests port unchanged.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { slugify } from "../../../../lib/slug.js";
import { getPaper, listCitations } from "../../../paper-graph/index.js";
import { fetchArxivSource } from "../../../paper-graph/arxiv-source.js";
import { buildNodeExtractionPrompt, buildSpineAssemblyPrompt } from "./prompts.js";
import { extractSpineJSON, errMsg, noopEmit, type SpineLLM, type EmitFn } from "./llm.js";
import { buildSpineFromReads } from "../synthesis/build-spine-from-reads.js";
import type { PaperRead, PaperNode } from "../../../paper-graph/types.js";
import type { PriorArtCorpus } from "../prior-art/index.js";
import type {
  NarrativeSpine,
  SpineNode,
  SpineEdge,
  SpineThread,
  SpineEra,
  SpineOpenQuestion,
  SpineNodeCandidate,
  SpineBuilderConfig,
} from "./types.js";

/**
 * v3 read-driven build context. When supplied to {@link buildSpine}, the
 * builder delegates to {@link buildSpineFromReads} (high-density PaperRead
 * distillations + PriorArtCorpus structural prior) instead of the legacy
 * raw-`.tex` path. Kept as an optional 4th argument so existing callers and
 * `spine/types.ts` (stable) are untouched; W3-β's `agent.ts` passes this
 * through once the reading loop has produced reads.
 */
export interface BuildSpineReadsContext {
  reads: PaperRead[];
  paperNodes: PaperNode[];
  priorArt: PriorArtCorpus | null;
  /** Optional status hint forwarded to the read-driven spine prompts. */
  mathStatus?: string;
}

interface BuilderPaper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  arxivId: string | null;
}

// ============================================================
//  fs persistence
// ============================================================

export function spineDir(projectDir: string): string {
  return path.join(projectDir, ".mathran", "spine");
}

export function spineFile(projectDir: string): string {
  return path.join(spineDir(projectDir), "spine.json");
}

/** Persist a spine to `<project>/.mathran/spine/spine.json`. Never throws. */
export async function writeSpine(projectDir: string, spine: NarrativeSpine): Promise<void> {
  try {
    await fs.mkdir(spineDir(projectDir), { recursive: true });
    await fs.writeFile(spineFile(projectDir), JSON.stringify(spine, null, 2) + "\n", "utf-8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[spine] writeSpine failed: ${errMsg(err)}`);
  }
}

/** Read the persisted spine, or null if none/invalid. */
export async function readSpine(projectDir: string): Promise<NarrativeSpine | null> {
  try {
    return JSON.parse(await fs.readFile(spineFile(projectDir), "utf-8")) as NarrativeSpine;
  } catch {
    return null;
  }
}

// ============================================================
//  Main Entry Point
// ============================================================

export async function buildSpine(
  config: SpineBuilderConfig,
  llm: SpineLLM,
  emit: EmitFn = noopEmit,
  readsContext?: BuildSpineReadsContext,
): Promise<NarrativeSpine> {
  // ── v3 path: build from high-density PaperReads when available. ──
  // The legacy raw-.tex path below is preserved unchanged for backward
  // compatibility (Batch 4 removes it).
  if (readsContext && readsContext.reads.length > 0) {
    emit({
      type: "log",
      message: `Building spine from ${readsContext.reads.length} PaperReads (v3 read-driven path)`,
    });
    const spine = await buildSpineFromReads(
      {
        problem: {
          title: config.problem.title,
          formalStatement: config.problem.formalStatement,
          description: config.problem.description,
          tags: config.problem.tags,
          mathStatus: readsContext.mathStatus,
        },
        reads: readsContext.reads,
        paperNodes: readsContext.paperNodes,
        priorArt: readsContext.priorArt,
      },
      { llm, emitLog: (message) => emit({ type: "log", message }) },
    );
    await writeSpine(config.projectDir, spine);
    emit({
      type: "spine_assembled",
      nodeCount: spine.nodes.length,
      edgeCount: spine.edges.length,
      threadCount: spine.threads.length,
    });
    return spine;
  }

  emit({ type: "log", message: `Building spine from ${config.paperIds.length} papers (mode=${config.mode})` });

  // ── Step 1: Batch Node Extraction ──
  const candidates = await extractNodeCandidates(config, llm, emit);
  emit({ type: "log", message: `Extracted ${candidates.length} spine node candidates` });

  if (candidates.length === 0) {
    const empty = config.existingSpine ?? createEmptySpine(config.problem.title);
    await writeSpine(config.projectDir, empty);
    return empty;
  }

  // ── Step 2: Structure Assembly ──
  const spine = await assembleSpineStructure(candidates, config, llm, emit);

  // ── Step 3: Validation ──
  const validated = validateSpine(spine, config.paperIds, emit);

  await writeSpine(config.projectDir, validated);

  emit({
    type: "spine_assembled",
    nodeCount: validated.nodes.length,
    edgeCount: validated.edges.length,
    threadCount: validated.threads.length,
  });

  return validated;
}

// ============================================================
//  Step 1: Batch Node Extraction
// ============================================================

async function loadPapers(workspace: string, paperIds: string[]): Promise<BuilderPaper[]> {
  const out: BuilderPaper[] = [];
  for (const id of paperIds) {
    const p = await getPaper(workspace, id);
    if (!p) continue;
    out.push({
      id: p.id,
      title: p.title,
      authors: p.authors ?? [],
      year: p.year ?? null,
      abstract: p.abstract ?? null,
      arxivId: p.arxivId ?? null,
    });
  }
  return out;
}

async function extractNodeCandidates(
  config: SpineBuilderConfig,
  llm: SpineLLM,
  emit: EmitFn,
): Promise<SpineNodeCandidate[]> {
  const allCandidates: SpineNodeCandidate[] = [];
  const existingNodeTitles = config.existingSpine?.nodes.map((n) => n.title) ?? [];

  const papers = await loadPapers(config.workspace, config.paperIds);
  if (papers.length === 0) return [];

  const idSet = new Set(config.paperIds);
  const allCitations = await listCitations(config.workspace);
  const internalCitations = allCitations.filter(
    (c) => idSet.has(c.citingPaperId) && idSet.has(c.citedPaperId),
  );

  const batches = clusterPapersByCitation(papers, internalCitations);
  emit({ type: "log", message: `Papers clustered into ${batches.length} batches` });

  for (let i = 0; i < batches.length; i++) {
    // [Design-Audit D-2b 2026-06-26] Abort check at each batch start
    // so the build_spine phase yields to cancel within ~one LLM call.
    if (config.signal?.aborted) {
      throw new Error("aborted by user");
    }
    const batch = batches[i]!;
    emit({ type: "log", message: `Processing batch ${i + 1}/${batches.length} (${batch.length} papers)` });

    // 2026-06-26 (sync-upgrade P1-C) — for each paper in the batch,
    // try to load its arxiv LaTeX source. When present, splice the
    // FULL main .tex into `fullText` so the LLM sees real math + theorem
    // statements + section structure instead of just the 400-char
    // abstract. We cap per-paper at 60 KB and total batch at 200 KB so
    // a single dense batch doesn't blow the context window.
    const PER_PAPER_CAP = 60_000;
    const BATCH_CAP = 200_000;
    let runningTotal = 0;
    const batchPapers: Array<{
      id: string;
      title: string;
      authors: string[];
      year?: number;
      abstract?: string;
      fullText?: string;
    }> = [];
    for (const p of batch) {
      let fullText: string | undefined;
      if (p.arxivId && runningTotal < BATCH_CAP) {
        try {
          const src = await fetchArxivSource(p.arxivId, { workspace: config.workspace });
          if (src.status === "ok" && src.mainTexFile) {
            const raw = await fs.readFile(src.mainTexFile, "utf-8");
            const remaining = Math.max(0, BATCH_CAP - runningTotal);
            const limit = Math.min(PER_PAPER_CAP, remaining);
            if (limit > 0) {
              fullText = raw.length > limit ? raw.slice(0, limit) + `\n\n[TRUNCATED at ${limit} bytes; full source at ${src.rootDir}]` : raw;
              runningTotal += fullText.length;
            }
          }
        } catch {
          // ignore — falling back to abstract-only is safe
        }
      }
      batchPapers.push({
        id: p.id,
        title: p.title,
        authors: p.authors,
        year: p.year ?? undefined,
        abstract: p.abstract ?? undefined,
        fullText,
      });
    }

    const batchCitations = internalCitations
      .filter((c) => batch.some((p) => p.id === c.citingPaperId) || batch.some((p) => p.id === c.citedPaperId))
      .map((c) => ({ citingId: c.citingPaperId, citedId: c.citedPaperId }));

    const prompt = buildNodeExtractionPrompt(batchPapers, batchCitations, {
      projectTitle: config.problem.title,
      formalStatement: config.problem.formalStatement,
      existingNodeTitles: [...existingNodeTitles, ...allCandidates.map((c) => c.node.title)],
    });

    try {
      const raw = await llm(prompt, { temperature: 0.2, maxTokens: 4000 });
      const parsed = extractSpineJSON<{ nodes?: Array<Record<string, unknown>> }>(raw);

      if (parsed && Array.isArray(parsed.nodes)) {
        for (const rawNode of parsed.nodes) {
          const candidate = coerceCandidate(rawNode, allCandidates.length);
          allCandidates.push(candidate);
          emit({
            type: "spine_node_extracted",
            nodeId: candidate.node.id,
            nodeType: candidate.node.type,
            title: candidate.node.title,
          });
        }
      }
    } catch (err) {
      emit({ type: "log", message: `Batch ${i + 1} extraction failed: ${errMsg(err)}` });
    }
  }

  return allCandidates;
}

const NODE_TYPES = new Set<SpineNode["type"]>([
  "foundation", "milestone", "technique_origin", "refinement",
  "barrier", "bridge", "dead_end", "open_direction",
]);
const NODE_DEPTHS = new Set<SpineNode["depth"]>(["foundational", "major", "incremental"]);

function coerceCandidate(rawNode: Record<string, unknown>, index: number): SpineNodeCandidate {
  const type = NODE_TYPES.has(rawNode.type as SpineNode["type"])
    ? (rawNode.type as SpineNode["type"])
    : "milestone";
  const depth = NODE_DEPTHS.has(rawNode.depth as SpineNode["depth"])
    ? (rawNode.depth as SpineNode["depth"])
    : "major";
  const paperIds = Array.isArray(rawNode.paper_ids) ? rawNode.paper_ids.map(String) : [];
  return {
    node: {
      id: slugify(String(rawNode.id ?? rawNode.title ?? `node-${index}`), `node-${index}`),
      type,
      title: String(rawNode.title ?? ""),
      year: typeof rawNode.year === "number" ? rawNode.year : undefined,
      authors: Array.isArray(rawNode.authors) ? rawNode.authors.map(String) : undefined,
      statement: String(rawNode.statement ?? ""),
      significance: String(rawNode.significance ?? ""),
      proofIdea: rawNode.proof_idea ? String(rawNode.proof_idea) : undefined,
      paperIds,
      depth,
    },
    sourcePaperIds: paperIds,
    suggestedEdges: Array.isArray(rawNode.suggested_edges)
      ? (rawNode.suggested_edges as Array<Record<string, unknown>>).map((e) => ({
          targetNodeId: String(e.target ?? ""),
          edgeType: String(e.type ?? "enables") as SpineEdge["type"],
          context: String(e.context ?? ""),
        }))
      : [],
  };
}

// ============================================================
//  Step 2: Structure Assembly
// ============================================================

async function assembleSpineStructure(
  candidates: SpineNodeCandidate[],
  config: SpineBuilderConfig,
  llm: SpineLLM,
  emit: EmitFn,
): Promise<NarrativeSpine> {
  const candidateSummaries = candidates.map((c) => ({
    id: c.node.id,
    type: c.node.type,
    title: c.node.title,
    year: c.node.year,
    statement: c.node.statement,
    significance: c.node.significance,
    depth: c.node.depth,
  }));

  const prompt = buildSpineAssemblyPrompt(candidateSummaries, {
    projectTitle: config.problem.title,
    formalStatement: config.problem.formalStatement,
    tags: config.problem.tags,
    existingSpine: config.existingSpine,
  });

  let parsed: Record<string, unknown> = {};
  try {
    const raw = await llm(prompt, { temperature: 0.3, maxTokens: 6000 });
    parsed = extractSpineJSON<Record<string, unknown>>(raw) ?? {};
  } catch (err) {
    emit({ type: "log", message: `Spine assembly LLM failed: ${errMsg(err)}` });
  }

  const nodes: SpineNode[] = [];
  const allNodeIds = new Set<string>();

  if (config.existingSpine) {
    for (const existing of config.existingSpine.nodes) {
      nodes.push(existing);
      allNodeIds.add(existing.id);
    }
  }

  for (const candidate of candidates) {
    if (!allNodeIds.has(candidate.node.id)) {
      nodes.push({ ...candidate.node, effortIds: [] });
      allNodeIds.add(candidate.node.id);
    }
  }

  const eras: SpineEra[] = asArray(parsed.eras).map((e) => ({
    name: String(e.name ?? ""),
    startYear: typeof e.start_year === "number" ? e.start_year : undefined,
    endYear: typeof e.end_year === "number" ? e.end_year : undefined,
    summary: String(e.summary ?? ""),
    nodeIds: asArray(e.node_ids).map(String).filter((id) => allNodeIds.has(id)),
  }));

  const edges: SpineEdge[] = asArray(parsed.edges)
    .map((e) => ({
      from: String(e.from ?? ""),
      to: String(e.to ?? ""),
      type: String(e.type ?? "enables") as SpineEdge["type"],
      context: String(e.context ?? ""),
    }))
    .filter((e) => allNodeIds.has(e.from) && allNodeIds.has(e.to));

  for (const candidate of candidates) {
    for (const se of candidate.suggestedEdges) {
      if (
        allNodeIds.has(se.targetNodeId) &&
        !edges.some(
          (e) =>
            (e.from === candidate.node.id && e.to === se.targetNodeId) ||
            (e.from === se.targetNodeId && e.to === candidate.node.id),
        )
      ) {
        edges.push({
          from: candidate.node.id,
          to: se.targetNodeId,
          type: se.edgeType,
          context: se.context,
        });
      }
    }
  }

  const threads: SpineThread[] = asArray(parsed.threads).map((t) => ({
    id: slugify(String(t.id ?? t.name ?? ""), "thread"),
    name: String(t.name ?? ""),
    description: String(t.description ?? ""),
    nodeIds: asArray(t.node_ids).map(String).filter((id) => allNodeIds.has(id)),
    status: (t.status as SpineThread["status"]) ?? "active",
    currentFrontier: t.current_frontier ? String(t.current_frontier) : undefined,
    barrier: t.barrier ? String(t.barrier) : undefined,
  }));

  const openQuestions: SpineOpenQuestion[] = asArray(parsed.open_questions).map((q) => ({
    title: String(q.title ?? ""),
    statement: String(q.statement ?? ""),
    relatedNodeIds: asArray(q.related_node_ids).map(String).filter((id) => allNodeIds.has(id)),
    barrier: String(q.barrier ?? ""),
    partialProgress: String(q.partial_progress ?? ""),
  }));

  return {
    version: config.existingSpine ? config.existingSpine.version + 1 : 1,
    updatedAt: new Date().toISOString(),
    globalThesis: String(parsed.global_thesis ?? config.existingSpine?.globalThesis ?? `Research landscape for ${config.problem.title}`),
    eras: eras.length > 0 ? eras : config.existingSpine?.eras ?? [],
    nodes,
    edges: config.existingSpine ? mergeEdges(config.existingSpine.edges, edges) : edges,
    threads: threads.length > 0 ? threads : config.existingSpine?.threads ?? [],
    openQuestions: openQuestions.length > 0 ? openQuestions : config.existingSpine?.openQuestions ?? [],
  };
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

// ============================================================
//  Step 3: Validation (ported verbatim)
// ============================================================

function validateSpine(
  spine: NarrativeSpine,
  validPaperIds: string[],
  emit: EmitFn,
): NarrativeSpine {
  const validPaperSet = new Set(validPaperIds);
  const dedupeFixes = dedupeSpineNodesByTitle(spine);
  const nodeIds = new Set(spine.nodes.map((n) => n.id));
  let fixes = dedupeFixes;

  for (const era of spine.eras) {
    const before = era.nodeIds.length;
    era.nodeIds = era.nodeIds.filter((id) => nodeIds.has(id));
    fixes += before - era.nodeIds.length;
  }

  for (const thread of spine.threads) {
    const before = thread.nodeIds.length;
    thread.nodeIds = thread.nodeIds.filter((id) => nodeIds.has(id));
    fixes += before - thread.nodeIds.length;
  }

  const validEdges = spine.edges.filter(
    (e) => nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to,
  );
  fixes += spine.edges.length - validEdges.length;
  spine.edges = validEdges;

  for (const node of spine.nodes) {
    node.paperIds = node.paperIds.filter((id) => validPaperSet.has(id));
  }

  const eraNodeIds = new Set(spine.eras.flatMap((e) => e.nodeIds));
  for (const node of spine.nodes) {
    if (!eraNodeIds.has(node.id)) {
      const bestEra =
        spine.eras.find((e) => {
          if (!node.year) return false;
          const start = e.startYear ?? 0;
          const end = e.endYear ?? 9999;
          return node.year >= start && node.year <= end;
        }) ?? spine.eras[spine.eras.length - 1];
      if (bestEra) {
        bestEra.nodeIds.push(node.id);
        fixes++;
      }
    }
  }

  if (fixes > 0) {
    emit({ type: "log", message: `Spine validation: fixed ${fixes} reference(s)` });
  }

  return spine;
}

export function dedupeSpineNodesByTitle(spine: NarrativeSpine): number {
  const canonicalByTitle = new Map<string, SpineNode>();
  const replacementIds = new Map<string, string>();
  const dedupedNodes: SpineNode[] = [];

  for (const node of spine.nodes) {
    const key = spineNodeDedupeKey(node);
    const existing = canonicalByTitle.get(key);
    if (!existing) {
      canonicalByTitle.set(key, node);
      dedupedNodes.push(node);
      continue;
    }

    replacementIds.set(node.id, existing.id);
    existing.paperIds = uniqueStrings([...existing.paperIds, ...node.paperIds]);
    existing.effortIds = uniqueStrings([...existing.effortIds, ...node.effortIds]);
    existing.authors = uniqueStrings([...(existing.authors ?? []), ...(node.authors ?? [])]);
    existing.statement = chooseRicherText(existing.statement, node.statement) ?? existing.statement;
    existing.significance = chooseRicherText(existing.significance, node.significance) ?? existing.significance;
    existing.proofIdea = chooseRicherText(existing.proofIdea, node.proofIdea);
    if (!existing.year && node.year) existing.year = node.year;
  }

  if (replacementIds.size === 0) return 0;

  const remapId = (id: string) => replacementIds.get(id) ?? id;
  spine.nodes = dedupedNodes;

  for (const era of spine.eras) {
    era.nodeIds = uniqueStrings(era.nodeIds.map(remapId));
  }
  for (const thread of spine.threads) {
    thread.nodeIds = uniqueStrings(thread.nodeIds.map(remapId));
  }
  for (const question of spine.openQuestions) {
    question.relatedNodeIds = uniqueStrings(question.relatedNodeIds.map(remapId));
  }

  const seenEdges = new Set<string>();
  spine.edges = spine.edges
    .map((edge) => ({ ...edge, from: remapId(edge.from), to: remapId(edge.to) }))
    .filter((edge) => {
      if (edge.from === edge.to) return false;
      const key = `${edge.from}->${edge.to}:${edge.type}`;
      if (seenEdges.has(key)) return false;
      seenEdges.add(key);
      return true;
    });

  return replacementIds.size;
}

function spineNodeDedupeKey(node: SpineNode): string {
  const year = node.year ?? extractFirstYear(node.title) ?? "";
  const normalizedTitle = normalizeSpineNodeTitle(node.title);
  if (!normalizedTitle) return `${node.type}:${year}:__id:${node.id}`;
  return `${node.type}:${year}:${normalizedTitle}`;
}

export function normalizeSpineNodeTitle(title: string): string {
  let normalized = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const colonIndex = normalized.indexOf(":");
  const prefix = colonIndex >= 0 ? normalized.slice(0, colonIndex) : "";
  if (colonIndex >= 0 && (/\b(18|19|20)\d{2}\b/.test(prefix) || /^[a-z.\-\s,&]+$/.test(prefix))) {
    normalized = normalized.slice(colonIndex + 1);
  }

  normalized = normalized.replace(
    /^[a-z.\-\s,&]+(?:\(|\s)+(18|19|20)\d{2}\)?\s*:?\s*/,
    "",
  );

  normalized = normalized
    .replace(/\b(18|19|20)\d{2}\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const stopwords = new Set(["a", "an", "and", "for", "in", "of", "on", "the", "to"]);
  return normalized
    .split(/\s+/)
    .filter((token) => token && !stopwords.has(token))
    .join(" ");
}

function extractFirstYear(title: string): number | undefined {
  const match = title.match(/\b(18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

function chooseRicherText(current: string | undefined, incoming: string | undefined): string | undefined {
  const currentText = current?.trim();
  const incomingText = incoming?.trim();
  if (!currentText) return incomingText ? incoming : undefined;
  if (!incomingText) return current;
  return incomingText.length > currentText.length ? incoming : current;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

// ============================================================
//  Helpers
// ============================================================

export function createEmptySpine(problemTitle: string): NarrativeSpine {
  return {
    version: 0,
    updatedAt: new Date().toISOString(),
    globalThesis: `Research landscape for ${problemTitle}`,
    eras: [],
    nodes: [],
    edges: [],
    threads: [],
    openQuestions: [],
  };
}

function mergeEdges(existing: SpineEdge[], newEdges: SpineEdge[]): SpineEdge[] {
  const edgeKeys = new Set(existing.map((e) => `${e.from}->${e.to}`));
  const merged = [...existing];
  for (const edge of newEdges) {
    const key = `${edge.from}->${edge.to}`;
    if (!edgeKeys.has(key)) {
      merged.push(edge);
      edgeKeys.add(key);
    }
  }
  return merged;
}

/** Cluster papers into groups of ≤8 by citation proximity. */
function clusterPapersByCitation(
  papers: BuilderPaper[],
  citations: Array<{ citingPaperId: string; citedPaperId: string }>,
): BuilderPaper[][] {
  if (papers.length <= 8) return [papers];

  const adj = new Map<string, Set<string>>();
  for (const p of papers) adj.set(p.id, new Set());
  for (const c of citations) {
    adj.get(c.citingPaperId)?.add(c.citedPaperId);
    adj.get(c.citedPaperId)?.add(c.citingPaperId);
  }

  const assigned = new Set<string>();
  const clusters: BuilderPaper[][] = [];
  const paperMap = new Map(papers.map((p) => [p.id, p]));

  for (const paper of papers) {
    if (assigned.has(paper.id)) continue;

    const cluster: BuilderPaper[] = [paper];
    assigned.add(paper.id);
    const queue = [paper.id];

    while (queue.length > 0 && cluster.length < 8) {
      const current = queue.shift()!;
      const neighbors = adj.get(current) ?? new Set();
      for (const neighborId of neighbors) {
        if (cluster.length >= 8) break;
        if (!assigned.has(neighborId)) {
          const neighbor = paperMap.get(neighborId);
          if (neighbor) {
            cluster.push(neighbor);
            assigned.add(neighborId);
            queue.push(neighborId);
          }
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}
