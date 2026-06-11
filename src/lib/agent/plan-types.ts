// ========== Plan Agent Types ==========

// --- Input ---

export interface PlanAgentInput {
  description: string;                   // Problem description in Markdown format
  referenceLinks: string[];              // Reference link list (URL / arXiv ID / DOI)
  referenceFiles: FileInfo[];            // Reference file info
}

export interface FileInfo {
  name: string;
  size: number;
  type: string;
}

// --- Output ---

export interface ProgramSubProject extends FormalizedProblem {
  role: "core" | "supporting" | "related";
}

export interface ProgramPlan {
  title: string;
  description: string;
  backgroundSummary: string;
  tags: string[];
  subPrograms: ProgramPlan[];  // Nested sub-programs (recursive)
  subProjects: ProgramSubProject[];  // core + supporting + related projects
  dependencies: { from: string; to: string; relation: string; label?: string }[];  // title-based
}

export interface PlanAgentResult {
  status: "single" | "multiple" | "insufficient" | "program";
  confirmedProblem?: FormalizedProblem;
  candidates?: FormalizedProblem[];
  program?: ProgramPlan;
  detectedTopics?: string[];
  suggestions?: string[];
  parsedReferences: ParsedReference[];
}

export interface FormalizedProblem {
  title: string;
  formalStatement: string;              // LaTeX
  description: string;
  backgroundSummary: string;
  tags: string[];
  currentStatus?: string;
  mathStatus?: "OPEN" | "PARTIALLY_SOLVED" | "SOLVED" | "DISPUTED";
  solvedBy?: string;
  solvedYear?: number;
  solvedReference?: string;
  mscCodes?: string[];
}

export interface ParsedReference {
  originalInput: string;
  type: "arxiv" | "doi" | "url" | "unknown";
  resolved: boolean;
  title?: string;
  authors?: string[];
  url?: string;
  abstract?: string;                    // Paper abstract (available from arXiv / DOI resolution)
}

// --- SSE Events ---

export type PlanAgentPhase = "parsing" | "analyzing" | "searching" | "formalizing";

export type PlanAgentEvent =
  | { type: "plan_phase"; phase: PlanAgentPhase }
  | { type: "plan_progress"; message: string }
  | { type: "reference_parsed"; ref: ParsedReference }
  | { type: "file_parsed"; filename: string; summary: string }
  | { type: "concept_detected"; concept: string }
  | { type: "plan_result"; result: PlanAgentResult }
  | { type: "plan_error"; message: string }
  | { type: "log"; message: string };

// --- Project Creation ---

export interface ProjectCreationInput {
  title: string;
  description: string;
  formalStatement: string;
  backgroundSummary: string;
  tags: string[];
  seedReferences: ParsedReference[];
  aiInit: {
    enableWiki: boolean;
    enableWorkspace: boolean;
    searchDepth: "quick" | "standard" | "deep";
  };
}
