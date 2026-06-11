export type StatementStatus = "NOT_READY" | "READY" | "FORMALIZED";
export type ProofStatus = "NOT_READY" | "READY" | "FORMALIZED" | "HAS_SORRY";
export type VerificationStatus = "UNFORMALIZED" | "STATED" | "PARTIAL" | "SORRY" | "VERIFIED";

export function computeVerificationStatus(stmt: StatementStatus, proof: ProofStatus): VerificationStatus {
  if (proof === "FORMALIZED") return "VERIFIED";
  if (proof === "HAS_SORRY") return "SORRY";
  if (stmt === "FORMALIZED") return "STATED";
  if (stmt === "READY") return "PARTIAL";
  return "UNFORMALIZED";
}

export interface LeanDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface LeanCheckResult {
  success: boolean;
  errors: LeanDiagnostic[];
  warnings: LeanDiagnostic[];
  sorryCount: number;
  buildDurationMs: number;
}

export interface SyncResult {
  filesWritten: number;
  filesDeleted: number;
  errors: string[];
}

export interface ProjectLeanStatus {
  state: LeanWorkspaceState;
  leanVersion?: string;
  totalEfforts: number;
  formalizedEfforts: number;
  verifiedEfforts: number;
  totalSorryCount: number;
}

export type LeanWorkspaceState =
  | "NOT_INITIALIZED"
  | "INITIALIZING"
  | "READY"
  | "BUILDING"
  | "ERROR";

export interface EffortForLean {
  id: string;
  title: string;
  type: string;
  formalStatement: string | null;
  formalProof?: string;
  leanFilePath?: string | null;
  statementStatus: StatementStatus;
  proofStatus: ProofStatus;
  inMathlib: boolean;
}

export interface EffortWithRelations extends EffortForLean {
  dependencies: Array<{ id: string; title: string; leanFilePath: string | null }>;
}

export interface ParsedDeclaration {
  name: string;
  kind: "theorem" | "lemma" | "def" | "instance" | "structure" | "class" | "axiom" | "abbrev";
  signature: string;
  body: string;
  hasSorry: boolean;
  sorryCount: number;
  line: number;
  file: string;
}

export interface LakefileInfo {
  leanVersion?: string;
  mathlibVersion?: string;
  mathlibGitHash?: string;
}

export interface RepoImportResult {
  effortsCreated: number;
  effortsUpdated: number;
  relationsCreated: number;
  declarationsParsed: number;
  errors: string[];
  lakefileInfo?: LakefileInfo;
}
