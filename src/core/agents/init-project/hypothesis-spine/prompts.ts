/**
 * Hypothesis-spine builder prompt (Layer 3 §4).
 *
 * Asks the LLM to synthesize what the field's spine SHOULD look like given
 * canon + surveys, BEFORE any reads. The output is the same JSON shape as
 * the post-hoc spine assembly prompt, with one addition per node:
 * `expectedPaperIds` — papers the LLM thinks should ground this node.
 *
 * Re-uses the era-narrative-arc + thread-narrative-arc framing from 5.1 so
 * the hypothesis spine reads like a story from the first emit.
 */

import type { CanonicalLandmarkHit } from "../prior-art/canonical-landmarks-search.js";
import type { PriorArtSurvey } from "../prior-art/index.js";

export interface BuildHypothesisSpinePromptInput {
  problemTitle: string;
  problemStatement: string;
  problemTags: string[];
  canon: CanonicalLandmarkHit[];
  surveys: PriorArtSurvey[];
}

export function buildHypothesisSpinePrompt(input: BuildHypothesisSpinePromptInput): string {
  const { problemTitle, problemStatement, problemTags, canon, surveys } = input;

  const canonBlock = canon.length > 0
    ? canon
        .slice()
        .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
        .map((c, i) => {
          const yr = c.year ?? c.crossrefYear ?? "?";
          const auth = c.authors[0] ?? "(unknown)";
          const venue = c.venue ?? c.crossrefVenue ?? "?";
          const id = c.arxivId ? `arxiv-${c.arxivId}` : c.doi ? `doi:${c.doi}` : `canon-${i}`;
          return `  ${i + 1}. [${yr}] ${auth}, "${c.title.slice(0, 100)}" (${venue})\n     paperId: ${id}\n     why: ${c.why.slice(0, 200)}`;
        })
        .join("\n")
    : "  (no canon proposed — work purely from problem statement)";

  const surveyBlock = surveys.length > 0
    ? surveys
        .map((s, i) => {
          const yr = s.year ?? "?";
          const auth = s.authors[0] ?? "(unknown)";
          return `  ${i + 1}. [${yr}] ${auth}, "${s.title.slice(0, 100)}"\n     paperId: ${s.paperId}\n     why: ${s.why.slice(0, 200)}`;
        })
        .join("\n")
    : "  (no surveys found)";

  return [
    `You are building a HYPOTHESIS SPINE for an init-agent doing literature`,
    `review on the following research problem. The agent has NOT read any`,
    `papers yet. Your job is to predict what the field's narrative spine`,
    `SHOULD look like, using only your prior knowledge + the canon + survey`,
    `lists below.`,
    ``,
    `This hypothesis spine will be USED to guide reading order, then`,
    `RECONCILED against the actually-read spine. Nodes you propose will be`,
    `marked verified / refined / falsified after reading completes.`,
    ``,
    `PROBLEM: ${problemTitle}`,
    `STATEMENT: ${problemStatement.slice(0, 1000)}`,
    problemTags.length > 0 ? `TAGS: ${problemTags.join(", ")}` : "",
    ``,
    `CANONICAL LANDMARKS (LLM-proposed, chronological):`,
    canonBlock,
    ``,
    `SURVEYS:`,
    surveyBlock,
    ``,
    `EMIT a JSON object matching EXACTLY this shape:`,
    `{`,
    `  "global_thesis": "One sentence capturing the central tension/story",`,
    `  "nodes": [`,
    `    {`,
    `      "id": "node-slug-like-this",`,
    `      "type": "foundation|milestone|technique_origin|refinement|barrier|bridge|dead_end|open_direction",`,
    `      "title": "Short result name",`,
    `      "year": 1973,`,
    `      "authors": ["Chen"],`,
    `      "statement": "Precise LaTeX statement of what this node represents — your BEST PREDICTION of the result.",`,
    `      "significance": "Why this node matters for the problem (2-3 sentences).",`,
    `      "depth": "incremental|major|foundational",`,
    `      "expectedPaperIds": ["paperId(s) from the lists above you EXPECT to ground this node"]`,
    `    }`,
    `  ],`,
    `  "eras": [`,
    `    { "name": "Narrative arc describing the intellectual move (NO date bracket)", "start_year": 1859, "end_year": 1950, "summary": "What move the field made (2-3 sentences)", "node_ids": ["node-id"] }`,
    `  ],`,
    `  "edges": [`,
    `    { "from": "node-id", "to": "node-id", "type": "enables|improves|generalizes|applies_technique|contradicts|reveals_barrier", "context": "One sentence" }`,
    `  ],`,
    `  "threads": [`,
    `    { "id": "thread-slug", "name": "Research thread describing the intellectual move", "description": "What this line pursues", "node_ids": ["node-id"], "status": "active|stalled|converged|dead_end", "current_frontier": "Best known result (LaTeX)", "barrier": "What blocks progress" }`,
    `  ],`,
    `  "open_questions": [`,
    `    { "title": "Open Question Title", "statement": "Precise LaTeX statement", "related_node_ids": ["node-id"], "barrier": "What blocks", "partial_progress": "Known partial results" }`,
    `  ]`,
    `}`,
    ``,
    `RULES:`,
    `  - Era names: NARRATIVE ARCS not date brackets ("First-wave combinatorial sieve" not "1920-1973").`,
    `  - Thread names: name the intellectual MOVE, not the topic.`,
    `  - expectedPaperIds MUST come from the canon / survey paperId lists above. Do NOT invent ids.`,
    `  - When a paper has BOTH an arxiv id and a doi listed, PREFER the arxiv form (e.g. \`arxiv-1510.04145\` over \`doi:10.1145/xxx\`) because that's the id space the reading-loop uses for ingestion. Only use \`doi:...\` when no arxiv id is available.`,
    `  - 4-12 nodes, 2-5 eras, 1-4 threads, 0-5 open_questions. Stay focused.`,
    `  - When uncertain, ERR ON THE SIDE OF FEWER NODES — reconcile is more useful when each hypothesis is testable.`,
    `  - Every node id must appear in at least one era and at least one thread.`,
    ``,
    `Output ONLY valid JSON, no preamble.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Parse + validate. Returns null on garbage. */
export function parseAndValidateHypothesisSpine(
  raw: unknown,
  candidatePaperIds: Set<string>,
): {
  globalThesis: string;
  nodes: Array<{
    id: string;
    type: string;
    title: string;
    year?: number;
    authors?: string[];
    statement: string;
    significance: string;
    depth: string;
    expectedPaperIds: string[];
  }>;
  eras: Array<{ name: string; startYear?: number; endYear?: number; summary: string; nodeIds: string[] }>;
  edges: Array<{ from: string; to: string; type: string; context: string }>;
  threads: Array<{ id: string; name: string; description: string; nodeIds: string[]; status: string; currentFrontier?: string; barrier?: string }>;
  openQuestions: Array<{ title: string; statement: string; relatedNodeIds: string[]; barrier?: string; partialProgress?: string }>;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const globalThesis = typeof r.global_thesis === "string" ? r.global_thesis : "";
  const nodesRaw = Array.isArray(r.nodes) ? r.nodes : [];
  const erasRaw = Array.isArray(r.eras) ? r.eras : [];
  const edgesRaw = Array.isArray(r.edges) ? r.edges : [];
  const threadsRaw = Array.isArray(r.threads) ? r.threads : [];
  const oqRaw = Array.isArray(r.open_questions) ? r.open_questions : [];

  const VALID_NODE_TYPES = new Set(["foundation", "milestone", "technique_origin", "refinement", "barrier", "bridge", "dead_end", "open_direction"]);
  const VALID_DEPTHS = new Set(["incremental", "major", "foundational"]);
  const VALID_EDGE_TYPES = new Set(["enables", "improves", "generalizes", "applies_technique", "contradicts", "reveals_barrier"]);
  const VALID_THREAD_STATUS = new Set(["active", "stalled", "converged", "dead_end"]);

  const nodeIds = new Set<string>();
  const nodes: Array<{
    id: string;
    type: string;
    title: string;
    year?: number;
    authors?: string[];
    statement: string;
    significance: string;
    depth: string;
    expectedPaperIds: string[];
  }> = [];
  for (const n of nodesRaw) {
    if (!n || typeof n !== "object") continue;
    const nr = n as Record<string, unknown>;
    const id = typeof nr.id === "string" ? nr.id.trim() : "";
    const type = typeof nr.type === "string" && VALID_NODE_TYPES.has(nr.type) ? nr.type : "milestone";
    const title = typeof nr.title === "string" ? nr.title.trim() : "";
    const statement = typeof nr.statement === "string" ? nr.statement.trim() : "";
    const significance = typeof nr.significance === "string" ? nr.significance.trim() : "";
    const depth = typeof nr.depth === "string" && VALID_DEPTHS.has(nr.depth) ? nr.depth : "local";
    const year = typeof nr.year === "number" ? nr.year : undefined;
    const authors = Array.isArray(nr.authors) ? nr.authors.filter((a): a is string => typeof a === "string") : undefined;
    const expectedPaperIds = Array.isArray(nr.expectedPaperIds)
      ? nr.expectedPaperIds
          .filter((p): p is string => typeof p === "string")
          .filter((p) => candidatePaperIds.has(p))
      : [];
    if (!id || !title || !statement) continue;
    if (nodeIds.has(id)) continue;
    nodeIds.add(id);
    nodes.push({ id, type, title, year, authors, statement, significance, depth, expectedPaperIds });
  }
  if (nodes.length === 0) return null;

  const eras = erasRaw
    .map((e) => {
      if (!e || typeof e !== "object") return null;
      const er = e as Record<string, unknown>;
      return {
        name: typeof er.name === "string" ? er.name.trim() : "",
        startYear: typeof er.start_year === "number" ? er.start_year : undefined,
        endYear: typeof er.end_year === "number" ? er.end_year : undefined,
        summary: typeof er.summary === "string" ? er.summary.trim() : "",
        nodeIds: Array.isArray(er.node_ids)
          ? er.node_ids.filter((i): i is string => typeof i === "string" && nodeIds.has(i))
          : [],
      };
    })
    .filter((e): e is NonNullable<typeof e> => e != null && !!e.name);

  const edges = edgesRaw
    .map((e) => {
      if (!e || typeof e !== "object") return null;
      const er = e as Record<string, unknown>;
      const from = typeof er.from === "string" ? er.from : "";
      const to = typeof er.to === "string" ? er.to : "";
      if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) return null;
      const type = typeof er.type === "string" && VALID_EDGE_TYPES.has(er.type) ? er.type : "enables";
      const context = typeof er.context === "string" ? er.context.trim() : "";
      return { from, to, type, context };
    })
    .filter((e): e is NonNullable<typeof e> => e != null);

  const threads = threadsRaw
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      const tr = t as Record<string, unknown>;
      const status = typeof tr.status === "string" && VALID_THREAD_STATUS.has(tr.status) ? tr.status : "active";
      return {
        id: typeof tr.id === "string" ? tr.id.trim() : "",
        name: typeof tr.name === "string" ? tr.name.trim() : "",
        description: typeof tr.description === "string" ? tr.description.trim() : "",
        nodeIds: Array.isArray(tr.node_ids)
          ? tr.node_ids.filter((i): i is string => typeof i === "string" && nodeIds.has(i))
          : [],
        status,
        currentFrontier: typeof tr.current_frontier === "string" ? tr.current_frontier : undefined,
        barrier: typeof tr.barrier === "string" ? tr.barrier : undefined,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t != null && !!t.id && !!t.name);

  const openQuestions = oqRaw
    .map((oq) => {
      if (!oq || typeof oq !== "object") return null;
      const r2 = oq as Record<string, unknown>;
      return {
        title: typeof r2.title === "string" ? r2.title.trim() : "",
        statement: typeof r2.statement === "string" ? r2.statement.trim() : "",
        relatedNodeIds: Array.isArray(r2.related_node_ids)
          ? r2.related_node_ids.filter((i): i is string => typeof i === "string" && nodeIds.has(i))
          : [],
        barrier: typeof r2.barrier === "string" ? r2.barrier : undefined,
        partialProgress: typeof r2.partial_progress === "string" ? r2.partial_progress : undefined,
      };
    })
    .filter((oq): oq is NonNullable<typeof oq> => oq != null && !!oq.title);

  return { globalThesis, nodes, eras, edges, threads, openQuestions };
}
