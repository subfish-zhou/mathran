/**
 * Spine-First Architecture — Effort Generation from Spine (fs port of mathub's
 * `effort-from-spine.ts`).
 *
 * Generates workspace efforts from the Narrative Spine and writes each one to
 * `<project>/efforts/<id>/` (document.md + effort.json):
 *   - Each SpineThread → a REFERENCE effort (literature survey)
 *   - Each major SpineNode → a METHOD/CONSTRUCTION/etc effort
 *   - SpineEdges → effort relations (direct mapping, no LLM guessing)
 *
 * The DB layer (mathub) is replaced by the fs paper-graph; full-text fetch is
 * dropped (abstracts only). Pure helpers (tags, type/role mapping, difficulty)
 * are kept verbatim so the original unit tests port unchanged.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { slugify } from "../../../../lib/slug.js";
import { getPaper } from "../../../paper-graph/index.js";
import { buildEffortDocumentPrompt, buildThreadDocumentPrompt } from "./prompts.js";
import { errMsg, noopEmit, type SpineLLM, type EmitFn } from "./llm.js";
import type {
  NarrativeSpine,
  SpineNode,
  SpineEdge,
  SpineThread,
  SpineDiff,
  WorkspaceEffortOutput,
  DependencyEdgeOutput,
  SpineCrawledResource,
} from "./types.js";

interface PaperMeta {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  arxivId?: string;
  doi?: string;
  url?: string;
}

export interface EffortFromSpineConfig {
  spine: NarrativeSpine;
  projectDir: string;
  workspace: string;
  problemTitle: string;
  /** Only generate efforts for a specific spine diff (patrol incremental) */
  diff?: SpineDiff;
}

export interface EffortFromSpineResult {
  efforts: WorkspaceEffortOutput[];
  edges: DependencyEdgeOutput[];
}

// ============================================================
//  fs persistence
// ============================================================

export function effortsDir(projectDir: string): string {
  return path.join(projectDir, "efforts");
}

function effortFrontmatter(e: WorkspaceEffortOutput): string {
  return [
    "---",
    `id: ${e.id}`,
    `title: ${JSON.stringify(e.title)}`,
    `type: ${e.type}`,
    `status: ${e.status}`,
    `difficulty: ${e.difficultyEstimate}`,
    e.year != null ? `year: ${e.year}` : null,
    e.era ? `era: ${JSON.stringify(e.era)}` : null,
    e.spineNodeId ? `spineNodeId: ${e.spineNodeId}` : null,
    e.spineThreadId ? `spineThreadId: ${e.spineThreadId}` : null,
    e.narrativeRole ? `narrativeRole: ${e.narrativeRole}` : null,
    `tags: [${e.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    "---",
    "",
  ].filter((l): l is string => l != null).join("\n");
}

async function writeEffort(projectDir: string, e: WorkspaceEffortOutput): Promise<void> {
  try {
    const dir = path.join(effortsDir(projectDir), e.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "document.md"),
      effortFrontmatter(e) + (e.document.trim() || `# ${e.title}`) + "\n",
      "utf-8",
    );
    await fs.writeFile(path.join(dir, "effort.json"), JSON.stringify(e, null, 2) + "\n", "utf-8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[spine-efforts] writeEffort(${e.id}) failed: ${errMsg(err)}`);
  }
}

// ============================================================
//  Main Entry Point
// ============================================================

export async function generateEffortsFromSpine(
  config: EffortFromSpineConfig,
  llm: SpineLLM,
  emit: EmitFn = noopEmit,
): Promise<EffortFromSpineResult> {
  const { spine, problemTitle, diff, workspace, projectDir } = config;
  const efforts: WorkspaceEffortOutput[] = [];
  const edges: DependencyEdgeOutput[] = [];

  const nodesToProcess = diff
    ? [
        ...diff.newNodes,
        ...diff.updatedNodes
          .map((u) => spine.nodes.find((n) => n.id === u.id))
          .filter((n): n is SpineNode => n != null),
      ]
    : spine.nodes.filter(shouldProcessNodeInFullInit);

  const threadsToProcess = diff ? [...diff.newThreads, ...diff.updatedThreads] : spine.threads;

  emit({ type: "log", message: `Generating efforts: ${threadsToProcess.length} threads, ${nodesToProcess.length} nodes` });

  const usedEffortIds = new Set<string>();
  const reserveEffortId = (base: string): string => {
    const safe = base || "effort";
    if (!usedEffortIds.has(safe)) {
      usedEffortIds.add(safe);
      return safe;
    }
    for (let n = 2; n < 1000; n++) {
      const candidate = `${safe}-${n}`;
      if (!usedEffortIds.has(candidate)) {
        usedEffortIds.add(candidate);
        emit({ type: "log", message: `Effort ID "${safe}" collision; using "${candidate}"` });
        return candidate;
      }
    }
    const candidate = `${safe}-${Math.random().toString(36).slice(2, 8)}`;
    usedEffortIds.add(candidate);
    return candidate;
  };
  const spineToEffort = new Map<string, string>();

  // ── 1. Thread → REFERENCE efforts ──
  for (const thread of threadsToProcess) {
    emit({ type: "log", message: `Generating thread survey: ${thread.name}` });

    const threadNodes = thread.nodeIds
      .map((id) => spine.nodes.find((n) => n.id === id))
      .filter(Boolean) as SpineNode[];

    const paperIds = [...new Set(threadNodes.flatMap((n) => n.paperIds))];
    const papers = await loadPaperMetadata(workspace, paperIds);
    const era = spine.eras.find((e) => e.nodeIds.some((id) => thread.nodeIds.includes(id)));
    const years = threadNodes.map((n) => n.year).filter((y): y is number => typeof y === "number");
    const year = years.length > 0 ? Math.min(...years) : undefined;

    let document: string;
    try {
      document = await llm(buildThreadDocumentPrompt(thread, threadNodes, papers, problemTitle), {
        temperature: 0.3,
        maxTokens: 4000,
      });
    } catch (err) {
      emit({ type: "log", message: `Thread doc failed for "${thread.name}": ${errMsg(err)}` });
      document = "";
    }
    if (!document.trim()) document = `Survey of ${thread.name}. ${thread.description}`;

    const effortId = reserveEffortId(slugify(thread.name, "thread"));
    spineToEffort.set(thread.id, effortId);

    const effort: WorkspaceEffortOutput = {
      id: effortId,
      type: "REFERENCE",
      title: thread.name,
      description: thread.description,
      status: "REFERENCE",
      subject: thread.currentFrontier ?? thread.barrier ?? thread.description,
      sources: papers.map(paperToResource),
      document,
      tags: buildThreadTags(thread),
      difficultyEstimate: estimateThreadDifficulty(thread.status),
      year,
      era: era?.name,
      spineThreadId: thread.id,
      abstract: thread.description,
      narrativeRole: thread.status === "dead_end" ? "dead_end" : "core_technique",
      referenceKind: "thread_survey",
      includedPaperIds: paperIds,
      includedSpineNodeIds: thread.nodeIds,
    };
    efforts.push(effort);
    await writeEffort(projectDir, effort);
    emit({ type: "effort_created", effortId, title: thread.name, fromSpineNode: thread.id });
  }

  // ── 2. Major Spine Nodes → METHOD efforts ──
  const majorNodes = nodesToProcess.filter(shouldGenerateNodeEffort);

  for (const node of majorNodes) {
    emit({ type: "log", message: `Generating effort for: ${node.title}` });

    const papers = await loadPaperMetadata(workspace, node.paperIds);
    const papersForPrompt = papers.map((p) => ({
      title: p.title,
      authors: p.authors,
      year: p.year,
      abstract: p.abstract,
    }));

    const predecessors = spine.edges
      .filter((e) => e.to === node.id)
      .map((e) => {
        const predNode = spine.nodes.find((n) => n.id === e.from);
        return predNode ? { title: predNode.title, context: e.context } : null;
      })
      .filter(Boolean) as Array<{ title: string; context: string }>;

    const successors = spine.edges
      .filter((e) => e.from === node.id)
      .map((e) => {
        const succNode = spine.nodes.find((n) => n.id === e.to);
        return succNode ? { title: succNode.title, context: e.context } : null;
      })
      .filter(Boolean) as Array<{ title: string; context: string }>;

    const era = spine.eras.find((e) => e.nodeIds.includes(node.id));
    const thread = spine.threads.find((t) => t.nodeIds.includes(node.id));

    let document: string;
    try {
      document = await llm(
        buildEffortDocumentPrompt(
          { ...node, effortIds: [] },
          papersForPrompt,
          { era: era?.name, threadName: thread?.name, predecessors, successors },
          problemTitle,
        ),
        { temperature: 0.3, maxTokens: 4000 },
      );
    } catch (err) {
      emit({ type: "log", message: `Node effort doc failed for "${node.title}": ${errMsg(err)}` });
      document = "";
    }
    if (!document.trim()) document = `${node.title}\n\n${node.statement}\n\n${node.significance}`;

    const effortId = reserveEffortId(slugify(node.title, "node-effort"));
    spineToEffort.set(node.id, effortId);

    const effort: WorkspaceEffortOutput = {
      id: effortId,
      type: mapNodeTypeToEffortType(node.type),
      title: node.title,
      description: node.significance,
      status: mapNodeTypeToStatus(node.type),
      subject: node.statement.slice(0, 200),
      sources: papers.map(paperToResource),
      document,
      tags: buildNodeTags(node, thread),
      difficultyEstimate: estimateNodeDifficulty(node),
      year: node.year,
      era: era?.name,
      spineNodeId: node.id,
      spineThreadId: thread?.id,
      abstract: node.significance,
      formalStatement: node.statement,
      narrativeRole: mapNodeTypeToNarrativeRole(node.type),
      deadEndReason: node.type === "dead_end" ? node.significance : undefined,
    };
    efforts.push(effort);
    await writeEffort(projectDir, effort);
    emit({ type: "effort_created", effortId, title: node.title, fromSpineNode: node.id });
  }

  // ── 3. Spine Edges → Effort Relations (direct mapping) ──
  for (const edge of spine.edges) {
    const fromEffort = spineToEffort.get(edge.from);
    const toEffort = spineToEffort.get(edge.to);
    if (fromEffort && toEffort && fromEffort !== toEffort) {
      edges.push({
        fromId: fromEffort,
        toId: toEffort,
        relation: mapSpineEdgeToRelation(edge.type),
        description: edge.context,
        confidence: 0.95,
        source: "spine",
      });
    }
  }

  emit({ type: "log", message: `Generated ${efforts.length} efforts, ${edges.length} edges` });
  return { efforts, edges };
}

// ============================================================
//  Helpers
// ============================================================

async function loadPaperMetadata(workspace: string, paperIds: string[]): Promise<PaperMeta[]> {
  const out: PaperMeta[] = [];
  for (const id of paperIds) {
    const p = await getPaper(workspace, id);
    if (!p) continue;
    out.push({
      id: p.id,
      title: p.title,
      authors: p.authors ?? [],
      year: p.year ?? undefined,
      abstract: p.abstract ?? undefined,
      arxivId: p.arxivId ?? undefined,
      doi: p.doi ?? undefined,
      url: p.url ?? undefined,
    });
  }
  return out;
}

function paperToResource(paper: PaperMeta): SpineCrawledResource {
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    sourceType: paper.arxivId ? "arxiv" : paper.doi ? "journal" : "webpage",
    arxivId: paper.arxivId,
    doi: paper.doi,
    url: paper.url ?? (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : ""),
    abstract: paper.abstract,
  };
}

function mapNodeTypeToEffortType(nodeType: SpineNode["type"]): WorkspaceEffortOutput["type"] {
  switch (nodeType) {
    case "milestone": return "PROOF_ATTEMPT";
    case "technique_origin": return "CONSTRUCTION";
    case "refinement": return "ESTIMATE";
    case "barrier": return "REDUCTION";
    case "bridge": return "CONSTRUCTION";
    case "dead_end": return "PROOF_ATTEMPT";
    case "open_direction": return "AUXILIARY";
    case "foundation": return "AUXILIARY";
    default: return "AUXILIARY";
  }
}

function mapNodeTypeToStatus(nodeType: SpineNode["type"]): WorkspaceEffortOutput["status"] {
  switch (nodeType) {
    case "dead_end": return "DEAD_END";
    case "open_direction": return "DRAFT";
    default: return "VERIFIED";
  }
}

function estimateThreadDifficulty(status: string): WorkspaceEffortOutput["difficultyEstimate"] {
  switch (status) {
    case "dead_end":
    case "stalled":
    case "converged":
      return "HARD";
    default:
      return "MODERATE";
  }
}

function estimateNodeDifficulty(node: SpineNode): WorkspaceEffortOutput["difficultyEstimate"] {
  if (node.type === "dead_end" || node.type === "open_direction" || node.type === "barrier") {
    return "VERY_HARD";
  }
  if (
    node.type === "milestone" ||
    node.type === "technique_origin" ||
    node.type === "bridge" ||
    node.type === "refinement"
  ) {
    return node.depth === "incremental" ? "MODERATE" : "HARD";
  }
  return node.depth === "foundational" ? "MODERATE" : "HARD";
}

export function shouldProcessNodeInFullInit(node: SpineNode): boolean {
  if (node.depth !== "incremental") return true;
  return node.type === "dead_end" || node.type === "open_direction";
}

export function shouldGenerateNodeEffort(node: SpineNode): boolean {
  return (
    node.type === "milestone" ||
    node.type === "technique_origin" ||
    node.type === "barrier" ||
    node.type === "bridge" ||
    node.type === "refinement" ||
    node.type === "dead_end" ||
    node.type === "open_direction"
  );
}

export function buildThreadTags(thread: Pick<SpineThread, "name" | "description" | "currentFrontier" | "barrier">): string[] {
  return uniqueTags([
    ...extractTopicTags(`${thread.name} ${thread.description} ${thread.currentFrontier ?? ""} ${thread.barrier ?? ""}`, 5),
    "reference-survey",
  ]);
}

export function buildNodeTags(node: SpineNode, thread: { name: string } | undefined): string[] {
  return uniqueTags([
    ...extractTopicTags(`${node.title} ${node.statement} ${node.significance} ${thread?.name ?? ""}`, 5),
    node.type.replace(/_/g, "-"),
  ]);
}

function uniqueTags(tags: Array<string | undefined>): string[] {
  return [...new Set(tags.map((tag) => tag?.trim()).filter((tag): tag is string => !!tag))];
}

function extractTopicTags(text: string, limit: number): string[] {
  const withoutCitationLead = text.replace(/^[^:]{1,120}:\s*/, "");
  const lower = withoutCitationLead.toLowerCase();
  const tags: string[] = [];
  const phraseRules: Array<[RegExp, string]> = [
    [/lonely\s+runner|lrc\b/, "lonely-runner"],
    [/diophantine/, "diophantine-approximation"],
    [/covering[-\s]+radi/, "covering-radius"],
    [/view[-\s]+obstruction/, "view-obstruction"],
    [/zonotop/, "zonotopal-geometry"],
    [/polyhed/, "polyhedral-geometry"],
    [/lattice/, "lattice-geometry"],
    [/finite[-\s]+check|bounded[-\s]+speed|bounded\s+search/, "finite-checking"],
    [/comput/, "computational-verification"],
    [/false[-\s]+start|claimed\s+proof|proof[-\s]+barrier/, "proof-barriers"],
    [/counterexample/, "counterexamples"],
    [/shifted/, "shifted-variant"],
    [/free[-\s]+start/, "free-starting"],
    [/time[-\s]+to[-\s]+loneliness|one[-\s]+round/, "time-to-loneliness"],
    [/additive[-\s]+combin/, "additive-combinatorics"],
    [/chromatic/, "chromatic-number"],
    [/spectrum|spectra/, "loneliness-spectrum"],
    [/lower[-\s]+bound|universal\s+lower/, "lower-bounds"],
    [/extremal/, "extremal-examples"],
    [/five\s+runners|six\s+runners|eight\s+runners|nine\s+runners|runner\s+counts/, "finite-runner-counts"],
  ];

  for (const [pattern, tag] of phraseRules) {
    if (pattern.test(lower)) tags.push(tag);
  }

  const stopwords = new Set([
    "about", "after", "again", "against", "barrier", "barriers", "bound", "bridges", "case", "claim",
    "claimed", "claims", "conjecture", "covering", "equivalent", "every", "first", "from",
    "gives", "known", "lonely", "method", "model", "paper", "problem", "proof", "proves", "runner",
    "runners", "setting", "shows", "speed", "speeds", "starts", "statement", "studies", "theorem",
    "thread", "using", "verifies",
  ]);
  const normalized = lower.replace(/\\[a-z]+/g, " ").replace(/[^a-z0-9]+/g, " ");
  for (const token of normalized.split(/\s+/)) {
    if (tags.length >= limit) break;
    if (token.length < 5 || stopwords.has(token)) continue;
    tags.push(slugify(token, token));
  }

  return uniqueTags(tags).slice(0, limit);
}

function mapNodeTypeToNarrativeRole(nodeType: SpineNode["type"]): WorkspaceEffortOutput["narrativeRole"] {
  switch (nodeType) {
    case "foundation": return "background";
    case "milestone": return "core_technique";
    case "technique_origin": return "core_technique";
    case "refinement": return "application";
    case "barrier": return "open_direction";
    case "bridge": return "generalization";
    case "dead_end": return "dead_end";
    case "open_direction": return "open_direction";
    default: return "background";
  }
}

function mapSpineEdgeToRelation(edgeType: SpineEdge["type"]): DependencyEdgeOutput["relation"] {
  switch (edgeType) {
    case "enables": return "depends_on";
    case "improves": return "extends";
    case "generalizes": return "extends";
    case "applies_technique": return "uses";
    case "contradicts": return "contradicts";
    case "reveals_barrier": return "related";
    default: return "related";
  }
}
