/**
 * LLM-driven relevance filter for frontier candidates.
 *
 * Single batched LLM call per tick (across all concepts' candidates) keeps
 * cost bounded. The LLM is responsible for the hard work:
 *   - Discriminating real math papers from keyword-match noise.
 *   - Rejecting cranks ("Proof of Goldbach by extending negatives").
 *   - De-duplicating against the already-read corpus.
 *   - Suggesting a priority band so essential follow-ups can jump the queue.
 *
 * Failure-isolated: any throw / unparseable JSON / missing verdicts →
 * fall back to "skip everything" (safer than auto-keep, which could push
 * crank papers into the reading queue and waste an LLM read pass).
 */

import { extractSpineJSON } from "../spine/llm.js";
import type { SpineLLM } from "../spine/llm.js";
import type { FrontierCandidate, FrontierVerdict } from "./types.js";
import {
  buildFrontierFilterPrompt,
  FRONTIER_FILTER_PROMPT_VERSION,
} from "./prompts.js";
import type { FrontierFilterPromptInput } from "./prompts.js";

export interface FilterFrontierDeps {
  llm: SpineLLM;
  modelName?: string;
  /** Logger seam. */
  log?: (msg: string) => void;
}

interface RawLLMResponse {
  verdicts?: Array<{
    arxivId?: string;
    decision?: string;
    reason?: string;
    priorityBand?: string;
  }>;
}

/**
 * Run the LLM filter once on a batch of candidates. Returns one verdict
 * per input candidate (in input order). Missing / malformed LLM responses
 * are filled in with "skip" so the caller never has to handle gaps.
 */
export async function filterFrontierCandidates(
  input: FrontierFilterPromptInput,
  deps: FilterFrontierDeps,
): Promise<FrontierVerdict[]> {
  const log = deps.log ?? (() => {});
  const allArxivIds = input.candidates.map((c) => c.arxivId);

  if (input.candidates.length === 0) return [];

  const prompt = buildFrontierFilterPrompt(input);
  let response: string;
  try {
    response = await deps.llm(prompt, { temperature: 0.0, maxTokens: 4000 });
  } catch (err) {
    log(`[frontier] LLM relevance filter failed (skipping all): ${errMsg(err)}`);
    return allArxivIds.map((id) => skipVerdict(id, "LLM call failed"));
  }

  const parsed = extractSpineJSON<RawLLMResponse>(response);
  if (!parsed || !Array.isArray(parsed.verdicts)) {
    log(`[frontier] LLM relevance filter returned unparseable JSON (skipping all)`);
    return allArxivIds.map((id) => skipVerdict(id, "LLM returned invalid JSON"));
  }

  // Index LLM verdicts by arxivId for O(1) lookup. Tolerate the LLM
  // returning verdicts in a different order or omitting some.
  const byId = new Map<string, RawLLMResponse["verdicts"] extends (infer U)[] | undefined ? U : never>();
  for (const v of parsed.verdicts) {
    if (v?.arxivId && typeof v.arxivId === "string") {
      byId.set(v.arxivId, v);
    }
  }

  return allArxivIds.map((id) => {
    const raw = byId.get(id);
    if (!raw) {
      return skipVerdict(id, "LLM omitted this candidate from its response");
    }
    const decision = normalizeDecision(raw.decision);
    if (decision === "skip") {
      return {
        arxivId: id,
        decision: "skip",
        reason: typeof raw.reason === "string" ? raw.reason : "(no reason given)",
      };
    }
    const priorityBand = normalizePriorityBand(raw.priorityBand);
    return {
      arxivId: id,
      decision: "keep",
      reason: typeof raw.reason === "string" ? raw.reason : "(no reason given)",
      priorityBand,
    };
  });
}

export { FRONTIER_FILTER_PROMPT_VERSION };

function skipVerdict(arxivId: string, reason: string): FrontierVerdict {
  return { arxivId, decision: "skip", reason };
}

function normalizeDecision(raw: unknown): "keep" | "skip" {
  if (typeof raw !== "string") return "skip";
  const s = raw.toLowerCase().trim();
  if (s === "keep" || s === "yes" || s === "include") return "keep";
  return "skip";
}

function normalizePriorityBand(raw: unknown): "essential" | "supporting" | "passing" {
  if (typeof raw === "string") {
    const s = raw.toLowerCase().trim();
    if (s === "essential" || s === "high") return "essential";
    if (s === "supporting" || s === "medium") return "supporting";
  }
  return "passing";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
