/**
 * Frontier Expansion main module.
 *
 * `buildFrontierExpander(deps)` produces an `ExpandFrontierFn` ready to
 * hand to `reading-loop`'s `deps.expandFrontier`. Each call to the
 * returned function = one expansion tick:
 *
 *   1. concept-extract from spine (deterministic, no LLM).
 *   2. arxiv-fetch per concept, deduped against alreadyKnown.
 *   3. LLM relevance filter (ONE batched call).
 *   4. For each KEEP verdict, push into reading-loop queue via deps.pushFn.
 *   5. Track convergence: addedCount, perConcept stats, exhausted flag.
 *
 * Convergence is FIRST-CLASS:
 *   - Per-tick: returns `addedCount` so the caller can detect K-empty.
 *   - Cross-tick (this module's job): tracks total fetches against
 *     FRONTIER_MAX_FETCHES_DEFAULT and flips `exhausted: true` when
 *     hit (downstream reading-loop honors this and stops calling).
 *   - Per-tick local: if every concept returns 0 candidates, the tick
 *     is exhausted (this concept set has nothing new — may pick up
 *     again next tick when spine has grown).
 */

import type { SpineLLM } from "../spine/llm.js";
import type {
  ExpandFrontierFn,
  FrontierCandidate,
  FrontierExpansionInput,
  FrontierExpansionResult,
  FrontierVerdict,
} from "./types.js";
import {
  FRONTIER_MAX_FETCHES_DEFAULT,
  PRIORITY_FRONTIER,
} from "./types.js";
import { extractConcepts } from "./concept-extractor.js";
import { fetchAllConcepts } from "./arxiv-fetcher.js";
import type { FrontierArxivFetcherDeps } from "./arxiv-fetcher.js";
import { filterFrontierCandidates } from "./relevance-filter.js";

export interface BuildFrontierExpanderDeps {
  /** LLM seam for relevance filter. */
  llm: SpineLLM;
  modelName?: string;
  /** Project-level info, needed by concept extractor when spine is null. */
  problemTitle: string;
  problemFormalStatement: string;
  problemTags: string[];
  /** Per-project fetch budget. Default FRONTIER_MAX_FETCHES_DEFAULT. */
  maxTotalFetches?: number;
  /** Arxiv fetcher overrides (mostly for tests). */
  arxivDeps?: FrontierArxivFetcherDeps;
  /** Logger seam. */
  log?: (msg: string) => void;
}

/**
 * Stateful expander factory. Returns an `ExpandFrontierFn` that keeps
 * cross-tick state (totalFetches, exhausted flag, alreadyKnown set).
 *
 * One factory call per reading-loop run — the same expander instance is
 * called multiple times during the run.
 */
export function buildFrontierExpander(deps: BuildFrontierExpanderDeps): ExpandFrontierFn {
  const log = deps.log ?? (() => {});
  const maxFetches = deps.maxTotalFetches ?? FRONTIER_MAX_FETCHES_DEFAULT;

  // Cross-tick state ─────────────────────────────────────────────────────
  let totalFetched = 0;
  let exhausted = false;
  let exhaustionReason: FrontierExpansionResult["exhaustionReason"];
  // The set of arxiv ids we've ever seen (already-known + already-fetched
  // by frontier itself + already-judged). Reading-loop also passes in its
  // own already-known set per tick; we MERGE so the same id is never
  // re-fetched even if it was added to the reading queue and then we
  // somehow saw it again.
  const seenAcrossTicks = new Set<string>();

  return async (input: FrontierExpansionInput): Promise<FrontierExpansionResult> => {
    if (exhausted) {
      return {
        addedCount: 0,
        perConcept: [],
        exhausted: true,
        exhaustionReason,
        kept: [],
      };
    }

    // 1. Concept extraction ────────────────────────────────────────────
    const concepts = extractConcepts({
      spine: input.spine,
      readPapers: input.readPapers,
      readNodesById: input.readNodesById,
      problemTitle: deps.problemTitle,
      problemTags: deps.problemTags,
    });

    if (concepts.length === 0) {
      log(`[frontier] tick: no concepts extracted — nothing to do`);
      exhausted = true;
      exhaustionReason = "no-concepts";
      return { addedCount: 0, perConcept: [], exhausted, exhaustionReason, kept: [] };
    }

    log(`[frontier] tick: ${concepts.length} concept(s): ${concepts.map((c) => c.label).join(" | ")}`);

    // 2. arxiv fetch (deduplicated against alreadyKnown + cross-tick seen)
    const alreadyKnown = new Set<string>(seenAcrossTicks);
    for (const id of input.alreadyQueuedArxivIds) alreadyKnown.add(id);
    for (const id of input.alreadyReadArxivIds) alreadyKnown.add(id);

    const { candidates, perConcept } = await fetchAllConcepts(
      concepts,
      alreadyKnown,
      { ...(deps.arxivDeps ?? {}), log },
    );
    totalFetched += candidates.length;
    // Merge into cross-tick seen so we never re-fetch.
    for (const c of candidates) seenAcrossTicks.add(c.arxivId);

    log(
      `[frontier] tick: fetched ${candidates.length} candidate(s) ` +
        `(total so far: ${totalFetched}/${maxFetches})`,
    );

    // Per-tick local exhaustion: every concept came back empty.
    if (candidates.length === 0) {
      log(`[frontier] tick: 0 candidates — concepts exhausted for now`);
      return {
        addedCount: 0,
        perConcept: perConcept.map((p) => ({ ...p, kept: 0 })),
        exhausted: false, // can be retried next tick after more reads
        kept: [],
      };
    }

    // 3. LLM relevance filter (single batched call) ─────────────────────
    const verdicts = await filterFrontierCandidates(
      {
        problemTitle: deps.problemTitle,
        problemFormalStatement: deps.problemFormalStatement,
        problemTags: deps.problemTags,
        spine: input.spine,
        recentReads: input.readPapers.slice(-15).map((r) => {
          const node = input.readNodesById.get(r.paperId);
          return {
            title: node?.title ?? "(untitled)",
            year: typeof node?.year === "number" ? node.year : 0,
            oneLineSummary: r.skim.oneLineSummary ?? "",
          };
        }),
        candidates,
      },
      { llm: deps.llm, modelName: deps.modelName, log },
    );

    // 4. Collect KEEP candidates ─────────────────────────────────────────
    const candidatesByArxiv = new Map(candidates.map((c) => [c.arxivId, c]));
    const perConceptKept = new Map<string, number>();
    const kept: Array<{ candidate: FrontierCandidate; verdict: FrontierVerdict }> = [];
    for (const v of verdicts) {
      if (v.decision !== "keep") continue;
      const cand = candidatesByArxiv.get(v.arxivId);
      if (!cand) continue;
      kept.push({ candidate: cand, verdict: v });
      perConceptKept.set(cand.fromConcept, (perConceptKept.get(cand.fromConcept) ?? 0) + 1);
    }
    const addedCount = kept.length;

    log(`[frontier] tick: ${addedCount} new paper(s) marked keep (will be pushed at PRIORITY_FRONTIER=${PRIORITY_FRONTIER})`);

    // 5. Budget check ──────────────────────────────────────────────────
    if (totalFetched >= maxFetches) {
      log(`[frontier] tick: fetch budget exhausted (${totalFetched}/${maxFetches})`);
      exhausted = true;
      exhaustionReason = "fetch-budget-exceeded";
    }

    return {
      addedCount,
      perConcept: perConcept.map((p) => ({
        concept: p.concept,
        fetched: p.fetched,
        kept: perConceptKept.get(p.concept) ?? 0,
      })),
      exhausted,
      exhaustionReason,
      kept,
    };
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Re-export the public API surface so callers only need one import.
export type {
  ExpandFrontierFn,
  FrontierCandidate,
  FrontierExpansionInput,
  FrontierExpansionResult,
  FrontierVerdict,
} from "./types.js";
export {
  PRIORITY_FRONTIER,
  FRONTIER_MAX_FETCHES_DEFAULT,
  FRONTIER_K_EMPTY_TO_EXHAUST,
} from "./types.js";
