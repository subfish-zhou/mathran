/**
 * Hypothesis-spine builder (Layer 3).
 *
 * buildHypothesisSpine — call ONCE after prior-art discovery, before any
 * reads. Returns EMPTY_HYPOTHESIS_SPINE on failure (LLM throws, garbage,
 * empty validation result).
 *
 * reconcileSpines — call AFTER the real NarrativeSpine is built. Walks
 * every hypothesis node; for each one, marks it verified / refined /
 * falsified / unread based on:
 *   - matchedSpineNodeId: best-match real spine node (title similarity).
 *   - whether ANY of expectedPaperIds appear in the rejected / unresolved
 *     paper sets vs the successfully-read set.
 *
 * Match heuristic: case-insensitive substring (either direction) or
 * Jaccard overlap on title-token bags ≥ 0.5. Cheap, deterministic, good
 * enough for a 4-12-node hypothesis vs a 8-20-node real spine.
 */

import type { CanonicalLandmarkHit } from "../prior-art/canonical-landmarks-search.js";
import type { PriorArtCorpus } from "../prior-art/index.js";
import type { NarrativeSpine, SpineNode } from "../spine/types.js";
import type { SpineLLM } from "../spine/llm.js";
import { extractSpineJSON, errMsg } from "../spine/llm.js";
import {
  buildHypothesisSpinePrompt,
  parseAndValidateHypothesisSpine,
} from "./prompts.js";
import {
  EMPTY_HYPOTHESIS_SPINE,
  type HypothesisSpine,
  type HypothesisSpineNode,
  type HypothesisConfidence,
  type SpineReconciliationSummary,
} from "./types.js";

export interface BuildHypothesisSpineDeps {
  llm: SpineLLM;
  emitLog?: (m: string) => void;
}

export interface BuildHypothesisSpineInput {
  problemTitle: string;
  problemStatement: string;
  problemTags: string[];
  priorArt: PriorArtCorpus | null;
}

export async function buildHypothesisSpine(
  deps: BuildHypothesisSpineDeps,
  input: BuildHypothesisSpineInput,
): Promise<HypothesisSpine> {
  const emit = deps.emitLog ?? (() => {});
  const canon = (input.priorArt?.canonicalLandmarks ?? []) as CanonicalLandmarkHit[];
  const surveys = input.priorArt?.surveys ?? [];
  const canonIds = canon
    .map((c) => (c.arxivId ? `arxiv-${c.arxivId}` : c.doi ? `doi:${c.doi}` : ""))
    .filter((id): id is string => id !== "");
  const surveyIds = surveys.map((s) => s.paperId).filter((id): id is string => typeof id === "string");
  const candidateIds = new Set([...canonIds, ...surveyIds]);

  if (canon.length === 0 && surveys.length === 0) {
    emit(`[hypothesis-spine] no canon or surveys — emitting empty hypothesis`);
    return EMPTY_HYPOTHESIS_SPINE;
  }

  const prompt = buildHypothesisSpinePrompt({
    problemTitle: input.problemTitle,
    problemStatement: input.problemStatement,
    problemTags: input.problemTags,
    canon,
    surveys,
  });

  let raw: string;
  try {
    raw = await deps.llm(prompt, { temperature: 0.2 });
  } catch (err) {
    emit(`[hypothesis-spine] LLM call failed (${errMsg(err)}) — empty hypothesis`);
    return EMPTY_HYPOTHESIS_SPINE;
  }

  const parsed = extractSpineJSON<unknown>(raw);
  const validated = parsed ? parseAndValidateHypothesisSpine(parsed, candidateIds) : null;
  if (!validated) {
    emit(`[hypothesis-spine] unparseable / empty after validation — empty hypothesis`);
    return EMPTY_HYPOTHESIS_SPINE;
  }

  const nodes: HypothesisSpineNode[] = validated.nodes.map((n) => ({
    id: n.id,
    type: n.type as SpineNode["type"],
    title: n.title,
    year: n.year,
    authors: n.authors,
    statement: n.statement,
    significance: n.significance,
    depth: n.depth as SpineNode["depth"],
    expectedPaperIds: n.expectedPaperIds,
    confidence: "hypothesis" as HypothesisConfidence,
  }));

  const hyp: HypothesisSpine = {
    globalThesis: validated.globalThesis,
    nodes,
    eras: validated.eras.map((e) => ({
      name: e.name, startYear: e.startYear, endYear: e.endYear,
      summary: e.summary, nodeIds: e.nodeIds,
    })),
    edges: validated.edges.map((e) => ({
      from: e.from, to: e.to,
      type: e.type as import("../spine/types.js").SpineEdgeType,
      context: e.context,
    })),
    threads: validated.threads.map((t) => ({
      id: t.id, name: t.name, description: t.description, nodeIds: t.nodeIds,
      status: t.status as import("../spine/types.js").SpineThreadStatus,
      currentFrontier: t.currentFrontier, barrier: t.barrier,
    })),
    openQuestions: validated.openQuestions,
    builtAt: new Date().toISOString(),
    builtFrom: { canonIds, surveyPaperIds: surveyIds },
  };
  emit(`[hypothesis-spine] built: ${hyp.nodes.length} node(s), ${hyp.eras.length} era(s), ${hyp.threads.length} thread(s)`);
  return hyp;
}

/** Title-token Jaccard overlap [0, 1]. Lowercase, drop short tokens, ASCII-only. */
function titleJaccard(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3),
    );
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Reduce a paperId to a canonical token so cross-prefix matching works.
 *
 * Pre-fix: Run 13 reconcile matched 0/10 hypothesis nodes because the
 * hypothesis prompt encouraged the LLM to cite canon papers by DOI
 * (`doi:10.1007/bf02403921`) while the reading-loop later ingested the
 * same paper under its arxiv id (`arxiv-math_0209360`). The two id
 * spaces never intersected, so reconcile fell through to title-Jaccard
 * which the LLM's hypothesis titles also missed (different phrasing
 * from the real spine's promoted titles).
 *
 * Normalization rules:
 *   - lowercase
 *   - strip a leading `arxiv-`, `arxiv:`, `arxiv `, `doi:`, `crossref:`
 *   - convert separators `[-:_./ ]` to nothing so `math_0209360` ==
 *     `math/0209360` == `math.0209360` (arxiv old/new identifiers)
 *
 * Returns an empty string for an empty input (caller filters those out).
 */
function normalizePaperId(id: string): string {
  if (!id) return "";
  let s = id.trim().toLowerCase();
  s = s.replace(/^(arxiv[-:\s]|doi:|crossref:)/, "");
  s = s.replace(/[\s\-:_./]/g, "");
  return s;
}

const MATCH_THRESHOLD_TITLE = 0.25;

/**
 * For each hypothesis node, find the best-matching real spine node (or null).
 *
 * Two-stage match (2026-06-28, fix #3 from run-13-audit):
 *   1. PAPER-ID INTERSECTION first. If any of hyp.expectedPaperIds shares a
 *      normalized form with any of realNode.paperIds, that's a direct
 *      grounding signal — much stronger than title proximity. Pick whichever
 *      real node has the largest intersection (ties → first by insertion
 *      order). A single shared id is enough to win against a no-id match.
 *   2. TITLE PROXIMITY fallback. If no paperId intersection exists, fall
 *      back to title substring containment / Jaccard with a lower threshold
 *      (0.25 vs the old 0.5) since real-spine titles are typically more
 *      verbose than hypothesis titles ("Brun's sieve and combinatorial
 *      sieves" vs "Brun sieve" — Jaccard 0.33).
 *
 * Author + year boosts apply in both stages.
 */
function findBestMatch(
  hyp: HypothesisSpineNode,
  realNodes: SpineNode[],
): SpineNode | null {
  // Stage 1: paperId intersection. Normalize once.
  const hypIds = new Set(
    hyp.expectedPaperIds.map(normalizePaperId).filter((s) => s.length > 0),
  );
  if (hypIds.size > 0) {
    let bestByIds: { node: SpineNode; intersection: number; tieBreaker: number } | null = null;
    for (const r of realNodes) {
      let intersection = 0;
      for (const rid of r.paperIds) {
        if (hypIds.has(normalizePaperId(rid))) intersection++;
      }
      if (intersection === 0) continue;
      // Tie-break with title jaccard then year-match so a 1-id tie prefers
      // the realNode whose title also looks like the hypothesis.
      const tieBreaker =
        titleJaccard(hyp.title, r.title) + (hyp.year != null && r.year === hyp.year ? 0.1 : 0);
      if (
        bestByIds == null ||
        intersection > bestByIds.intersection ||
        (intersection === bestByIds.intersection && tieBreaker > bestByIds.tieBreaker)
      ) {
        bestByIds = { node: r, intersection, tieBreaker };
      }
    }
    if (bestByIds) return bestByIds.node;
  }

  // Stage 2: title proximity (substring containment OR Jaccard ≥ threshold).
  let best: { node: SpineNode; score: number } | null = null;
  for (const r of realNodes) {
    let score = 0;
    const aLow = hyp.title.toLowerCase();
    const bLow = r.title.toLowerCase();
    if (aLow.includes(bLow) || bLow.includes(aLow)) {
      score = Math.max(score, 0.75);
    }
    score = Math.max(score, titleJaccard(hyp.title, r.title));
    if (hyp.year != null && r.year === hyp.year) score += 0.1;
    if (best == null || score > best.score) best = { node: r, score };
  }
  return best && best.score >= MATCH_THRESHOLD_TITLE ? best.node : null;
}

export interface ReconcileSpinesInput {
  hypothesis: HypothesisSpine;
  realSpine: NarrativeSpine;
  /** Paper-graph ids that were successfully read (not rejected). */
  readPaperIds: Set<string>;
  /** Paper-graph ids that were rejected by the audit pass. */
  rejectedPaperIds: Set<string>;
}

export function reconcileSpines(input: ReconcileSpinesInput): {
  reconciled: HypothesisSpine;
  summary: SpineReconciliationSummary;
} {
  const updated: HypothesisSpineNode[] = [];
  const summary: SpineReconciliationSummary = {
    totalHypothesisNodes: input.hypothesis.nodes.length,
    verified: 0,
    refined: 0,
    falsified: 0,
    unread: 0,
    details: [],
  };

  for (const hyp of input.hypothesis.nodes) {
    const match = findBestMatch(hyp, input.realSpine.nodes);
    let confidence: HypothesisConfidence;
    let note = "";
    const expectedRead = hyp.expectedPaperIds.filter((p) => input.readPaperIds.has(p));
    const expectedRejected = hyp.expectedPaperIds.filter((p) => input.rejectedPaperIds.has(p));

    if (!match) {
      if (hyp.expectedPaperIds.length === 0) {
        // Speculative node with no expected grounding — call it falsified
        // since the real spine didn't pick it up either.
        confidence = "falsified";
        note = "No real spine node matched, and the hypothesis had no expectedPaperIds to verify.";
      } else if (expectedRead.length === 0 && expectedRejected.length === 0) {
        confidence = "unread";
        note = `Expected papers were not read (${hyp.expectedPaperIds.length} expected, 0 reached).`;
      } else {
        confidence = "falsified";
        note = `Expected papers were read (${expectedRead.length}/${hyp.expectedPaperIds.length}) but the spine builder did NOT promote this hypothesis to a real node.`;
      }
    } else {
      // Statement-similarity check decides verified vs refined.
      // If real statement substring-contains the hypothesis OR vice versa,
      // call it verified. Otherwise refined.
      const aLow = hyp.statement.toLowerCase().slice(0, 200);
      const bLow = match.statement.toLowerCase().slice(0, 200);
      const closelyAligned =
        aLow.length > 20 && bLow.length > 20 && (aLow.includes(bLow) || bLow.includes(aLow));
      if (closelyAligned) {
        confidence = "verified";
        note = `Matched real spine node "${match.id}"; statement substantively unchanged.`;
      } else {
        confidence = "refined";
        note = `Matched real spine node "${match.id}"; statement was sharpened during read+spine assembly.`;
      }
    }

    updated.push({
      ...hyp,
      confidence,
      matchedSpineNodeId: match?.id,
      reconcileNote: note,
    });
    summary.details.push({
      hypothesisId: hyp.id,
      hypothesisTitle: hyp.title,
      confidence,
      matchedSpineNodeId: match?.id,
      note,
    });
    if (confidence === "verified") summary.verified++;
    else if (confidence === "refined") summary.refined++;
    else if (confidence === "falsified") summary.falsified++;
    else if (confidence === "unread") summary.unread++;
  }

  return {
    reconciled: { ...input.hypothesis, nodes: updated },
    summary,
  };
}
