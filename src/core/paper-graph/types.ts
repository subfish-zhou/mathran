/**
 * Paper Graph — Public Types (fs-only port of mathub's paper-graph).
 *
 * mathran is DB-free: the paper graph is persisted as JSON node files plus an
 * append-only citations JSONL under `<workspace>/.mathran/paper-graph/`, and
 * project↔paper associations as a JSONL under
 * `<project>/.mathran/papers/associations.jsonl`.
 */

// ── Write-side input shapes ──────────────────────────────────────────────────

export interface PaperNodeInput {
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  url?: string;
  arxivId?: string;
  doi?: string;
  categories?: string[];
  isSurvey?: boolean;
  /**
   * Reserved for a future embedding-based prefilter (PLAN "不在范围"). Stored
   * verbatim when present so the schema is forward-compatible.
   */
  embedding?: number[];
  rigor?: RigorAudit;
  quality?: QualityTier;
  citationCount?: number;
}

export interface ProjectPaperInput {
  paperId: string;
  relevanceScore?: number;
  /** How this paper was discovered (e.g. "seed", "init", "crawl"). */
  discoveredBy?: string;
  /** BFS depth from seed papers. */
  depth?: number;
}

// ── Persisted shapes ─────────────────────────────────────────────────────────

export interface PaperNode {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  url?: string;
  arxivId?: string;
  doi?: string;
  categories?: string[];
  isSurvey: boolean;
  embedding?: number[];
  rigor?: RigorAudit;
  quality?: QualityTier;
  citationCount?: number;            // populated opportunistically when known
  createdAt: string;
  updatedAt: string;
}

export interface PaperCitation {
  citingPaperId: string;
  citedPaperId: string;
  context?: string;
  section?: string;
}

/** A project↔paper association row (one JSONL line). */
export interface PaperAssociation {
  paperId: string;
  relevanceScore?: number;
  discoveredBy: string;
  depth: number;
  isExplored: boolean;
  discoveredAt: string;
}

/** On-disk index snapshot mapping external ids → node id. */
export interface PaperGraphIndex {
  arxiv: Record<string, string>;
  doi: Record<string, string>;
}

// ── Rigor audit verdict from the init-project pipeline. ──────────────
export type RigorVerdict =
  | "trusted"        // passed both coarse + fine, OR exempt (seed/vendored/highly-cited)
  | "warn"           // coarse flagged but fine not yet run, OR fine found minor issues
  | "rejected"       // fine pass confirmed pseudoscience; paper will be hard-deleted
  | "off_topic"      // paper is internally fine but NOT about the target problem; kept but not harvested for citations
  | "skipped";       // OCR-only source or rigor disabled; held with neutral trust

export type QualityTier =
  | "trusted"        // default for normal arxiv papers
  | "seed"           // user explicitly seeded — bypass rigor
  | "vendored"       // present under refs/<dir>/00README.json — bypass rigor
  | "suspect";       // rigor wants to delete but was held by a guard

export interface RigorAudit {
  verdict: RigorVerdict;
  score?: number;                  // 0-10; 10 = airtight; ≤3 = reject
  flags: string[];
  reason?: string;                 // ≤500 chars, human-readable
  pass: "coarse" | "fine";
  checkedAt: string;               // ISO8601
  sourceRead?: "abstract" | "tex" | "pdf" | "ocr";
}

// ── PaperRead: the agent's persistent multi-pass notes on one paper. ──
export interface PaperReadSkim {
  oneLineSummary: string;          // ≤200 chars
  mainContribution: string;        // 2-4 sentences
  sectionOutline: Array<{ level: 1 | 2 | 3; title: string }>;
  decision: "study" | "skim_sufficient" | "discard";
  decisionReason: string;
}

export interface PaperReadMainResult {
  label: string;                   // "Theorem 1.1", "Main Theorem", "Lemma 3.2"
  statement: string;               // verbatim LaTeX, no \cdots truncation
  whereInPaper: string;            // "§3, p. 12"
  noveltyVsPrior: string;          // "Improves on Tao 2012 by..."
}

export interface PaperReadTechnique {
  name: string;                    // "Vaughan identity", "large sieve"
  role: string;                    // "Used to handle Type II sums"
}

export interface PaperReadDependency {
  claim: string;                   // verbatim if short, else faithful paraphrase
  source: string;                  // arxiv id / DOI / author-year
  whereUsed: string;               // "Lemma 2.4 of this paper"
}

export interface PaperReadBody {
  mainResults: PaperReadMainResult[];
  proofStrategy: string;           // 1-3 paragraphs of high-level idea
  keyTechniques: PaperReadTechnique[];
  technicalDependencies: PaperReadDependency[];
  novelContributions: string;
  standardMaterial: string;
  hardSteps: string[];
  role:
    | "milestone"
    | "refinement"
    | "technique_origin"
    | "barrier"
    | "bridge"
    | "survey"
    | "computation"
    | "dead_end"
    | "foundational";
}

export interface PaperReadOutgoingCitation {
  citedTitle?: string;
  citedAuthors?: string[];
  citedYear?: number;
  citedArxivId?: string;
  citedDoi?: string;
  contextInThisPaper: string;
  importanceToThisPaper: "essential" | "supporting" | "passing";
}

/** Survey-specific distillation (only populated for isSurvey=true reads). */
export interface PaperReadSurveyDistillation {
  coveredSubAreas: string[];
  keyReferences: Array<{
    author: string;
    year: number;
    title: string;
    arxivId?: string;
    whyTheSurveyHighlighted: string;
  }>;
  surveyAuthorOpinion?: string;
  surveyOutline?: Array<{ heading: string; summary: string }>;
}

export interface PaperRead {
  paperId: string;
  arxivId?: string;
  doi?: string;
  sourceKind: "tex" | "pdf-text" | "html" | "abstract-only";
  sourceBytes: number;
  sourcePath?: string;
  truncated: boolean;

  skim: PaperReadSkim;
  read?: PaperReadBody;
  audit?: RigorAudit;
  outgoingCitations: PaperReadOutgoingCitation[];

  isSurvey: boolean;
  surveyDistillation?: PaperReadSurveyDistillation;

  modelUsed: string;               // e.g. "anthropic/claude-sonnet-4"
  promptVersion: string;           // bumped when prompt template changes; invalidates cache
  passesCompleted: ("skim" | "read" | "audit")[];
  totalLlmCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  createdAt: string;               // ISO8601
  updatedAt: string;               // ISO8601
}
