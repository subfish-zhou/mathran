/**
 * Plan Agent types — fs/CLI port of mathub's `plan-types.ts`, trimmed to the
 * single / multiple / insufficient statuses.
 *
 * Program mode (ProgramPlan / ProgramSubProject) is DELETED per user directive:
 * no sane mathematician asks an agent to "summarize the Langlands program". The
 * Plan Agent only formalizes a single problem, disambiguates between a small set
 * of candidate problems, or asks for more detail.
 */

/** Math-progress status of a problem (mirrors the SPA "create project" form). */
export type MathStatus = "OPEN" | "PARTIALLY_SOLVED" | "SOLVED" | "DISPUTED";

/**
 * A formalized mathematical problem — the SINGLE-status payload. Ported from
 * mathub `plan-types.ts` (minus the program linkage).
 */
export interface FormalizedProblem {
  /** Canonical human-readable name, e.g. "Binary Goldbach Conjecture". */
  title: string;
  /** LaTeX (or plain) formal statement of the problem. */
  formalStatement: string;
  /** 1-3 paragraph plain-language description. */
  description: string;
  /** Longer background / state-of-the-art summary. */
  background: string;
  /** Topical tags, e.g. ["Analytic Number Theory", "Sieve Theory"]. */
  tags: string[];
  /** MSC2020 classification codes, e.g. ["11P32", "11N35"]. */
  mscCodes?: string[];
  /** Current math-progress status. */
  mathStatus?: MathStatus;
}

/** One disambiguation candidate returned under MULTIPLE status. */
export interface PlanCandidate {
  /** Candidate problem title. */
  title: string;
  /** Short description of what this candidate is. */
  description: string;
  /** Why the user's input could mean this candidate. */
  why?: string;
}

/** A seed reference supplied by the user (arxiv id / doi / url). */
export interface ParsedReference {
  /** Exactly what the user typed. */
  originalInput: string;
  /** Detected kind of reference. */
  type: "arxiv" | "doi" | "url" | "unknown";
  /** True once metadata enrichment succeeded. */
  resolved?: boolean;
  title?: string;
  authors?: string[];
  year?: number;
  url?: string;
  abstract?: string;
  arxivId?: string;
  doi?: string;
}

/** An auto-discovered seed paper suggestion (Task 4). */
export interface SeedSuggestion {
  arxivId: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  /** 1-sentence justification (LLM-provided). */
  why: string;
  /** 0-1 recency heuristic. */
  recencyScore: number;
  /** 0-1, LLM-judged topical fit. */
  topicalFit: number;
}

/** Plan Agent overall classification of the user's input. */
export type PlanAgentStatus = "single" | "multiple" | "insufficient";

/** User-facing input to the Plan Agent. */
export interface PlanAgentInput {
  /** Free-text problem description, e.g. "binary Goldbach". */
  description: string;
  /** Optional reference links (arxiv ids / DOIs / URLs). */
  referenceLinks?: string[];
}

/**
 * Plan Agent result. Exactly one of `problem` / `candidates` / `suggestions`
 * is populated depending on `status`.
 */
export interface PlanAgentResult {
  status: PlanAgentStatus;
  /** SINGLE: the formalized problem. */
  problem?: FormalizedProblem;
  /** MULTIPLE: disambiguation candidates. */
  candidates?: PlanCandidate[];
  /** INSUFFICIENT: follow-up questions / suggestions for the user. */
  suggestions?: string[];
  /** Resolved user-supplied references (may be empty). */
  references: ParsedReference[];
  /**
   * Auto-discovered seed papers (Task 4). Only populated for SINGLE status
   * when the user supplied no reference links.
   */
  suggestedSeeds?: SeedSuggestion[];
  /** Where the result was persisted, if persistence ran. */
  savedTo?: string;
}

/** Lifecycle phases the Plan Agent passes through. */
export type PlanAgentPhase =
  | "parsing"
  | "resolving_references"
  | "analyzing"
  | "formalizing"
  | "seed_discovery"
  | "done"
  | "error";

/** A structured progress event emitted by the Plan Agent (replaces SSE). */
export interface PlanAgentEvent {
  phase: PlanAgentPhase;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Thin LLM call adapter. mathub coupled directly to `callAzureLLM`; mathran is
 * provider-agnostic, so the orchestrator injects a `(prompt) => text` shim over
 * its `LLMProvider`. An optional `system` prompt is sent as a system message.
 */
export type LLMCallFn = (
  prompt: string,
  opts?: { temperature?: number; maxTokens?: number; system?: string },
) => Promise<string>;
