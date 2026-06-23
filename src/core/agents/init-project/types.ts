/**
 * Shared types for the init-project agent (fs port of mathub's init-types.ts —
 * trimmed to the v1a 4-phase pipeline).
 */

/** A formalized problem, mirrored from the SPA "create project" form. */
export interface FormalizedProblem {
  title: string;
  formalStatement?: string;
  description?: string;
  backgroundSummary?: string;
  tags?: string[];
  currentStatus?: string;
  mathStatus?: "OPEN" | "PARTIALLY_SOLVED" | "SOLVED" | "DISPUTED";
}

/** A seed reference supplied by the user (arxiv id / doi / url). */
export interface ParsedReference {
  originalInput: string;
  type: "arxiv" | "doi" | "url" | "unknown";
  resolved?: boolean;
  title?: string;
  authors?: string[];
  year?: number;
  url?: string;
  abstract?: string;
  arxivId?: string;
  doi?: string;
}

export interface AiInitConfig {
  enableWiki: boolean;
  enableWorkspace: boolean;
  searchDepth: "quick" | "standard" | "deep";
  /**
   * Opt into the Spine-First pipeline (v1b). When false (default) the v1a
   * 4-phase path runs unchanged.
   */
  useSpine?: boolean;
}

export interface InitAgentInput {
  problem: FormalizedProblem;
  seedReferences: ParsedReference[];
  aiInit: AiInitConfig;
}

/**
 * Agent phases. The v1a path uses seed_research → deep_crawl → build_wiki;
 * the v1b Spine-First path (useSpine=true) uses explore_graph → build_spine →
 * build_efforts → spine_wiki. Both converge on `completed`.
 */
export type InitPhase =
  | "seed_research"
  | "deep_crawl"
  | "build_wiki"
  | "explore_graph"
  | "build_spine"
  | "build_efforts"
  | "spine_wiki"
  | "completed"
  | "error";

export interface CrawledResource {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  sourceType: "arxiv" | "journal" | "blog" | "survey" | "webpage";
  arxivId?: string;
  doi?: string;
  url: string;
  abstract?: string;
  categories?: string[];
  codeUrls?: string[];
  isSurvey?: boolean;
}

export interface InitAgentResult {
  projectSlug: string;
  wikiPages: string[];
  crawledResources: number;
  seedPapers: number;
  /** Set when the Spine-First pipeline ran (useSpine=true). */
  mode?: "v1a" | "spine";
  summary: {
    conceptsExtracted: number;
    queriesRun: number;
    resourcesFound: number;
    wikiPagesGenerated: number;
    durationMs: number;
    /** Spine-First only. */
    spineNodes?: number;
    effortsCreated?: number;
    papersDiscovered?: number;
    papersRelevant?: number;
  };
}
