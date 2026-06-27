/**
 * Plan Agent response parsing — port of mathub's `parseLLMResponse` and
 * `mapToFormalizedProblem`, restricted to the single / multiple / insufficient
 * branches. The Program branch (`mapToProgramPlan`) is deleted.
 *
 * Robustness goals carried over from mathub:
 *   - tolerate ```json fences and trailing prose around the JSON object;
 *   - accept both camelCase and snake_case keys;
 *   - handle the legacy quirk where `math_status` (and other single-problem
 *     fields) live at the TOP LEVEL of the response rather than under a nested
 *     `problem` object.
 */

import { extractSpineJSON } from "../init-project/spine/llm.js";
import type {
  FormalizedProblem,
  MathStatus,
  PlanCandidate,
  PlanAgentStatus,
} from "./types.js";

/** Normalized parse of a Plan Agent LLM reply. */
export interface ParsedPlanResponse {
  status: PlanAgentStatus;
  problem?: FormalizedProblem;
  candidates?: PlanCandidate[];
  suggestions?: string[];
}

type Raw = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => (typeof x === "string" ? x : String(x))).filter((s) => s.length > 0);
  return out.length > 0 ? out : undefined;
}

/** Pull the first present value among several candidate keys. */
function pick(obj: Raw, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function normalizeMathStatus(v: unknown): MathStatus | undefined {
  const s = asString(v);
  if (!s) return undefined;
  const up = s.toUpperCase().replace(/[\s-]+/g, "_");
  if (up === "OPEN" || up === "PARTIALLY_SOLVED" || up === "SOLVED" || up === "DISPUTED") {
    return up;
  }
  if (up === "PARTIAL" || up === "PARTIALLY") return "PARTIALLY_SOLVED";
  return undefined;
}

/**
 * Map a raw object into a `FormalizedProblem`. The source object may be the
 * nested `problem` sub-object OR the whole response (legacy flat layout). For
 * each field we look in `nested` first, then fall back to the top-level `root`
 * — this is what lets a top-level `math_status` (mathub's quirk) be picked up.
 */
export function mapToFormalizedProblem(nested: Raw, root: Raw = nested): FormalizedProblem {
  const title =
    asString(pick(nested, "title", "name")) ??
    asString(pick(root, "title", "name")) ??
    "Untitled Problem";

  const formalStatement =
    asString(pick(nested, "formalStatement", "formal_statement", "statement")) ??
    asString(pick(root, "formalStatement", "formal_statement", "statement")) ??
    "";

  const description =
    asString(pick(nested, "description", "summary")) ??
    asString(pick(root, "description", "summary")) ??
    "";

  const background =
    asString(
      pick(nested, "background", "backgroundSummary", "background_summary"),
    ) ??
    asString(pick(root, "background", "backgroundSummary", "background_summary")) ??
    "";

  const tags =
    asStringArray(pick(nested, "tags")) ?? asStringArray(pick(root, "tags")) ?? [];

  const mscCodes =
    asStringArray(pick(nested, "mscCodes", "msc_codes", "msc")) ??
    asStringArray(pick(root, "mscCodes", "msc_codes", "msc"));

  const mathStatus =
    normalizeMathStatus(pick(nested, "mathStatus", "math_status")) ??
    normalizeMathStatus(pick(root, "mathStatus", "math_status"));

  const problem: FormalizedProblem = {
    title,
    formalStatement,
    description,
    background,
    tags,
  };
  if (mscCodes) problem.mscCodes = mscCodes;
  if (mathStatus) problem.mathStatus = mathStatus;
  return problem;
}

function mapCandidates(v: unknown): PlanCandidate[] {
  if (!Array.isArray(v)) return [];
  const out: PlanCandidate[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      out.push({ title: item, description: "" });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Raw;
      const title = asString(pick(o, "title", "name"));
      if (!title) continue;
      const candidate: PlanCandidate = {
        title,
        description: asString(pick(o, "description", "summary")) ?? "",
      };
      const why = asString(pick(o, "why", "reason", "rationale"));
      if (why) candidate.why = why;
      out.push(candidate);
    }
  }
  return out;
}

function normalizeStatus(v: unknown): PlanAgentStatus | undefined {
  const s = asString(v);
  if (!s) return undefined;
  const low = s.toLowerCase();
  if (low === "single") return "single";
  if (low === "multiple") return "multiple";
  if (low === "insufficient") return "insufficient";
  // Program mode is deleted — route any leftover "program" status to
  // insufficient so a stale prompt can never crash the pipeline.
  if (low === "program") return "insufficient";
  return undefined;
}

/**
 * Parse a raw LLM reply into a `ParsedPlanResponse`. Throws if no JSON object
 * can be extracted or the status is unrecognized — callers treat that as a
 * formalization failure.
 */
export function parseLLMResponse(text: string): ParsedPlanResponse {
  const raw = extractSpineJSON<Raw>(text);
  if (!raw || typeof raw !== "object") {
    throw new Error("Plan Agent: could not extract JSON from LLM response");
  }

  const status = normalizeStatus(pick(raw, "status"));
  if (!status) {
    throw new Error(
      `Plan Agent: unrecognized status in LLM response: ${JSON.stringify(pick(raw, "status"))}`,
    );
  }

  if (status === "single") {
    const nested = raw.problem && typeof raw.problem === "object" ? (raw.problem as Raw) : raw;
    return { status, problem: mapToFormalizedProblem(nested, raw) };
  }

  if (status === "multiple") {
    const candidates = mapCandidates(pick(raw, "candidates", "options", "problems"));
    return { status, candidates };
  }

  // insufficient
  const suggestions =
    asStringArray(pick(raw, "suggestions", "questions", "followUps", "follow_ups")) ?? [];
  return { status, suggestions };
}
