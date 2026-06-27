/**
 * Pass 3 of 3 — rigor audit.
 *
 * Operates on the DISTILLED `PaperReadBody` (not the raw .tex). We audit the
 * agent's UNDERSTANDING of the paper rather than the paper's prose: a genuine
 * crank surfaces as "no precise theorem statements + sweeping claims + empty
 * technicalDependencies", while an unconventional-but-legit paper surfaces as
 * "precise statements but unusual structure".
 *
 * Never throws — on any LLM / parse failure it returns a neutral
 * `verdict: "warn"` carrying the `llm_error` flag.
 */

import type { PaperNode, PaperReadBody, RigorAudit } from "../../../paper-graph/types.js";
import type { SpineLLM } from "../spine/llm.js";
import { extractSpineJSON, errMsg } from "../spine/llm.js";
import { buildAuditPrompt, AUDIT_PROMPT_VERSION } from "./prompts.js";

export interface AuditDeps {
  llm: SpineLLM;
  emitLog?: (message: string) => void;
}

export interface AuditInput {
  paper: PaperNode;
  /** The distilled read; NOT the raw source. */
  read: PaperReadBody;
  sourceKind: "tex" | "pdf-text" | "html" | "abstract-only";
  problemTitle: string;
}

interface RawAudit {
  verdict?: unknown;
  score?: unknown;
  flags?: unknown;
  reason?: unknown;
}

const VALID_VERDICTS = new Set(["trusted", "warn", "rejected"]);

function clampScore(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(10, Math.round(n)));
}

function normalizeFlags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const f of raw) {
    if (typeof f !== "string") continue;
    const tag = f.trim().slice(0, 60);
    if (tag) out.push(tag);
  }
  return out;
}

/**
 * Map a verdict + score onto the canonical RigorVerdict, reconciling
 * disagreements between the two (e.g. an LLM that says "trusted" with score 2).
 */
function reconcileVerdict(
  verdict: string | undefined,
  score: number | undefined,
): "trusted" | "warn" | "rejected" {
  const v = verdict && VALID_VERDICTS.has(verdict) ? (verdict as "trusted" | "warn" | "rejected") : undefined;
  if (score === undefined) return v ?? "warn";
  // Score is the more objective signal; let it correct an inconsistent label.
  if (score <= 3) return "rejected";
  if (score <= 6) return v === "rejected" ? "warn" : v ?? "warn";
  // score >= 7
  return v === "rejected" ? "warn" : v ?? "trusted";
}

export async function auditPaper(input: AuditInput, deps: AuditDeps): Promise<RigorAudit> {
  const { llm, emitLog } = deps;
  const checkedAt = new Date().toISOString();
  const sourceRead: RigorAudit["sourceRead"] =
    input.sourceKind === "tex"
      ? "tex"
      : input.sourceKind === "pdf-text"
        ? "pdf"
        : input.sourceKind === "abstract-only"
          ? "abstract"
          : "tex";

  let reply: string;
  try {
    const prompt = buildAuditPrompt(input);
    reply = await llm(prompt, { temperature: 0, maxTokens: 1200 });
  } catch (err) {
    emitLog?.(`[audit] LLM call failed: ${errMsg(err)}`);
    return {
      verdict: "warn",
      flags: ["llm_error"],
      reason: `audit LLM call failed: ${errMsg(err)}`.slice(0, 500),
      pass: "fine",
      checkedAt,
      sourceRead,
    };
  }

  const parsed = extractSpineJSON<RawAudit>(reply);
  if (!parsed || typeof parsed !== "object") {
    emitLog?.(`[audit] could not parse audit JSON from LLM reply`);
    return {
      verdict: "warn",
      flags: ["llm_error", "unparseable_audit"],
      reason: "audit reply was not valid JSON",
      pass: "fine",
      checkedAt,
      sourceRead,
    };
  }

  const score = clampScore(parsed.score);
  const verdict = reconcileVerdict(
    typeof parsed.verdict === "string" ? parsed.verdict.trim() : undefined,
    score,
  );
  const flags = normalizeFlags(parsed.flags);
  const reason =
    typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 500) : undefined;

  emitLog?.(
    `[audit] verdict=${verdict} score=${score ?? "?"} flags=[${flags.join(", ")}] (prompt ${AUDIT_PROMPT_VERSION})`,
  );

  return {
    verdict,
    score,
    flags,
    reason,
    pass: "fine",
    checkedAt,
    sourceRead,
  };
}
