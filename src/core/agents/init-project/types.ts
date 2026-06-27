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
  /**
   * Opt into the Spine-First pipeline (v1b). When false (default) the v1a
   * 4-phase path runs unchanged.
   */
  useSpine?: boolean;
  /**
   * Writer model for the writer-reviewer dual-model loop (Phase 7).
   * When unset, resolves to `MATHRAN_WRITER_MODEL` or the gpt-5.5 default.
   * @see DESIGN-REFERENCE §6.7
   */
  writerModel?: string;
  /**
   * Reviewer model for the writer-reviewer dual-model loop (Phase 7).
   * When unset, resolves to `MATHRAN_REVIEWER_MODEL` or the opus-4.8 default.
   * @see DESIGN-REFERENCE §6.7
   */
  reviewerModel?: string;
}

export interface InitAgentInput {
  problem: FormalizedProblem;
  seedReferences: ParsedReference[];
  aiInit: AiInitConfig;
  /**
   * Absolute on-disk paths of seed PDFs/files uploaded via `POST /api/uploads`.
   * Stored in the run snapshot for later phases; v1a/v1b do not yet read the
   * file contents (parsing lands in v0.19).
   */
  seedPdfs?: string[];
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
  | "review_refine"
  | "verify"
  | "link_review"
  | "completeness_check"
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

/**
 * Comprehensive run report (Task 38, DESIGN-REFERENCE Phase K) — cost
 * accounting + verdict/revision summary for one init run. Persisted to
 * `<project>/.mathran/agent-runs/<run-id>/report.json` and printed to stdout
 * at the end of init. Read back by `mathran project read-report`.
 */
export interface InitAgentReport {
  runId: string;
  projectSlug: string;
  generatedAt: string;
  writerModel: string;
  reviewerModel: string;
  llmAccounting: {
    writerCallsTotal: number;
    reviewerCallsTotal: number;
    /** skim + read + audit across all PaperReads. */
    readerCallsTotal: number;
    planAgentCalls: number;
    /** best-effort, derived from token counts + a per-model price table. */
    estimatedTotalUsd: number;
    breakdownByPhase: Record<string, { calls: number; estimatedUsd: number }>;
  };
  revisionsSummary: {
    artifactsReviewed: number;
    artifactsApproved: number;
    artifactsFlaggedPersistent: number;
    avgRevisionsPerArtifact: number;
    maxRevisionsAcrossArtifacts: number;
  };
  unresolvedCitations: Array<{ citedTitle: string; whyImportant: string }>;
  convergenceSummary: { reason: string; rounds: number };
  fieldTooLargeTripped: boolean;
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
    pagesRefined?: number;
    pagesFlagged?: number;
    spineCoverage?: number;
  };
  /** Comprehensive run report (Spine-First pipeline only; Task 38). */
  report?: InitAgentReport;
}
