// ========== Initialization Agent Types ==========

import type { FormalizedProblem, ParsedReference } from "./plan-types";

// --- Shared Internal Interfaces (used across init-* modules) ---

export interface WorkspaceResult {
  efforts: WorkspaceEffortOutput[];
  edges: DependencyEdgeOutput[];
}

export interface SourceCorpusEntry {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  type: string;
}

// --- Input ---

export interface InitAgentInput {
  /** FormalizedProblem from Plan Agent */
  problem: FormalizedProblem;
  /** Seed references from Plan Agent */
  seedReferences: ParsedReference[];
  /** AI init config */
  aiInit: {
    enableWiki: boolean;
    enableWorkspace: boolean;
    searchDepth: "quick" | "standard" | "deep";
  };
  /** Resume from a previous checkpoint (set by resume API) */
  resumeCheckpoint?: { phase: string; data: Record<string, unknown> };
  /** When set, enables full Spine pipeline with Paper Graph exploration (rebuild mode) */
  projectId?: string;
}

// --- Phases ---

export type InitPhase =
  | "seed_research"
  | "deep_crawl"
  | "build_workspace"
  | "generate_wiki"
  | "review_refine"
  | "verify"
  | "link_review"
  | "completeness_check"
  // Spine-First phases (used when projectId is available)
  | "explore_graph"
  | "build_spine"
  | "build_efforts"
  | "spine_wiki"
  | "completed"
  | "error";

// --- Crawled Resource ---

export interface CrawledResource {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  sourceType: "arxiv" | "journal" | "blog" | "mathoverflow" | "survey" | "webpage";
  arxivId?: string;
  doi?: string;
  url: string;
  abstract?: string;
  /** AI-generated relevance summary */
  relevanceSummary?: string;
  /** arXiv categories e.g. "math.CA" */
  categories?: string[];
  /** URLs to associated code repositories */
  codeUrls?: string[];
  /** URLs to associated datasets */
  datasetUrls?: string[];
  /** Whether this is a survey/review paper */
  isSurvey?: boolean;
}

// --- Narrative Outline (for two-stage wiki generation) ---

export interface NarrativeOutline {
  globalThesis: string;
  pages: Array<{
    slug: string;
    title: string;
    narrativeRole: string;
    coreSections: string[];
    transitionTo?: string;
    keyPoints: string[];
  }>;
}

// --- Citation Entry ---

export interface CitationEntry {
  key: string;
  title: string;
  authors: string[];
  year?: number;
  arxivId?: string;
  url?: string;
  isSurvey?: boolean;
}

// --- Narrative Role for Efforts ---

export type EffortNarrativeRole = "background" | "core_technique" | "application" | "generalization" | "open_direction" | "dead_end" | undefined;

// --- Workspace Effort Output ---

export interface WorkspaceEffortOutput {
  id: string;
  type: "REFERENCE" | "CONSTRUCTION" | "ESTIMATE" | "PROOF_ATTEMPT" | "REDUCTION" | "COMPUTATION" | "FORMALIZATION" | "AUXILIARY" | "DEAD_END";
  title: string;
  description: string;
  status: "VERIFIED" | "DRAFT" | "DEAD_END" | "REFERENCE" | "ERRATUM";
  /** For REFERENCE items — the sources (one per paper in this research direction) */
  sources?: CrawledResource[];
  /** For method/result items — what mathematical object/method this represents */
  subject?: string;
  deadEndReason?: string;
  erratumReason?: string;
  /** Classification: core, method_group, background */
  classification?: "core" | "method_group" | "background";
  /** Rich markdown document with mathematical details */
  document?: string;
  /** Keyword tags */
  tags?: string[];
  /** Difficulty estimate */
  difficultyEstimate?: "ROUTINE" | "MODERATE" | "HARD" | "VERY_HARD";
  /** Year of the result/technique, when known from the spine or source paper */
  year?: number;
  /** Narrative era name from the spine */
  era?: string;
  /** Spine node ID this effort was generated from */
  spineNodeId?: string;
  /** Spine thread ID this effort belongs to or surveys */
  spineThreadId?: string;
  /** Short abstract or source-backed summary */
  abstract?: string;
  /** Precise statement when the effort corresponds to a theorem/result */
  formalStatement?: string;
  /** Narrative role in the wiki story */
  narrativeRole?: EffortNarrativeRole;
  /** REFERENCE effort semantics: single external source vs thread-level survey. */
  referenceKind?: "paper" | "thread_survey" | "source_bundle";
  /** Source paper ids included in a survey/bundle reference effort. */
  includedPaperIds?: string[];
  /** Spine node ids covered by a survey/bundle reference effort. */
  includedSpineNodeIds?: string[];
}

// --- Dependency Edge ---

export interface DependencyEdgeOutput {
  fromId: string;
  toId: string;
  relation: "depends_on" | "extends" | "uses" | "related" | "supersedes" | "contradicts";
  description?: string;
  confidence: number;
  source?: "spine" | "llm" | "user";
}

// --- Verification ---

export type VerificationSeverity = "correct" | "minor" | "major" | "critical";
export type VerificationStatus = "verified" | "unverified" | "incorrect" | "corrected";

export interface VerificationIssue {
  /** Which wiki page this issue belongs to */
  pageSlug: string;
  /** The specific claim text extracted from the wiki */
  claim: string;
  /** Verification status */
  status: VerificationStatus;
  /** Severity of the issue */
  severity: VerificationSeverity;
  /** Explanation of the issue */
  explanation: string;
  /** Source evidence (paper title, abstract excerpt) supporting or contradicting the claim */
  sourceEvidence?: string;
  /** Suggested correction (if status is 'incorrect') */
  suggestedFix?: string;
}

export interface VerificationResult {
  /** Total claims checked */
  totalClaims: number;
  /** Claims verified against sources */
  verified: number;
  /** Claims that could not be verified (no supporting source found) */
  unverified: number;
  /** Claims found to be incorrect */
  incorrect: number;
  /** Claims that were auto-corrected */
  corrected: number;
  /** All issues found */
  issues: VerificationIssue[];
  /** Pages that were corrected (slug → corrected content) */
  correctedPages: string[];
  /** Overall confidence score 0-1 */
  confidenceScore: number;
}

// --- Wiki Page Output ---

export interface WikiPageOutput {
  slug: string;
  title: string;
  content: string;
  /** References used in this page (workspace effort IDs) */
  workspaceRefs: string[];
  /** Parent page slug for sidebar hierarchy */
  parentSlug?: string;
  /** Verification result for this page (populated after verify step) */
  verification?: {
    checkedClaims: number;
    issues: VerificationIssue[];
    confidenceScore: number;
  };
}

// --- Init Result ---

export interface InitAgentResult {
  wikiPages: WikiPageOutput[];
  workspaceEfforts: WorkspaceEffortOutput[];
  dependencyEdges: DependencyEdgeOutput[];
  crawledResources: CrawledResource[];
  /** Verification summary (populated after verify step) */
  verification?: VerificationResult;
  summary: {
    wikiPagesGenerated: number;
    workspaceEffortsCreated: number;
    referencesFound: number;
    depGraphEdges: number;
    totalDurationMs: number;
    /** Number of claims verified */
    claimsVerified?: number;
    /** Number of corrections applied */
    correctionsApplied?: number;
    /** Overall content confidence 0-1 */
    contentConfidence?: number;
  };
}

// --- SSE Events ---

export type InitAgentEvent =
  // Phase transitions
  | { type: "init_phase_change"; phase: InitPhase; message: string }

  // Seed Research
  | { type: "concept_extracted"; concept: string; importance: number }
  | { type: "seed_paper_found"; paper: { title: string; authors: string[]; arxivId?: string; url: string } }
  | { type: "seed_complete"; stats: { concepts: number; papers: number } }

  // Deep Crawl
  | { type: "crawl_round_start"; round: number; queries: string[] }
  | { type: "crawl_query_start"; query: string }
  | { type: "resource_found"; resource: { title: string; sourceType: string; url: string } }
  | { type: "crawl_round_complete"; round: number; newResources: number; totalResources: number }
  | { type: "crawl_converged"; totalResources: number; totalRounds: number }

  // Build Workspace
  | { type: "workspace_effort_created"; effort: { id: string; type: string; title: string; status: string } }
  | { type: "dependency_edge_created"; from: string; to: string; relation: string }
  | { type: "workspace_complete"; stats: { efforts: number; edges: number } }

  // Generate Wiki
  | { type: "wiki_page_start"; slug: string; title: string }
  | { type: "wiki_page_chunk"; slug: string; chunk: string }
  | { type: "wiki_page_complete"; slug: string }
  | { type: "wiki_complete"; stats: { pages: number } }

  // Verify
  | { type: "verify_start"; totalPages: number }
  | { type: "verify_page_start"; slug: string; title: string }
  | { type: "verify_claim_checked"; slug: string; claim: string; status: VerificationStatus; severity: VerificationSeverity; explanation: string }
  | { type: "verify_page_complete"; slug: string; claims: number; issues: number }
  | { type: "verify_correction_start"; slug: string; issueCount: number }
  | { type: "verify_correction_complete"; slug: string; corrected: number }
  | { type: "verify_complete"; result: VerificationResult }

  // Review & Refine
  | { type: "review_page_start"; slug: string; title: string; pageIndex: number; totalPages: number }
  | { type: "review_page_complete"; slug: string; score: number; refined: boolean }

  // Link & Review
  | { type: "link_check_result"; valid: number; broken: number; uncovered: number }
  | { type: "review_complete"; summary: string }

  // Completeness Check
  | { type: "completeness_check_start"; message: string }
  | { type: "completeness_check_result"; passed: boolean; errors: number; warnings: number; summary: string }
  | { type: "completeness_regenerate_start"; slug: string; title: string }

  // Completion
  | { type: "init_completed"; result: InitAgentResult }
  | { type: "init_error"; message: string }
  | { type: "log"; message: string }
  | { type: "run_started"; runId: string }
  | { type: "checkpoint"; phase: string; data: object };
