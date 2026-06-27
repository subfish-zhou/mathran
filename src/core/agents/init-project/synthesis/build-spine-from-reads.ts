/**
 * Build a Narrative Spine from a corpus of PaperReads (v3 synthesis path).
 *
 * This replaces the legacy raw-`.tex` spine builder (which truncated main
 * statements at 60 KB and could lose `\cdots`-style content). Here the agent's
 * own multi-pass PaperRead distillations are the input, so every main result is
 * available verbatim.
 *
 * Crucial property: `SpineNode.statement` is populated VERBATIM from
 * `PaperRead.read.mainResults[i].statement` — never paraphrased or truncated by
 * the spine LLM. The extraction prompt asks the model to echo the source
 * paper-id + result label for each node; this module then splices the verbatim
 * statement back in from the read corpus, so a hallucinated or mangled statement
 * in the LLM reply is overwritten by the trusted source string.
 *
 * Surveys (when ≥1 high-confidence survey is present in `priorArt`) contribute a
 * STRUCTURAL PRIOR: their captured `surveyOutline` headings are fed to the
 * assembly prompt as "consider these organizations from existing surveys"
 * (DESIGN-REFERENCE §7.2).
 */

import { slugify } from "../../../../lib/slug.js";
import {
  buildSpineNodeExtractionFromReadsPrompt,
  buildSpineAssemblyFromReadsPrompt,
} from "../spine/prompts.js";
import { extractSpineJSON, errMsg, type SpineLLM } from "../spine/llm.js";
import type {
  NarrativeSpine,
  SpineNode,
  SpineEdge,
  SpineThread,
  SpineEra,
  SpineOpenQuestion,
} from "../spine/types.js";
import type { PaperRead, PaperNode } from "../../../paper-graph/types.js";
import type { PriorArtCorpus } from "../prior-art/index.js";

// ── Public API ───────────────────────────────────────────────────────────────

export interface BuildSpineFromReadsInput {
  problem: {
    title: string;
    formalStatement: string;
    description: string;
    tags: string[];
    mathStatus?: string;
  };
  reads: PaperRead[];
  /** For metadata lookups (citation count, etc.). */
  paperNodes: PaperNode[];
  /** For structural prior (§7.2). May be null. */
  priorArt: PriorArtCorpus | null;
}

export interface BuildSpineFromReadsDeps {
  llm: SpineLLM;
  emitLog?: (message: string) => void;
}

/** Batch size for node-extraction LLM calls (≤25 papers per call). */
const NODE_EXTRACTION_BATCH = 25;

/** Minimum confidence for a survey to count as a structural prior. */
const SURVEY_PRIOR_MIN_CONFIDENCE = 0.6;

const NODE_TYPES = new Set<SpineNode["type"]>([
  "foundation", "milestone", "technique_origin", "refinement",
  "barrier", "bridge", "dead_end", "open_direction",
]);
const NODE_DEPTHS = new Set<SpineNode["depth"]>(["foundational", "major", "incremental"]);
const EDGE_TYPES = new Set<SpineEdge["type"]>([
  "enables", "improves", "generalizes", "applies_technique", "contradicts", "reveals_barrier",
]);
const THREAD_STATUSES = new Set<SpineThread["status"]>(["active", "stalled", "converged", "dead_end"]);

/**
 * Synthesize a NarrativeSpine from a corpus of PaperReads.
 *
 * See module docstring for the verbatim-statement guarantee.
 */
export async function buildSpineFromReads(
  input: BuildSpineFromReadsInput,
  deps: BuildSpineFromReadsDeps,
): Promise<NarrativeSpine> {
  const log = deps.emitLog ?? (() => {});

  // ── 1. Pre-filter reads (defensive) ──
  const usableReads = input.reads.filter((r) => {
    if (r.audit?.verdict === "rejected") return false;
    if (r.skim?.decision === "discard") return false;
    return true;
  });
  log(`Building spine from ${usableReads.length}/${input.reads.length} usable PaperReads`);

  if (usableReads.length === 0) {
    return emptySpine(input.problem.title);
  }

  // Index every verbatim main-result statement so we can splice it back in,
  // regardless of what the LLM echoes in its reply.
  const statementIndex = buildStatementIndex(usableReads);

  // ── 2. Bucket by role (informational / ordering aid) ──
  const byRole = bucketByRole(usableReads);
  log(
    `Roles: ${[...byRole.entries()].map(([role, rs]) => `${role}=${rs.length}`).join(", ") || "(none)"}`,
  );

  // ── 3a. Node extraction (batched if > NODE_EXTRACTION_BATCH papers) ──
  const candidates: ExtractedCandidate[] = [];
  const batches = chunk(usableReads, NODE_EXTRACTION_BATCH);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    log(`Node extraction batch ${i + 1}/${batches.length} (${batch.length} papers)`);
    const prompt = buildSpineNodeExtractionFromReadsPrompt(
      {
        title: input.problem.title,
        formalStatement: input.problem.formalStatement,
        mathStatus: input.problem.mathStatus,
      },
      batch,
    );
    try {
      const raw = await deps.llm(prompt, { temperature: 0.2, maxTokens: 6000 });
      const parsed = extractSpineJSON<{ nodes?: Array<Record<string, unknown>> }>(raw);
      if (parsed && Array.isArray(parsed.nodes)) {
        for (const rawNode of parsed.nodes) {
          candidates.push(coerceCandidate(rawNode, candidates.length, statementIndex));
        }
      }
    } catch (err) {
      log(`Node extraction batch ${i + 1} failed: ${errMsg(err)}`);
    }
  }

  if (candidates.length === 0) {
    // Issue #3 from dogfood-run-2-report: with only abstract-only / weak reads,
    // mainResults is often empty so the LLM extracts no candidate nodes and the
    // spine is empty — wiki then gets 0 effort docs to cite. Fall back to a
    // SHALLOW spine derived from `skim.mainContribution` and
    // `surveyDistillation.surveyOutline` so downstream synthesis has something
    // to point at. These nodes are explicitly marked depth: "incremental" so
    // callers can tell the spine is thin.
    log("LLM extraction produced 0 candidates — falling back to skim/survey-derived nodes");
    candidates.push(...synthesizeShallowCandidatesFromReads(usableReads));
    if (candidates.length === 0) {
      log("Fallback also produced 0 candidates — returning empty spine");
      return emptySpine(input.problem.title);
    }
    log(`Shallow fallback added ${candidates.length} candidate node(s)`);
  }

  // De-duplicate candidate ids (keep first, merge paperIds/edges).
  const dedupedCandidates = dedupeCandidatesById(candidates);
  const nodeIds = new Set(dedupedCandidates.map((c) => c.node.id));

  // ── 3b. Structure assembly ──
  const surveyPriors = buildSurveyStructuralPriors(input.priorArt, usableReads);
  if (surveyPriors.length > 0) {
    log(`Using ${surveyPriors.length} survey structural prior(s)`);
  }

  const assemblyPrompt = buildSpineAssemblyFromReadsPrompt(
    { title: input.problem.title, formalStatement: input.problem.formalStatement },
    dedupedCandidates.map((c) => ({
      id: c.node.id,
      title: c.node.title,
      year: c.node.year,
      type: c.node.type,
      depth: c.node.depth,
    })),
    surveyPriors,
  );

  let assembly: Record<string, unknown> = {};
  try {
    const raw = await deps.llm(assemblyPrompt, { temperature: 0.3, maxTokens: 6000 });
    assembly = extractSpineJSON<Record<string, unknown>>(raw) ?? {};
  } catch (err) {
    log(`Spine assembly failed: ${errMsg(err)}`);
  }

  // ── 4. Materialize the spine ──
  const nodes: SpineNode[] = dedupedCandidates.map((c) => ({ ...c.node, effortIds: [] }));

  const eras: SpineEra[] = asArray(assembly.eras).map((e) => ({
    name: String(e.name ?? ""),
    startYear: typeof e.start_year === "number" ? e.start_year : undefined,
    endYear: typeof e.end_year === "number" ? e.end_year : undefined,
    summary: String(e.summary ?? ""),
    nodeIds: asArray(e.node_ids).map(String).filter((id) => nodeIds.has(id)),
  }));

  const edges: SpineEdge[] = asArray(assembly.edges)
    .map((e) => ({
      from: String(e.from ?? ""),
      to: String(e.to ?? ""),
      type: EDGE_TYPES.has(e.type as SpineEdge["type"]) ? (e.type as SpineEdge["type"]) : "enables",
      context: String(e.context ?? ""),
    }))
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to);

  // Fold in per-node suggested edges that the assembly call may have omitted.
  for (const c of dedupedCandidates) {
    for (const se of c.suggestedEdges) {
      if (
        nodeIds.has(se.targetNodeId) &&
        se.targetNodeId !== c.node.id &&
        !edges.some(
          (e) =>
            (e.from === c.node.id && e.to === se.targetNodeId) ||
            (e.from === se.targetNodeId && e.to === c.node.id),
        )
      ) {
        edges.push({
          from: c.node.id,
          to: se.targetNodeId,
          type: se.edgeType,
          context: se.context,
        });
      }
    }
  }

  const threads: SpineThread[] = asArray(assembly.threads).map((t) => ({
    id: slugify(String(t.id ?? t.name ?? ""), "thread"),
    name: String(t.name ?? ""),
    description: String(t.description ?? ""),
    nodeIds: asArray(t.node_ids).map(String).filter((id) => nodeIds.has(id)),
    status: THREAD_STATUSES.has(t.status as SpineThread["status"])
      ? (t.status as SpineThread["status"])
      : "active",
    currentFrontier: t.current_frontier ? String(t.current_frontier) : undefined,
    barrier: t.barrier ? String(t.barrier) : undefined,
  }));

  const openQuestions: SpineOpenQuestion[] = asArray(assembly.open_questions).map((q) => ({
    title: String(q.title ?? ""),
    statement: String(q.statement ?? ""),
    relatedNodeIds: asArray(q.related_node_ids).map(String).filter((id) => nodeIds.has(id)),
    barrier: String(q.barrier ?? ""),
    partialProgress: String(q.partial_progress ?? ""),
  }));

  const spine: NarrativeSpine = {
    version: 1,
    updatedAt: new Date().toISOString(),
    globalThesis: String(assembly.global_thesis ?? `Research landscape for ${input.problem.title}`),
    eras,
    nodes,
    edges,
    threads,
    openQuestions,
  };

  // Ensure every node is reachable from at least one era (so downstream
  // wiki/effort generators never drop a node on the floor).
  attachOrphanNodesToEras(spine);

  log(
    `Spine assembled: ${spine.nodes.length} nodes, ${spine.edges.length} edges, ${spine.threads.length} threads`,
  );
  return spine;
}

// ── Verbatim-statement index ────────────────────────────────────────────────

interface StatementIndex {
  /** key `${paperId}::${label}` → verbatim statement. */
  byPaperAndLabel: Map<string, string>;
  /** paperId → first main-result statement (fallback). */
  firstByPaper: Map<string, string>;
}

function buildStatementIndex(reads: PaperRead[]): StatementIndex {
  const byPaperAndLabel = new Map<string, string>();
  const firstByPaper = new Map<string, string>();
  for (const r of reads) {
    const results = r.read?.mainResults ?? [];
    results.forEach((m, i) => {
      byPaperAndLabel.set(`${r.paperId}::${m.label}`, m.statement);
      if (i === 0) firstByPaper.set(r.paperId, m.statement);
    });
  }
  return { byPaperAndLabel, firstByPaper };
}

/**
 * Resolve the VERBATIM statement for a candidate node from the read corpus.
 * Falls back to the LLM-provided statement only when no source can be matched.
 */
function resolveVerbatimStatement(
  rawNode: Record<string, unknown>,
  paperIds: string[],
  index: StatementIndex,
): string {
  const sourcePaperId = rawNode.sourcePaperId ? String(rawNode.sourcePaperId) : undefined;
  const sourceResultLabel = rawNode.sourceResultLabel ? String(rawNode.sourceResultLabel) : undefined;

  if (sourcePaperId && sourceResultLabel) {
    const exact = index.byPaperAndLabel.get(`${sourcePaperId}::${sourceResultLabel}`);
    if (exact !== undefined) return exact;
  }
  if (sourcePaperId) {
    const first = index.firstByPaper.get(sourcePaperId);
    if (first !== undefined) return first;
  }
  // Fall back to the first referenced paper's first main result.
  for (const pid of paperIds) {
    const first = index.firstByPaper.get(pid);
    if (first !== undefined) return first;
  }
  // Last resort: trust the LLM string (non-theorem contribution / no source).
  return String(rawNode.statement ?? "");
}

// ── Candidate coercion ──────────────────────────────────────────────────────

interface ExtractedCandidate {
  node: Omit<SpineNode, "effortIds">;
  suggestedEdges: Array<{ targetNodeId: string; edgeType: SpineEdge["type"]; context: string }>;
}

function coerceCandidate(
  rawNode: Record<string, unknown>,
  index: number,
  statementIndex: StatementIndex,
): ExtractedCandidate {
  const type = NODE_TYPES.has(rawNode.type as SpineNode["type"])
    ? (rawNode.type as SpineNode["type"])
    : "milestone";
  const depth = NODE_DEPTHS.has(rawNode.depth as SpineNode["depth"])
    ? (rawNode.depth as SpineNode["depth"])
    : "major";
  const paperIds = Array.isArray(rawNode.paper_ids) ? rawNode.paper_ids.map(String) : [];

  return {
    node: {
      id: slugify(String(rawNode.id ?? rawNode.title ?? `node-${index}`), `node-${index}`),
      type,
      title: String(rawNode.title ?? ""),
      year: typeof rawNode.year === "number" ? rawNode.year : undefined,
      authors: Array.isArray(rawNode.authors) ? rawNode.authors.map(String) : undefined,
      // VERBATIM: spliced from the read corpus, never the LLM's re-typing.
      statement: resolveVerbatimStatement(rawNode, paperIds, statementIndex),
      significance: String(rawNode.significance ?? ""),
      proofIdea: rawNode.proof_idea ? String(rawNode.proof_idea) : undefined,
      paperIds,
      depth,
    },
    suggestedEdges: Array.isArray(rawNode.suggested_edges)
      ? (rawNode.suggested_edges as Array<Record<string, unknown>>).map((e) => ({
          targetNodeId: String(e.target ?? ""),
          edgeType: EDGE_TYPES.has(e.type as SpineEdge["type"])
            ? (e.type as SpineEdge["type"])
            : "enables",
          context: String(e.context ?? ""),
        }))
      : [],
  };
}

function dedupeCandidatesById(candidates: ExtractedCandidate[]): ExtractedCandidate[] {
  const byId = new Map<string, ExtractedCandidate>();
  for (const c of candidates) {
    const existing = byId.get(c.node.id);
    if (!existing) {
      byId.set(c.node.id, c);
      continue;
    }
    existing.node.paperIds = [...new Set([...existing.node.paperIds, ...c.node.paperIds])];
    existing.suggestedEdges.push(...c.suggestedEdges);
  }
  return [...byId.values()];
}

/**
 * Issue #3 (dogfood-run-2): shallow-corpus fallback. When the node-extraction
 * LLM call produced zero candidates — typically because every PaperRead has
 * empty `read.mainResults` (abstract-only or survey-only reads) — synthesize
 * candidate nodes deterministically from what the reader DID capture:
 *
 *   • `skim.mainContribution` — one shallow milestone node per non-survey paper
 *     whose contribution sentence is non-empty.
 *   • `surveyDistillation.surveyOutline[]` — one background node per outline
 *     entry of every survey, attributed to that survey's paperId.
 *
 * These nodes are marked `depth: "incremental"` so the wiki/effort synthesizers
 * (and the user reading the report) can tell the spine is thin and was rescued
 * rather than freshly extracted. Statement bytes come from the source PaperRead
 * fields — never from an LLM call. No new LLM calls happen in the fallback.
 */
function synthesizeShallowCandidatesFromReads(reads: PaperRead[]): ExtractedCandidate[] {
  const out: ExtractedCandidate[] = [];

  for (const r of reads) {
    // (a) Survey outline → background nodes.
    const outline = r.surveyDistillation?.surveyOutline ?? [];
    for (const entry of outline) {
      const heading = entry.heading?.trim() ?? "";
      if (!heading) continue;
      const title = heading.slice(0, 200);
      const statement = (entry.summary ?? "").trim() || heading;
      out.push({
        node: {
          id: slugify(`${r.paperId}-${title}`, `shallow-${out.length}`),
          // Survey-outline sub-areas are background material → closest SpineNodeType is "foundation".
          type: "foundation",
          title,
          year: undefined,
          authors: undefined,
          statement,
          significance: `Sub-area covered by survey "${r.skim?.oneLineSummary ?? r.paperId}".`,
          proofIdea: undefined,
          paperIds: [r.paperId],
          depth: "incremental",
        },
        suggestedEdges: [],
      });
    }

    // (b) Skim's mainContribution → shallow milestone per non-survey paper.
    if (r.isSurvey) continue;
    const contribution = (r.skim?.mainContribution ?? "").trim();
    if (!contribution) continue;
    const title = (r.skim?.oneLineSummary ?? r.paperId).slice(0, 200);
    out.push({
      node: {
        id: slugify(`${r.paperId}-contribution`, `shallow-${out.length}`),
        type: "milestone",
        title,
        year: undefined,
        authors: undefined,
        statement: contribution,
        significance: `Contribution recorded from a shallow read of ${r.paperId} (mainResults not extracted).`,
        proofIdea: undefined,
        paperIds: [r.paperId],
        depth: "incremental",
      },
      suggestedEdges: [],
    });
  }

  return out;
}

// ── Survey structural prior (§7.2) ──────────────────────────────────────────

function buildSurveyStructuralPriors(
  priorArt: PriorArtCorpus | null,
  reads: PaperRead[],
): Array<{ surveyTitle: string; outline: string[] }> {
  if (!priorArt) return [];
  const readsById = new Map(reads.map((r) => [r.paperId, r]));
  const out: Array<{ surveyTitle: string; outline: string[] }> = [];

  for (const survey of priorArt.surveys) {
    if (survey.confidence < SURVEY_PRIOR_MIN_CONFIDENCE) continue;
    const read = readsById.get(survey.paperId);
    const outline = read?.surveyDistillation?.surveyOutline?.map((s) => s.heading) ?? [];
    out.push({ surveyTitle: survey.title, outline });
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function bucketByRole(reads: PaperRead[]): Map<string, PaperRead[]> {
  const map = new Map<string, PaperRead[]>();
  for (const r of reads) {
    const role = r.read?.role ?? "foundational";
    const list = map.get(role) ?? [];
    list.push(r);
    map.set(role, list);
  }
  return map;
}

function attachOrphanNodesToEras(spine: NarrativeSpine): void {
  if (spine.eras.length === 0) {
    spine.eras.push({
      name: "All Results",
      summary: "All extracted spine nodes.",
      nodeIds: spine.nodes.map((n) => n.id),
    });
    return;
  }
  const placed = new Set(spine.eras.flatMap((e) => e.nodeIds));
  for (const node of spine.nodes) {
    if (placed.has(node.id)) continue;
    const era =
      spine.eras.find((e) => {
        if (!node.year) return false;
        const start = e.startYear ?? 0;
        const end = e.endYear ?? 9999;
        return node.year >= start && node.year <= end;
      }) ?? spine.eras[spine.eras.length - 1]!;
    era.nodeIds.push(node.id);
    placed.add(node.id);
  }
}

function emptySpine(problemTitle: string): NarrativeSpine {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    globalThesis: `Research landscape for ${problemTitle}`,
    eras: [],
    nodes: [],
    edges: [],
    threads: [],
    openQuestions: [],
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length <= size) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}
