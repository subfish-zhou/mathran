/**
 * Spine-First Architecture — Effort Generation from Spine
 *
 * Generates workspace efforts from the Narrative Spine:
 *   - Each SpineThread → a REFERENCE effort (literature survey for that research line)
 *   - Each major SpineNode → a METHOD/CONSTRUCTION/etc effort (detailed technical document)
 *   - SpineEdges → WorkspaceEffortRelations (direct mapping, no LLM guessing)
 */

import { inArray } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { paperNodes } from "@/server/db/schema";
import { callAzureLLM, type TokenCounter } from "../azure-llm";
// TODO(mathran-v0.1): import { fetchArxivFullText } from "../full-text";
import { slugify } from "@/lib/slug";
import { buildEffortDocumentPrompt, buildThreadDocumentPrompt } from "./prompts";
import type {
  NarrativeSpine,
  SpineNode,
  SpineEdge,
  SpineThread,
  SpinePipelineEvent,
  SpineDiff,
} from "./types";
import type { CrawledResource, WorkspaceEffortOutput, DependencyEdgeOutput } from "../init-types";

// ============================================================
//  Types
// ============================================================

export interface EffortFromSpineConfig {
  spine: NarrativeSpine;
  projectId: string;
  problemTitle: string;
  /** Only generate efforts for specific spine diff (patrol incremental) */
  diff?: SpineDiff;
}

export interface EffortFromSpineResult {
  efforts: WorkspaceEffortOutput[];
  edges: DependencyEdgeOutput[];
}

// ============================================================
//  Main Entry Point
// ============================================================

export async function generateEffortsFromSpine(
  config: EffortFromSpineConfig,
  emit: (e: SpinePipelineEvent) => void,
  tokenCounter: TokenCounter,
): Promise<EffortFromSpineResult> {
  const { spine, problemTitle, diff } = config;
  const efforts: WorkspaceEffortOutput[] = [];
  const edges: DependencyEdgeOutput[] = [];

  // Determine which nodes/threads to process
  const nodesToProcess = diff
    ? [
        ...diff.newNodes,
        ...diff.updatedNodes
          .map((u) => spine.nodes.find((n) => n.id === u.id))
          .filter((n): n is SpineNode => n != null),
      ]
    : spine.nodes.filter(shouldProcessNodeInFullInit);

  const threadsToProcess = diff
    ? [...diff.newThreads, ...diff.updatedThreads]
    : spine.threads;

  emit({ type: "log", message: `Generating efforts: ${threadsToProcess.length} threads, ${nodesToProcess.length} nodes` });

  // H4: de-duplicate effort IDs. `slugify` can collide across threads+nodes
  // (e.g. thread "Polynomial Methods" and node "Polynomial methods" both →
  // "polynomial-methods"). Without this guard the second insert in
  // `applyInitResult` trips a unique-constraint violation and the effort is
  // silently dropped. We track assigned IDs and append `-2`, `-3`, … on
  // collision.
  const usedEffortIds = new Set<string>();
  const reserveEffortId = (base: string): string => {
    if (!usedEffortIds.has(base)) {
      usedEffortIds.add(base);
      return base;
    }
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!usedEffortIds.has(candidate)) {
        usedEffortIds.add(candidate);
        emit({ type: "log", message: `⚠️ Effort ID "${base}" collision; using "${candidate}"` });
        return candidate;
      }
    }
    const candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    usedEffortIds.add(candidate);
    return candidate;
  };
  // Authoritative spine-id → effort-id map, populated during generation so
  // edge resolution below doesn't have to reverse-derive IDs via
  // `slugify(title) === effort.id` (which breaks after collision suffixing).
  const spineToEffort = new Map<string, string>();

  // ── 1. Thread → REFERENCE efforts ──
  for (const thread of threadsToProcess) {
    emit({ type: "log", message: `Generating thread survey: ${thread.name}` });

    const threadNodes = thread.nodeIds
      .map((id) => spine.nodes.find((n) => n.id === id))
      .filter(Boolean) as SpineNode[];

    const paperIds = [...new Set(threadNodes.flatMap((n) => n.paperIds))];
    const papers = await loadPaperMetadata(paperIds);
    const era = spine.eras.find((e) => e.nodeIds.some((id) => thread.nodeIds.includes(id)));
    const years = threadNodes.map((n) => n.year).filter((year): year is number => typeof year === "number");
    const year = years.length > 0 ? Math.min(...years) : undefined;

    let document: string;
    try {
      document = await callAzureLLM(
        buildThreadDocumentPrompt(thread, threadNodes, papers, problemTitle),
        { tokenCounter, tracker: { module: "spine-efforts", operation: "thread-doc" }, timeoutMs: 600_000 },
      );
    } catch (err) {
      emit({ type: "log", message: `Thread doc generation failed for "${thread.name}": ${err instanceof Error ? err.message : "unknown"}` });
      document = `Survey of ${thread.name}. ${thread.description}`;
    }

    const effortId = reserveEffortId(slugify(thread.name));
    spineToEffort.set(thread.id, effortId);

    efforts.push({
      id: effortId,
      type: "REFERENCE",
      title: thread.name,
      description: thread.description,
      status: "REFERENCE",
      subject: thread.currentFrontier ?? thread.barrier ?? thread.description,
      sources: papers.map(paperToResource),
      document,
      tags: buildThreadTags(thread),
      difficultyEstimate: estimateThreadDifficulty(thread.status),
      year,
      era: era?.name,
      spineThreadId: thread.id,
      abstract: thread.description,
      narrativeRole: thread.status === "dead_end" ? "dead_end" : "core_technique",
      referenceKind: "thread_survey",
      includedPaperIds: paperIds,
      includedSpineNodeIds: thread.nodeIds,
    });

    // Link thread effort to its spine thread
    emit({ type: "effort_created", effortId, title: thread.name, fromSpineNode: thread.id });
  }

  // ── 2. Major Spine Nodes → METHOD efforts ──
  const majorNodes = nodesToProcess.filter(shouldGenerateNodeEffort);

  for (const node of majorNodes) {
    emit({ type: "log", message: `Generating effort for: ${node.title}` });

    const papers = await loadPaperMetadata(node.paperIds);
    const fullTexts = new Map<string, string>();
    for (const paper of papers) {
      if (paper.arxivId) {
        try {
          const ft = await fetchArxivFullText(paper.arxivId);
          if (ft) fullTexts.set(paper.arxivId, ft.text);
        } catch { /* non-critical */ }
      }
    }

    const papersWithFullText = papers.map((p) => ({
      ...p,
      fullText: p.arxivId ? fullTexts.get(p.arxivId)?.slice(0, 6000) : undefined,
    }));

    // Build spine context for this node
    const predecessors = spine.edges
      .filter((e) => e.to === node.id)
      .map((e) => {
        const predNode = spine.nodes.find((n) => n.id === e.from);
        return predNode ? { title: predNode.title, context: e.context } : null;
      })
      .filter(Boolean) as Array<{ title: string; context: string }>;

    const successors = spine.edges
      .filter((e) => e.from === node.id)
      .map((e) => {
        const succNode = spine.nodes.find((n) => n.id === e.to);
        return succNode ? { title: succNode.title, context: e.context } : null;
      })
      .filter(Boolean) as Array<{ title: string; context: string }>;

    const era = spine.eras.find((e) => e.nodeIds.includes(node.id));
    const thread = spine.threads.find((t) => t.nodeIds.includes(node.id));

    let document: string;
    try {
      document = await callAzureLLM(
        buildEffortDocumentPrompt(
          node,
          papersWithFullText,
          {
            era: era?.name,
            threadName: thread?.name,
            predecessors,
            successors,
          },
          problemTitle,
        ),
        { tokenCounter, tracker: { module: "spine-efforts", operation: "node-doc" }, timeoutMs: 600_000 },
      );
    } catch (err) {
      emit({ type: "log", message: `Node effort doc failed for "${node.title}": ${err instanceof Error ? err.message : "unknown"}` });
      document = `${node.title}\n\n${node.statement}\n\n${node.significance}`;
    }

    const effortId = reserveEffortId(slugify(node.title));
    spineToEffort.set(node.id, effortId);
    efforts.push({
      id: effortId,
      type: mapNodeTypeToEffortType(node.type),
      title: node.title,
      description: node.significance,
      status: mapNodeTypeToStatus(node.type),
      subject: node.statement.slice(0, 200),
      sources: papers.map(paperToResource),
      document,
      tags: buildNodeTags(node, thread),
      difficultyEstimate: estimateNodeDifficulty(node),
      year: node.year,
      era: era?.name,
      spineNodeId: node.id,
      spineThreadId: thread?.id,
      abstract: node.significance,
      formalStatement: node.statement,
      narrativeRole: mapNodeTypeToNarrativeRole(node.type),
      deadEndReason: node.type === "dead_end" ? node.significance : undefined,
    });

    emit({ type: "effort_created", effortId, title: node.title, fromSpineNode: node.id });
  }

  // ── 3. Spine Edges → Effort Relations (direct mapping) ──
  // H4: `spineToEffort` was populated authoritatively during effort
  // generation above. We use it directly here so collision-suffixed IDs
  // (and thread/node title collisions) resolve correctly.
  for (const edge of spine.edges) {
    const fromEffort = spineToEffort.get(edge.from);
    const toEffort = spineToEffort.get(edge.to);
    if (fromEffort && toEffort && fromEffort !== toEffort) {
      edges.push({
        fromId: fromEffort,
        toId: toEffort,
        relation: mapSpineEdgeToRelation(edge.type),
        description: edge.context,
        confidence: 0.95, // From spine = high confidence
        source: "spine",
      });
    }
  }

  emit({ type: "log", message: `Generated ${efforts.length} efforts, ${edges.length} edges` });
  return { efforts, edges };
}

// ============================================================
//  Helpers
// ============================================================

async function loadPaperMetadata(
  paperIds: string[],
): Promise<Array<{ id: string; title: string; authors: string[]; year?: number; abstract?: string; arxivId?: string; doi?: string; url?: string }>> {
  if (paperIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: paperNodes.id,
      title: paperNodes.title,
      authors: paperNodes.authors,
      year: paperNodes.year,
      abstract: paperNodes.abstract,
      arxivId: paperNodes.arxivId,
      doi: paperNodes.doi,
      url: paperNodes.url,
    })
    .from(paperNodes)
    .where(inArray(paperNodes.id, paperIds));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    authors: r.authors as string[],
    year: r.year ?? undefined,
    abstract: r.abstract ?? undefined,
    arxivId: r.arxivId ?? undefined,
    doi: r.doi ?? undefined,
    url: r.url ?? undefined,
  }));
}

function paperToResource(
  paper: { id: string; title: string; authors: string[]; year?: number; abstract?: string; arxivId?: string; doi?: string; url?: string },
): CrawledResource {
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    sourceType: paper.arxivId ? "arxiv" : paper.doi ? "journal" : "webpage",
    arxivId: paper.arxivId,
    doi: paper.doi,
    url: paper.url ?? (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : ""),
    abstract: paper.abstract,
  };
}

function mapNodeTypeToEffortType(nodeType: SpineNode["type"]): WorkspaceEffortOutput["type"] {
  switch (nodeType) {
    case "milestone": return "PROOF_ATTEMPT";
    case "technique_origin": return "CONSTRUCTION";
    case "refinement": return "ESTIMATE";
    case "barrier": return "REDUCTION";
    case "bridge": return "CONSTRUCTION";
    case "dead_end": return "PROOF_ATTEMPT";
    case "open_direction": return "AUXILIARY";
    case "foundation": return "AUXILIARY";
    default: return "AUXILIARY";
  }
}

function mapNodeTypeToStatus(nodeType: SpineNode["type"]): WorkspaceEffortOutput["status"] {
  switch (nodeType) {
    case "dead_end": return "DEAD_END";
    case "open_direction": return "DRAFT";
    default: return "VERIFIED";
  }
}

function estimateThreadDifficulty(status: string): WorkspaceEffortOutput["difficultyEstimate"] {
  switch (status) {
    case "dead_end":
    case "stalled":
    case "converged":
      return "HARD";
    default:
      return "MODERATE";
  }
}

function estimateNodeDifficulty(node: SpineNode): WorkspaceEffortOutput["difficultyEstimate"] {
  if (node.type === "dead_end" || node.type === "open_direction" || node.type === "barrier") {
    return "VERY_HARD";
  }
  if (
    node.type === "milestone" ||
    node.type === "technique_origin" ||
    node.type === "bridge" ||
    node.type === "refinement"
  ) {
    return node.depth === "incremental" ? "MODERATE" : "HARD";
  }
  return node.depth === "foundational" ? "MODERATE" : "HARD";
}

export function shouldProcessNodeInFullInit(node: SpineNode): boolean {
  if (node.depth !== "incremental") return true;
  return node.type === "dead_end" || node.type === "open_direction";
}

export function shouldGenerateNodeEffort(node: SpineNode): boolean {
  return (
    node.type === "milestone" ||
    node.type === "technique_origin" ||
    node.type === "barrier" ||
    node.type === "bridge" ||
    node.type === "refinement" ||
    node.type === "dead_end" ||
    node.type === "open_direction"
  );
}

export function buildThreadTags(thread: Pick<SpineThread, "name" | "description" | "currentFrontier" | "barrier">): string[] {
  return uniqueTags([
    ...extractTopicTags(`${thread.name} ${thread.description} ${thread.currentFrontier ?? ""} ${thread.barrier ?? ""}`, 5),
    "reference-survey",
  ]);
}

export function buildNodeTags(node: SpineNode, thread: { name: string } | undefined): string[] {
  return uniqueTags([
    ...extractTopicTags(`${node.title} ${node.statement} ${node.significance} ${thread?.name ?? ""}`, 5),
    node.type.replace(/_/g, "-"),
  ]);
}

function uniqueTags(tags: Array<string | undefined>): string[] {
  return [...new Set(tags.map((tag) => tag?.trim()).filter((tag): tag is string => !!tag))];
}

function extractTopicTags(text: string, limit: number): string[] {
  const withoutCitationLead = text.replace(/^[^:]{1,120}:\s*/, "");
  const lower = withoutCitationLead.toLowerCase();
  const tags: string[] = [];
  const phraseRules: Array<[RegExp, string]> = [
    [/lonely\s+runner|lrc\b/, "lonely-runner"],
    [/diophantine/, "diophantine-approximation"],
    [/covering[-\s]+radi/, "covering-radius"],
    [/view[-\s]+obstruction/, "view-obstruction"],
    [/zonotop/, "zonotopal-geometry"],
    [/polyhed/, "polyhedral-geometry"],
    [/lattice/, "lattice-geometry"],
    [/finite[-\s]+check|bounded[-\s]+speed|bounded\s+search/, "finite-checking"],
    [/comput/, "computational-verification"],
    [/false[-\s]+start|claimed\s+proof|proof[-\s]+barrier/, "proof-barriers"],
    [/counterexample/, "counterexamples"],
    [/shifted/, "shifted-variant"],
    [/free[-\s]+start/, "free-starting"],
    [/time[-\s]+to[-\s]+loneliness|one[-\s]+round/, "time-to-loneliness"],
    [/additive[-\s]+combin/, "additive-combinatorics"],
    [/chromatic/, "chromatic-number"],
    [/spectrum|spectra/, "loneliness-spectrum"],
    [/lower[-\s]+bound|universal\s+lower/, "lower-bounds"],
    [/extremal/, "extremal-examples"],
    [/five\s+runners|six\s+runners|eight\s+runners|nine\s+runners|runner\s+counts/, "finite-runner-counts"],
  ];

  for (const [pattern, tag] of phraseRules) {
    if (pattern.test(lower)) tags.push(tag);
  }

  const stopwords = new Set([
    "about", "after", "again", "against", "barrier", "barriers", "bound", "bridges", "case", "claim",
    "claimed", "claims", "conjecture", "covering", "equivalent", "every", "first", "from",
    "gives", "known", "lonely", "method", "model", "paper", "problem", "proof", "proves", "runner",
    "runners", "setting", "shows", "speed", "speeds", "starts", "statement", "studies", "theorem",
    "thread", "using", "verifies",
  ]);
  const normalized = lower.replace(/\\[a-z]+/g, " ").replace(/[^a-z0-9]+/g, " ");
  for (const token of normalized.split(/\s+/)) {
    if (tags.length >= limit) break;
    if (token.length < 5 || stopwords.has(token)) continue;
    tags.push(slugify(token));
  }

  return uniqueTags(tags).slice(0, limit);
}

function mapNodeTypeToNarrativeRole(nodeType: SpineNode["type"]): WorkspaceEffortOutput["narrativeRole"] {
  switch (nodeType) {
    case "foundation": return "background";
    case "milestone": return "core_technique";
    case "technique_origin": return "core_technique";
    case "refinement": return "application";
    case "barrier": return "open_direction";
    case "bridge": return "generalization";
    case "dead_end": return "dead_end";
    case "open_direction": return "open_direction";
    default: return "background";
  }
}

function mapSpineEdgeToRelation(edgeType: SpineEdge["type"]): DependencyEdgeOutput["relation"] {
  switch (edgeType) {
    case "enables": return "depends_on";
    case "improves": return "extends";
    case "generalizes": return "extends";
    case "applies_technique": return "uses";
    case "contradicts": return "contradicts";
    case "reveals_barrier": return "related";
    default: return "related";
  }
}
