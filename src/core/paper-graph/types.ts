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
