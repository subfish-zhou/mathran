/**
 * Reader — Read pass, Regime A (whole-paper read).
 *
 * Used by the orchestrator when `source.bytes ≤ 30_000`: the entire source is
 * shown to the LLM in a single call (no truncation). The model returns a
 * `PaperReadBody` with verbatim main-result statements, proof strategy, key
 * techniques, technical dependencies, a novel/standard split, hard steps, and
 * the paper's role in its field.
 *
 * Never throws: on any LLM/parse failure it returns a degenerate-but-valid
 * `PaperReadBody` built from the abstract.
 */

import type {
  PaperNode,
  PaperReadBody,
  PaperReadMainResult,
  PaperReadTechnique,
  PaperReadDependency,
} from "../../../paper-graph/types.js";
import { extractSpineJSON, errMsg, type SpineLLM } from "../spine/llm.js";
import { buildReadRegimeAPrompt } from "./prompts.js";
import type { LoadedSource } from "./source-loader.js";

export interface ReadRegimeDeps {
  llm: SpineLLM;
  emitLog?: (message: string) => void;
  /**
   * Lineage context (层 0) — previously-read papers in this run. Forwarded to
   * the read prompt so the LLM can frame the current paper as a step in the
   * methodological story. Default empty preserves existing behaviour.
   */
  priorReads?: Array<{
    paperId: string;
    title: string;
    firstAuthor: string;
    year?: number;
    oneLineSummary: string;
    mainContribution?: string;
  }>;
}

const READ_ROLES = [
  "milestone",
  "refinement",
  "technique_origin",
  "barrier",
  "bridge",
  "survey",
  "computation",
  "dead_end",
  "foundational",
] as const;

type ReadRole = PaperReadBody["role"];

const ROLE_SET = new Set<string>(READ_ROLES);

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(asString).filter((s) => s.length > 0);
}

function coerceRole(v: unknown): ReadRole {
  const s = asString(v).trim();
  return (ROLE_SET.has(s) ? s : "refinement") as ReadRole;
}

function coerceMainResults(v: unknown): PaperReadMainResult[] {
  if (!Array.isArray(v)) return [];
  const out: PaperReadMainResult[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const statement = asString(o.statement).trim();
    const label = asString(o.label).trim();
    if (!statement && !label) continue;
    out.push({
      label: label || "Main result",
      statement,
      whereInPaper: asString(o.whereInPaper),
      noveltyVsPrior: asString(o.noveltyVsPrior),
    });
  }
  return out;
}

function coerceTechniques(v: unknown): PaperReadTechnique[] {
  if (!Array.isArray(v)) return [];
  const out: PaperReadTechnique[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = asString(o.name).trim();
    if (!name) continue;
    out.push({ name, role: asString(o.role) });
  }
  return out;
}

function coerceDependencies(v: unknown): PaperReadDependency[] {
  if (!Array.isArray(v)) return [];
  const out: PaperReadDependency[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const claim = asString(o.claim).trim();
    if (!claim) continue;
    out.push({
      claim,
      source: asString(o.source),
      whereUsed: asString(o.whereUsed),
    });
  }
  return out;
}

/**
 * Best-effort coercion of an arbitrary parsed JSON value into a `PaperReadBody`.
 * Returns `null` when the value is not an object at all (caller falls back).
 * Note: a returned body MAY have an empty `mainResults` array.
 */
export function coercePaperReadBody(raw: unknown): PaperReadBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    mainResults: coerceMainResults(o.mainResults),
    proofStrategy: asString(o.proofStrategy),
    keyTechniques: coerceTechniques(o.keyTechniques),
    technicalDependencies: coerceDependencies(o.technicalDependencies),
    novelContributions: asString(o.novelContributions),
    standardMaterial: asString(o.standardMaterial),
    hardSteps: asStringArray(o.hardSteps),
    role: coerceRole(o.role),
  };
}

/** One main result paraphrased faithfully from the paper's abstract/title. */
export function abstractMainResult(paper: PaperNode): PaperReadMainResult {
  const text = (paper.abstract ?? "").trim() || paper.title;
  return {
    label: "Main result (from abstract)",
    statement: `<faithful paraphrase> ${text}`,
    whereInPaper: "abstract",
    noveltyVsPrior: "",
  };
}

/**
 * A degenerate-but-valid `PaperReadBody` for when the LLM call fails entirely.
 * Uses the abstract as the single main result and guesses `role: "refinement"`.
 */
export function degeneratePaperReadBody(paper: PaperNode): PaperReadBody {
  return {
    mainResults: [abstractMainResult(paper)],
    proofStrategy: "",
    keyTechniques: [],
    technicalDependencies: [],
    novelContributions: "",
    standardMaterial: "",
    hardSteps: [],
    role: "refinement",
  };
}

/**
 * Ensure a coerced body is non-degenerate: if the model produced no main
 * results, fall back to the abstract-derived main result so downstream passes
 * always have something to cite.
 */
export function ensureMainResults(body: PaperReadBody, paper: PaperNode): PaperReadBody {
  if (body.mainResults.length === 0) {
    return { ...body, mainResults: [abstractMainResult(paper)] };
  }
  return body;
}

const SOURCE_KIND_FOR_REGIME_A: Record<string, "tex" | "pdf-text" | "html"> = {
  tex: "tex",
  "pdf-text": "pdf-text",
  html: "html",
};

/**
 * Whole-paper read. One LLM call sees the entire source. Never throws.
 */
export async function readPaperRegimeA(
  paper: PaperNode,
  source: LoadedSource,
  deps: ReadRegimeDeps,
): Promise<PaperReadBody> {
  const log = deps.emitLog ?? (() => {});
  const sourceKind = SOURCE_KIND_FOR_REGIME_A[source.kind] ?? "tex";
  const prompt = buildReadRegimeAPrompt(paper, source.text, sourceKind, deps.priorReads ?? []);

  let reply: string;
  try {
    reply = await deps.llm(prompt, { temperature: 0.2 });
  } catch (err) {
    log(`[read:A] LLM call failed for "${paper.title}": ${errMsg(err)} — using degenerate body`);
    return degeneratePaperReadBody(paper);
  }

  const raw = extractSpineJSON(reply);
  const body = coercePaperReadBody(raw);
  if (!body) {
    log(`[read:A] could not parse PaperReadBody for "${paper.title}" — using degenerate body`);
    return degeneratePaperReadBody(paper);
  }
  return ensureMainResults(body, paper);
}
