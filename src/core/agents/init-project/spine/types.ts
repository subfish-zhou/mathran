/**
 * Spine-First Architecture — Core Type Definitions (fs port of mathub's
 * `spine/types.ts`).
 *
 * The Narrative Spine is the structural backbone of a research problem:
 *   - Nodes represent milestones, techniques, barriers, open directions
 *   - Edges represent how ideas build on each other
 *   - Threads trace narrative lines through the research landscape
 *   - Eras group nodes into historical periods
 *
 * In mathran (DB-free) the spine is persisted as JSON under
 * `<project>/.mathran/spine/spine.json` (see builder.ts).
 */

// ============================================================
//  Spine Node Types
// ============================================================

export type SpineNodeType =
  | "foundation"
  | "milestone"
  | "technique_origin"
  | "refinement"
  | "barrier"
  | "bridge"
  | "dead_end"
  | "open_direction";

export type SpineEdgeType =
  | "enables"
  | "improves"
  | "generalizes"
  | "applies_technique"
  | "contradicts"
  | "reveals_barrier";

/**
 * Runtime whitelist of {@link SpineEdgeType} values. Used by the spine
 * builder to coerce LLM-returned edge type strings: anything not in this
 * set falls back to the safe default `"enables"` rather than being
 * silently cast to an invalid enum.
 *
 * 2026-06-30 — mathran-bug-scan #6 fix.
 */
export const SPINE_EDGE_TYPES: ReadonlySet<SpineEdgeType> = new Set<SpineEdgeType>([
  "enables",
  "improves",
  "generalizes",
  "applies_technique",
  "contradicts",
  "reveals_barrier",
]);

export function coerceSpineEdgeType(value: unknown): SpineEdgeType {
  if (typeof value === "string" && SPINE_EDGE_TYPES.has(value as SpineEdgeType)) {
    return value as SpineEdgeType;
  }
  return "enables";
}

export type SpineThreadStatus = "active" | "stalled" | "converged" | "dead_end";

export type SpineNodeDepth = "foundational" | "major" | "incremental";

// ============================================================
//  Spine Data Structures
// ============================================================

export interface SpineNode {
  id: string;
  type: SpineNodeType;
  title: string;
  year?: number;
  authors?: string[];
  /** Precise mathematical statement in LaTeX */
  statement: string;
  /** Why this result matters for the problem (2-3 sentences) */
  significance: string;
  /** Core proof idea (1-2 sentences, optional) */
  proofIdea?: string;
  /** Paper node IDs this spine node is derived from */
  paperIds: string[];
  /** Workspace effort IDs linked to this node */
  effortIds: string[];
  depth: SpineNodeDepth;
  /**
   * Set when the node was produced by the shallow-fallback path in
   * buildSpineFromReads (LLM did not return any structured candidates, so
   * we synthesized one incremental-depth node per skim.mainContribution /
   * surveyOutline entry). Downstream filters that normally skip
   * `incremental` nodes treat these as eligible — without that override,
   * a shallow-fallback run would produce a spine but 0 efforts and 0 wiki
   * citations, defeating the fallback's purpose. Caught in dogfood-run-5:
   * 11 nodes, 0 efforts, 0 spine citations in wiki.
   *
   * 2026-06-28 (fix #2 from run-13-audit): widened from boolean to a
   * discriminated string so the report tells "the LLM truly extracted
   * nothing" (parse_error / no_candidates) apart from "the LLM call HTTP-
   * failed and we never got a structured response" (llm_error). Old
   * callers (`if (node.shallowFallback)` etc.) still work because any
   * non-empty string is truthy.
   *
   *   - "llm_error"      — every extraction batch threw (HTTP / network /
   *                        timeout). Run 13 build_spine hit this via a
   *                        single Copilot HTTP 502.
   *   - "parse_error"    — at least one batch returned a non-empty reply
   *                        but extractSpineJSON returned null on all of
   *                        them. Includes mid-JSON truncation.
   *   - "no_candidates"  — at least one batch parsed cleanly but emitted
   *                        zero candidate nodes (e.g. abstracts-only set).
   */
  shallowFallback?: "llm_error" | "parse_error" | "no_candidates";
}

export interface SpineEdge {
  from: string;
  to: string;
  type: SpineEdgeType;
  context: string;
}

export interface SpineThread {
  id: string;
  name: string;
  description: string;
  nodeIds: string[];
  status: SpineThreadStatus;
  currentFrontier?: string;
  barrier?: string;
}

export interface SpineEra {
  name: string;
  startYear?: number;
  endYear?: number;
  summary: string;
  nodeIds: string[];
}

export interface SpineOpenQuestion {
  title: string;
  statement: string;
  relatedNodeIds: string[];
  barrier: string;
  partialProgress: string;
}

export interface NarrativeSpine {
  version: number;
  updatedAt: string;
  /** One-sentence summary of the problem's core tension */
  globalThesis: string;
  eras: SpineEra[];
  nodes: SpineNode[];
  edges: SpineEdge[];
  threads: SpineThread[];
  openQuestions: SpineOpenQuestion[];
}

// ============================================================
//  Pipeline Events
// ============================================================

export type SpinePipelineEvent =
  | { type: "log"; message: string }
  | { type: "phase_change"; phase: SpinePipelinePhase; message: string }
  | { type: "progress"; percent: number; message?: string }
  | { type: "paper_discovered"; title: string; arxivId?: string; depth: number }
  | { type: "paper_scored"; title: string; score: number }
  | { type: "spine_node_extracted"; nodeId: string; nodeType: SpineNodeType; title: string }
  | { type: "spine_assembled"; nodeCount: number; edgeCount: number; threadCount: number }
  | { type: "effort_created"; effortId: string; title: string; fromSpineNode?: string }
  | { type: "wiki_page_start"; slug: string; title: string }
  | { type: "wiki_page_complete"; slug: string }
  | { type: "checkpoint"; phase: string; data: Record<string, unknown> }
  | { type: "error"; message: string };

export type SpinePipelinePhase =
  | "explore"
  | "build_spine"
  | "build_efforts"
  | "generate_wiki"
  | "review_verify"
  | "completed"
  | "error";

/** Diff between two spine versions (for patrol incremental updates) */
export interface SpineDiff {
  newNodes: SpineNode[];
  removedNodeIds: string[];
  updatedNodes: Array<{ id: string; changes: Partial<SpineNode> }>;
  newEdges: SpineEdge[];
  removedEdgeKeys: string[];
  updatedThreads: SpineThread[];
  newThreads: SpineThread[];
  newOpenQuestions: SpineOpenQuestion[];
  affectedWikiSlugs: string[];
}

// ============================================================
//  Explore Pipeline Types
// ============================================================

export interface ExploreConfig {
  projectDir: string;
  workspace: string;
  /** Seed paper node IDs to start exploration from */
  seeds: string[];
  /** Keywords for arXiv search (supplements citation-graph BFS) */
  keywords: string[];
  mode: "deep" | "incremental";
  /** Max BFS depth from seeds */
  maxDepth: number;
  /** Max total papers to explore */
  maxPapers: number;
  /** Papers already known (skip during dedup) */
  knownPaperIds?: Set<string>;
  /** Problem context for LLM relevance scoring. */
  problem?: { title: string; formalStatement: string; tags: string[] };
}

export interface ExploreResult {
  discoveredPaperIds: string[];
  relevantPaperIds: string[];
  totalRounds: number;
}

// ============================================================
//  Spine Builder Types
// ============================================================

export interface SpineNodeCandidate {
  node: Omit<SpineNode, "effortIds">;
  sourcePaperIds: string[];
  suggestedEdges: Array<{
    targetNodeId: string;
    edgeType: SpineEdgeType;
    context: string;
  }>;
}

export interface SpineBuilderConfig {
  projectDir: string;
  workspace: string;
  /** Paper IDs to build spine from */
  paperIds: string[];
  mode: "full" | "incremental";
  existingSpine?: NarrativeSpine;
  problem: {
    title: string;
    formalStatement: string;
    description: string;
    tags: string[];
  };
  /**
   * [Design-Audit D-2b 2026-06-26] Optional abort signal. When
   * provided, the spine builder checks it at the start of each
   * paper-batch iteration so a `POST /:runId/cancel` takes effect
   * within seconds (not minutes) during the build_spine phase.
   */
  signal?: AbortSignal;
}

// ============================================================
//  Effort / Wiki output shapes (fs port — trimmed from init-types.ts)
// ============================================================

export type EffortType =
  | "REFERENCE"
  | "PROOF_ATTEMPT"
  | "CONSTRUCTION"
  | "ESTIMATE"
  | "REDUCTION"
  | "AUXILIARY";

export type EffortStatus = "REFERENCE" | "DEAD_END" | "DRAFT" | "VERIFIED";

export type EffortDifficulty = "MODERATE" | "HARD" | "VERY_HARD";

/**
 * What narrative move this effort makes within the spine.
 *
 * 5.3 (2026-06-28) — Verb-first vocabulary added. The old noun-shaped
 * roles (`background`, `core_technique`, `application`, …) describe
 * what KIND of thing this effort is; the new verb-shaped roles describe
 * what MOVE the underlying paper makes within the field. Wiki / effort
 * docs / threads reading more like a story when each effort can be
 * tagged with a verb-shape.
 *
 * Both noun- and verb-shaped values are accepted (back-compat for any
 * persisted effort.json on disk) but new efforts should prefer the
 * verb-shaped ones when the underlying spine-node `type` maps cleanly
 * to a move:
 *
 *   spine type        → preferred narrativeRole
 *   foundation        → opens_thread          (verb: starts a line)
 *   technique_origin  → opens_thread
 *   milestone         → opens_thread OR refines_constant (depending)
 *   refinement        → refines_constant      (verb: tightens a bound/proof)
 *   bridge            → unifies_approaches    (verb: ties two lines)
 *   barrier           → reveals_barrier       (verb: shows a wall)
 *   dead_end          → closes_thread         (verb: ends a line)
 *   open_direction    → open_direction        (kept; semantically already verby)
 *
 * Free-form strings from older runs/disk are tolerated by downstream
 * consumers; only the prompt-side enum is constrained.
 */
export type EffortNarrativeRole =
  // ── Verb-first (preferred) ──
  | "opens_thread"
  | "refines_constant"
  | "unifies_approaches"
  | "closes_thread"
  | "reveals_barrier"
  | "open_direction"
  // ── Noun-first (back-compat) ──
  | "background"
  | "core_technique"
  | "application"
  | "generalization"
  | "dead_end";

/** A workspace effort generated from a spine node/thread. */
export interface WorkspaceEffortOutput {
  id: string;
  type: EffortType;
  title: string;
  description: string;
  status: EffortStatus;
  subject: string;
  sources: SpineCrawledResource[];
  document: string;
  tags: string[];
  difficultyEstimate: EffortDifficulty;
  year?: number;
  era?: string;
  spineNodeId?: string;
  spineThreadId?: string;
  abstract?: string;
  formalStatement?: string;
  narrativeRole?: EffortNarrativeRole;
  referenceKind?: string;
  deadEndReason?: string;
  includedPaperIds?: string[];
  includedSpineNodeIds?: string[];
}

export interface DependencyEdgeOutput {
  fromId: string;
  toId: string;
  relation: "depends_on" | "extends" | "uses" | "contradicts" | "related";
  description: string;
  confidence: number;
  source: string;
}

export interface WikiPageOutput {
  slug: string;
  title: string;
  content: string;
  workspaceRefs: string[];
  parentSlug?: string;
}

/** Lightweight crawled-resource shape used by effort sources. */
export interface SpineCrawledResource {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  sourceType: "arxiv" | "journal" | "webpage";
  arxivId?: string;
  doi?: string;
  url: string;
  abstract?: string;
}
