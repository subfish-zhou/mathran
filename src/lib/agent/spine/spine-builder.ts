/**
 * Spine-First Architecture — Spine Builder
 *
 * Builds or incrementally updates the Narrative Spine from paper graph data:
 *   Step 1: Batch node extraction — per-cluster LLM calls to identify key contributions
 *   Step 2: Structure assembly — single LLM call to organize nodes into eras/threads/edges
 *   Step 3: Validation — verify spine consistency (all paperIds exist, edges valid, etc.)
 */

import { eq, inArray } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { paperNodes, paperCitations, projects } from "@/server/db/schema";
import { callAzureLLM, extractJSON, type TokenCounter } from "../azure-llm";
// TODO(mathran-v0.1): import { fetchArxivFullText } from "../full-text";
// TODO(mathran-v0.1): import { slugify } from "@/lib/utils";
import { buildNodeExtractionPrompt, buildSpineAssemblyPrompt } from "./prompts";
import type {
  NarrativeSpine,
  SpineNode,
  SpineEdge,
  SpineThread,
  SpineEra,
  SpineOpenQuestion,
  SpineNodeCandidate,
  SpineBuilderConfig,
  SpinePipelineEvent,
} from "./types";

// ============================================================
//  Main Entry Point
// ============================================================

export async function buildSpine(
  config: SpineBuilderConfig,
  emit: (e: SpinePipelineEvent) => void,
  tokenCounter: TokenCounter,
): Promise<NarrativeSpine> {
  const db = getDb();

  emit({ type: "log", message: `Building spine from ${config.paperIds.length} papers (mode=${config.mode})` });

  // ── Step 1: Batch Node Extraction ──
  emit({ type: "log", message: "Step 1: Extracting spine node candidates from paper batches..." });
  const candidates = await extractNodeCandidates(config, emit, tokenCounter);
  emit({ type: "log", message: `Extracted ${candidates.length} spine node candidates` });

  if (candidates.length === 0) {
    emit({ type: "log", message: "No candidates extracted, returning empty/existing spine" });
    return config.existingSpine ?? createEmptySpine(config.problem.title);
  }

  // ── Step 2: Structure Assembly ──
  emit({ type: "log", message: "Step 2: Assembling spine structure..." });
  const spine = await assembleSpineStructure(candidates, config, emit, tokenCounter);

  // ── Step 3: Validation ──
  emit({ type: "log", message: "Step 3: Validating spine consistency..." });
  const validated = validateSpine(spine, config.paperIds, emit);

  // Persist spine to project
  await db
    .update(projects)
    .set({
      narrativeSpine: validated as unknown as Record<string, unknown>,
      spineVersion: config.existingSpine
        ? (config.existingSpine.version + 1)
        : 1,
    })
    .where(eq(projects.id, config.projectId));

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

/**
 * Cluster papers by citation proximity, then extract spine node candidates
 * from each cluster via a focused LLM call.
 */
async function extractNodeCandidates(
  config: SpineBuilderConfig,
  emit: (e: SpinePipelineEvent) => void,
  tokenCounter: TokenCounter,
): Promise<SpineNodeCandidate[]> {
  const db = getDb();
  const allCandidates: SpineNodeCandidate[] = [];
  const existingNodeTitles = config.existingSpine?.nodes.map((n) => n.title) ?? [];

  // Load all papers
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
    .where(inArray(paperNodes.id, config.paperIds));

  if (papers.length === 0) return [];

  // Load citation edges within this paper set
  const allCitations = await db
    .select({
      citingPaperId: paperCitations.citingPaperId,
      citedPaperId: paperCitations.citedPaperId,
    })
    .from(paperCitations)
    .where(inArray(paperCitations.citingPaperId, config.paperIds));

  const internalCitations = allCitations.filter(
    (c) => config.paperIds.includes(c.citedPaperId)
  );

  // Cluster papers into batches of 5-8 by citation proximity
  const batches = clusterPapersByCitation(papers, internalCitations);
  emit({ type: "log", message: `Papers clustered into ${batches.length} batches` });

  // Fetch full texts for papers (prioritize by batch)
  const fullTexts = new Map<string, string>();
  for (const batch of batches) {
    for (const paper of batch) {
      if (paper.arxivId && !fullTexts.has(paper.id)) {
        try {
          const ft = await fetchArxivFullText(paper.arxivId);
          if (ft) fullTexts.set(paper.id, ft.text.slice(0, 5000));
        } catch { /* non-critical */ }
      }
    }
  }

  // Process each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    emit({ type: "log", message: `Processing batch ${i + 1}/${batches.length} (${batch.length} papers)` });

    const batchPapers = batch.map((p) => ({
      id: p.id,
      title: p.title,
      authors: p.authors as string[],
      year: p.year ?? undefined,
      abstract: p.abstract ?? undefined,
      fullText: fullTexts.get(p.id),
    }));

    const batchCitations = internalCitations
      .filter((c) => batch.some((p) => p.id === c.citingPaperId) || batch.some((p) => p.id === c.citedPaperId))
      .map((c) => ({ citingId: c.citingPaperId, citedId: c.citedPaperId }));

    const prompt = buildNodeExtractionPrompt(
      batchPapers,
      batchCitations,
      {
        projectTitle: config.problem.title,
        formalStatement: config.problem.formalStatement,
        existingNodeTitles: [
          ...existingNodeTitles,
          ...allCandidates.map((c) => c.node.title),
        ],
      },
    );

    try {
      const raw = await callAzureLLM(prompt, {
        tokenCounter,
        tracker: { module: "spine-builder", operation: "node-extraction" },
        timeoutMs: 600_000,
      });
      const parsed = JSON.parse(sanitizeLLMJson(extractJSON(raw)));

      if (Array.isArray(parsed.nodes)) {
        for (const rawNode of parsed.nodes) {
          const candidate: SpineNodeCandidate = {
            node: {
              id: slugify(String(rawNode.id ?? rawNode.title ?? `node-${allCandidates.length}`)),
              type: rawNode.type ?? "milestone",
              title: String(rawNode.title ?? ""),
              year: typeof rawNode.year === "number" ? rawNode.year : undefined,
              authors: Array.isArray(rawNode.authors) ? rawNode.authors.map(String) : undefined,
              statement: String(rawNode.statement ?? ""),
              significance: String(rawNode.significance ?? ""),
              proofIdea: rawNode.proof_idea ? String(rawNode.proof_idea) : undefined,
              paperIds: Array.isArray(rawNode.paper_ids) ? rawNode.paper_ids.map(String) : [],
              depth: rawNode.depth ?? "major",
            },
            sourcePaperIds: Array.isArray(rawNode.paper_ids) ? rawNode.paper_ids.map(String) : [],
            suggestedEdges: Array.isArray(rawNode.suggested_edges)
              ? rawNode.suggested_edges.map((e: Record<string, unknown>) => ({
                  targetNodeId: String(e.target ?? ""),
                  edgeType: String(e.type ?? "enables"),
                  context: String(e.context ?? ""),
                }))
              : [],
          };
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
      emit({ type: "log", message: `Batch ${i + 1} extraction failed: ${err instanceof Error ? err.message : "unknown"}` });
    }
  }

  return allCandidates;
}

// ============================================================
//  Step 2: Structure Assembly
// ============================================================

async function assembleSpineStructure(
  candidates: SpineNodeCandidate[],
  config: SpineBuilderConfig,
  emit: (e: SpinePipelineEvent) => void,
  tokenCounter: TokenCounter,
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

  const raw = await callAzureLLM(prompt, {
    tokenCounter,
    tracker: { module: "spine-builder", operation: "structure-assembly" },
    timeoutMs: 900_000,
  });

  const parsed = JSON.parse(sanitizeLLMJson(extractJSON(raw)));

  // Merge LLM-assembled structure with candidate node details
  const _nodeMap = new Map(candidates.map((c) => [c.node.id, c.node]));

  // Build full spine nodes (LLM assembly + candidate details)
  const nodes: SpineNode[] = [];
  const allNodeIds = new Set<string>();

  // Include existing spine nodes in incremental mode
  if (config.existingSpine) {
    for (const existing of config.existingSpine.nodes) {
      nodes.push(existing);
      allNodeIds.add(existing.id);
    }
  }

  // Add new candidate nodes
  for (const candidate of candidates) {
    if (!allNodeIds.has(candidate.node.id)) {
      nodes.push({ ...candidate.node, effortIds: [] });
      allNodeIds.add(candidate.node.id);
    }
  }

  // Parse eras
  const eras: SpineEra[] = (parsed.eras ?? []).map((e: Record<string, unknown>) => ({
    name: String(e.name ?? ""),
    startYear: typeof e.start_year === "number" ? e.start_year : undefined,
    endYear: typeof e.end_year === "number" ? e.end_year : undefined,
    summary: String(e.summary ?? ""),
    nodeIds: (Array.isArray(e.node_ids) ? e.node_ids : [])
      .map(String)
      .filter((id: string) => allNodeIds.has(id)),
  }));

  // Parse edges
  const edges: SpineEdge[] = (parsed.edges ?? []).map((e: Record<string, unknown>) => ({
    from: String(e.from ?? ""),
    to: String(e.to ?? ""),
    type: String(e.type ?? "enables"),
    context: String(e.context ?? ""),
  })).filter((e: SpineEdge) => allNodeIds.has(e.from) && allNodeIds.has(e.to));

  // Also incorporate suggested edges from candidates
  for (const candidate of candidates) {
    for (const se of candidate.suggestedEdges) {
      if (allNodeIds.has(se.targetNodeId) && !edges.some(
        (e) => (e.from === candidate.node.id && e.to === se.targetNodeId) ||
               (e.from === se.targetNodeId && e.to === candidate.node.id)
      )) {
        edges.push({
          from: candidate.node.id,
          to: se.targetNodeId,
          type: se.edgeType as SpineEdge["type"],
          context: se.context,
        });
      }
    }
  }

  // Parse threads
  const threads: SpineThread[] = (parsed.threads ?? []).map((t: Record<string, unknown>) => ({
    id: slugify(String(t.id ?? t.name ?? "")),
    name: String(t.name ?? ""),
    description: String(t.description ?? ""),
    nodeIds: (Array.isArray(t.node_ids) ? t.node_ids : [])
      .map(String)
      .filter((id: string) => allNodeIds.has(id)),
    status: (t.status as SpineThread["status"]) ?? "active",
    currentFrontier: t.current_frontier ? String(t.current_frontier) : undefined,
    barrier: t.barrier ? String(t.barrier) : undefined,
  }));

  // Parse open questions
  const openQuestions: SpineOpenQuestion[] = (parsed.open_questions ?? []).map((q: Record<string, unknown>) => ({
    title: String(q.title ?? ""),
    statement: String(q.statement ?? ""),
    relatedNodeIds: (Array.isArray(q.related_node_ids) ? q.related_node_ids : [])
      .map(String)
      .filter((id: string) => allNodeIds.has(id)),
    barrier: String(q.barrier ?? ""),
    partialProgress: String(q.partial_progress ?? ""),
  }));

  // Merge with existing spine in incremental mode
  const mergedSpine: NarrativeSpine = {
    version: config.existingSpine ? config.existingSpine.version + 1 : 1,
    updatedAt: new Date().toISOString(),
    globalThesis: String(parsed.global_thesis ?? config.existingSpine?.globalThesis ?? ""),
    eras: eras.length > 0 ? eras : config.existingSpine?.eras ?? [],
    nodes,
    edges: config.existingSpine
      ? mergeEdges(config.existingSpine.edges, edges)
      : edges,
    threads: threads.length > 0 ? threads : config.existingSpine?.threads ?? [],
    openQuestions: openQuestions.length > 0 ? openQuestions : config.existingSpine?.openQuestions ?? [],
  };

  return mergedSpine;
}

// ============================================================
//  Step 3: Validation
// ============================================================

function validateSpine(
  spine: NarrativeSpine,
  validPaperIds: string[],
  emit: (e: SpinePipelineEvent) => void,
): NarrativeSpine {
  const validPaperSet = new Set(validPaperIds);
  const dedupeFixes = dedupeSpineNodesByTitle(spine);
  const nodeIds = new Set(spine.nodes.map((n) => n.id));
  let fixes = dedupeFixes;

  // Ensure all era/thread nodeIds reference valid nodes
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

  // Ensure edges reference valid nodes
  const validEdges = spine.edges.filter(
    (e) => nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to
  );
  fixes += spine.edges.length - validEdges.length;
  spine.edges = validEdges;

  // Ensure nodes have valid paperIds
  for (const node of spine.nodes) {
    const _before = node.paperIds.length;
    node.paperIds = node.paperIds.filter((id) => validPaperSet.has(id));
    // Don't count paper ID filtering as fixes (they may be from existing spine)
  }

  // Ensure every node appears in at least one era
  const eraNodeIds = new Set(spine.eras.flatMap((e) => e.nodeIds));
  for (const node of spine.nodes) {
    if (!eraNodeIds.has(node.id)) {
      // Add to the most appropriate era by year
      const bestEra = spine.eras.find((e) => {
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

function createEmptySpine(problemTitle: string): NarrativeSpine {
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

/**
 * Cluster papers into groups of 5-8 by citation proximity.
 * Papers that cite each other are grouped together.
 */
function clusterPapersByCitation(
  papers: Array<{ id: string; title: string; authors: string[] | null; year: number | null; abstract: string | null; arxivId: string | null }>,
  citations: Array<{ citingPaperId: string; citedPaperId: string }>,
): Array<typeof papers> {
  if (papers.length <= 8) return [papers];

  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const p of papers) adj.set(p.id, new Set());
  for (const c of citations) {
    adj.get(c.citingPaperId)?.add(c.citedPaperId);
    adj.get(c.citedPaperId)?.add(c.citingPaperId);
  }

  // Greedy clustering: BFS from unassigned papers
  const assigned = new Set<string>();
  const clusters: Array<typeof papers> = [];
  const paperMap = new Map(papers.map((p) => [p.id, p]));

  for (const paper of papers) {
    if (assigned.has(paper.id)) continue;

    const cluster: typeof papers = [paper];
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

// sanitizeLLMJson moved into extractJSON (src/lib/agent/azure-llm.ts) so every
// JSON.parse(extractJSON(...)) call site in the agent pipeline benefits
// automatically. Kept as a zero-op passthrough here to minimize diff churn
// at the two existing call sites.
const sanitizeLLMJson = (s: string) => s;
