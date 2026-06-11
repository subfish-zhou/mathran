/**
 * JSON parsing, validation, and response extraction helpers for the Initialization Agent.
 */

import type {
  WorkspaceEffortOutput,
  VerificationStatus,
  VerificationSeverity,
} from "./init-types";

export function mapVerificationStatus(status: string): VerificationStatus {
  const lower = status.toLowerCase();
  if (lower === "verified") return "verified";
  if (lower === "incorrect") return "incorrect";
  if (lower === "corrected") return "corrected";
  return "unverified";
}

export function mapVerificationSeverity(severity: string): VerificationSeverity {
  const lower = severity.toLowerCase();
  if (lower === "correct") return "correct";
  if (lower === "major") return "major";
  if (lower === "critical") return "critical";
  return "minor";
}

export function mapWorkspaceEffortType(type: string): WorkspaceEffortOutput["type"] {
  // DEAD_END is a STATUS, not a type. If LLM erroneously puts it in the type
  // field, default to PROOF_ATTEMPT (the most common case for dead-end work).
  const valid = ["REFERENCE", "CONSTRUCTION", "ESTIMATE", "PROOF_ATTEMPT", "REDUCTION", "COMPUTATION", "FORMALIZATION", "AUXILIARY"];
  const upper = type.toUpperCase();
  if (upper === "DEAD_END") return "PROOF_ATTEMPT";
  return valid.includes(upper) ? (upper as WorkspaceEffortOutput["type"]) : "CONSTRUCTION";
}

export function mapWSStatus(status: string): WorkspaceEffortOutput["status"] {
  const upper = status.toUpperCase();
  if (upper === "DEAD_END") return "DEAD_END";
  if (upper === "VERIFIED") return "VERIFIED";
  if (upper === "REFERENCE") return "REFERENCE";
  if (upper === "ERRATUM") return "ERRATUM";
  return "DRAFT";
}

export function extractArxivIdFromUrl(url?: string): string | null {
  if (!url) return null;
  // FIX [audit-2 L10] also accept old-style ids (math/0309136) and strip
  // any trailing version suffix (v3) and `.pdf` extension. The previous
  // regex only matched new-style 4-digit-month ids.
  const newStyle = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?/);
  if (newStyle?.[1]) return newStyle[1];
  const oldStyle = url.match(/arxiv\.org\/(?:abs|pdf)\/([a-z\-]+\/\d{7})(?:v\d+)?(?:\.pdf)?/);
  return oldStyle?.[1] ?? null;
}

export function chunkString(str: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += chunkSize) {
    chunks.push(str.slice(i, i + chunkSize));
  }
  return chunks;
}
