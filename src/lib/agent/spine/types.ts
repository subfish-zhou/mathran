/**
 * Spine-First Architecture — Core Type Definitions
 *
 * The Narrative Spine is the structural backbone of a research problem:
 *   - Nodes represent milestones, techniques, barriers, open directions
 *   - Edges represent how ideas build on each other
 *   - Threads trace narrative lines through the research landscape
 *   - Eras group nodes into historical periods
 *
 * Stored as JSONB in projects.narrative_spine.
 */

// ============================================================
//  Spine Node Types
// ============================================================

export type SpineNodeType =
  | "foundation"          // Foundational theory or definition
  | "milestone"           // Major result / theorem
  | "technique_origin"    // First appearance of a key technique
  | "refinement"          // Improvement of an existing result
  | "barrier"             // Known obstruction / impossibility
  | "bridge"              // Result connecting two areas
  | "dead_end"            // Failed approach (educationally valuable)
  | "open_direction";     // Unresolved research direction

export type SpineEdgeType =
  | "enables"             // A is a prerequisite for B
  | "improves"            // B improves A's result
  | "generalizes"         // B generalizes A
  | "applies_technique"   // B applies A's technique to a new setting
  | "contradicts"         // B contradicts/disproves A
  | "reveals_barrier";    // B shows A's method has fundamental limits

export type SpineThreadStatus =
  | "active"              // Actively being pursued
  | "stalled"             // Hit a known barrier
  | "converged"           // Reached current technical limits
  | "dead_end";           // Proven to not work

export type SpineNodeDepth = "foundational" | "major" | "incremental";

// ============================================================
//  Spine Data Structures
// ============================================================

export interface SpineNode {
  id: string;                    // Slugified, e.g., "hardy-1914-zeros-critical-line"
  type: SpineNodeType;
  title: string;                 // e.g., "Hardy (1914): Infinitely many zeros on the critical line"
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
  /** How important is this node? */
  depth: SpineNodeDepth;
}

export interface SpineEdge {
  from: string;                  // Spine node ID
  to: string;                    // Spine node ID
  type: SpineEdgeType;
  /** One sentence explaining the connection */
  context: string;
}

export interface SpineThread {
  id: string;                    // Slugified, e.g., "analytic-number-theory"
  name: string;                  // e.g., "Analytic Number Theory Approach"
  description: string;           // What this line of research pursues
  /** Spine node IDs in chronological order */
  nodeIds: string[];
  status: SpineThreadStatus;
  /** Current best result on this thread (LaTeX) */
  currentFrontier?: string;
  /** What's blocking further progress */
  barrier?: string;
}

export interface SpineEra {
  name: string;                  // e.g., "Classical Period (1859-1950)"
  startYear?: number;
  endYear?: number;
  summary: string;               // What happened in this era
  nodeIds: string[];             // Spine node IDs in this era
}

export interface SpineOpenQuestion {
  title: string;
  /** Precise mathematical statement */
  statement: string;
  /** Related spine node IDs */
  relatedNodeIds: string[];
  /** What's blocking a solution */
  barrier: string;
  /** Known partial results */
  partialProgress: string;
}

export interface NarrativeSpine {
  version: number;               // Incremented on each update
  updatedAt: string;             // ISO timestamp

  /** One-sentence summary of the problem's core tension */
  globalThesis: string;

  /** Historical periods */
  eras: SpineEra[];

  /** Graph structure */
  nodes: SpineNode[];
  edges: SpineEdge[];

  /** Narrative lines through the research landscape */
  threads: SpineThread[];

  /** Open problems and directions */
  openQuestions: SpineOpenQuestion[];
}

// ============================================================
//  Pipeline Types
// ============================================================

/** Unified event type for all spine pipeline phases */
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
  | { type: "wiki_page_chunk"; slug: string; chunk: string }
  | { type: "wiki_page_complete"; slug: string }
  | { type: "checkpoint"; phase: string; data: Record<string, unknown> }
  | { type: "completed"; result: SpinePipelineResult }
  | { type: "error"; message: string };

export type SpinePipelinePhase =
  | "explore"
  | "build_spine"
  | "build_efforts"
  | "generate_wiki"
  | "review_verify"
  | "apply"
  | "completed"
  | "error";

/** Result of a full init or incremental patrol run */
export interface SpinePipelineResult {
  spine: NarrativeSpine;
  papersDiscovered: number;
  papersRelevant: number;
  spineNodesCreated: number;
  effortsCreated: number;
  wikiPagesGenerated: number;
  totalDurationMs: number;
  tokensUsed: number;
}

/** Diff between two spine versions (for patrol incremental updates) */
export interface SpineDiff {
  newNodes: SpineNode[];
  removedNodeIds: string[];
  updatedNodes: Array<{ id: string; changes: Partial<SpineNode> }>;
  newEdges: SpineEdge[];
  removedEdgeKeys: string[];     // "fromId->toId"
  updatedThreads: SpineThread[];
  newThreads: SpineThread[];
  newOpenQuestions: SpineOpenQuestion[];
  affectedWikiSlugs: string[];   // Which wiki pages need regeneration
}

// ============================================================
//  Explore Pipeline Types
// ============================================================

export interface ExploreConfig {
  projectId: string;
  /** Seed paper node IDs to start exploration from */
  seeds: string[];
  /** Keywords for arXiv search (supplements citation-graph BFS) */
  keywords: string[];
  mode: "deep" | "incremental";
  /** Max BFS depth from seeds (deep=4, incremental=2) */
  maxDepth: number;
  /** Max total papers to explore */
  maxPapers: number;
  /** Papers already known (skip during dedup) */
  knownPaperIds?: Set<string>;
  /** Date to look back from (incremental mode) */
  sinceDate?: Date;
  /** Token budget for LLM calls */
  tokenBudget?: number;
}

export interface ExploreResult {
  /** All newly discovered paper node IDs */
  discoveredPaperIds: string[];
  /** Papers that passed relevance threshold */
  relevantPaperIds: string[];
  /** Total rounds of BFS completed */
  totalRounds: number;
}

// ============================================================
//  Spine Builder Types
// ============================================================

export interface SpineNodeCandidate {
  /** Proposed spine node (may be merged/deduplicated later) */
  node: Omit<SpineNode, "effortIds">;
  /** Source paper IDs for this candidate */
  sourcePaperIds: string[];
  /** Suggested edges from/to this candidate */
  suggestedEdges: Array<{
    targetNodeId: string;
    edgeType: SpineEdgeType;
    context: string;
  }>;
}

export interface SpineBuilderConfig {
  projectId: string;
  /** Paper IDs to build spine from */
  paperIds: string[];
  mode: "full" | "incremental";
  /** Existing spine (for incremental mode) */
  existingSpine?: NarrativeSpine;
  /** Problem context */
  problem: {
    title: string;
    formalStatement: string;
    description: string;
    tags: string[];
  };
}
