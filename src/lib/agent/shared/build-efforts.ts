/**
 * Shared effort-building pipeline — extracted from init-agent.ts executeBuildWorkspace().
 *
 * Clusters papers into research directions, generates method items via LLM,
 * and produces dependency edges between efforts.
 */

import { callAzureLLM, extractJSON, type TokenCounter } from "../azure-llm";
import { fetchArxivFullText, SURVEY_MAX_CHARS } from "../full-text";
import { buildWSAnalysisPrompt } from "../init-prompts";
import { mapWorkspaceEffortType, mapWSStatus } from "../init-parsers";
// TODO(mathran-v0.1): import { slugify } from "@/lib/utils";
import type {
  CrawledResource,
  WorkspaceEffortOutput,
  DependencyEdgeOutput,
} from "../init-types";

// ========== Helpers ==========

// sanitizeLLMJson moved into extractJSON (src/lib/agent/azure-llm.ts) so every
// JSON.parse(extractJSON(...)) call site benefits automatically. Passthrough
// here keeps the three call sites below textually unchanged.
const sanitizeLLMJson = (s: string) => s;

// ========== Config ==========

export interface BuildEffortsConfig {
  /** Problem title */
  problemTitle: string;
  /** Problem tags */
  problemTags: string[];
  /** Formal statement */
  formalStatement: string;
  /** Resources to build efforts from */
  resources: CrawledResource[];
  /** Existing effort IDs for dedup (patrol mode) */
  existingEffortIds?: string[];
  /** Tracker module name for usage logging (default: "init-agent") */
  trackerModule?: string;
  /** Full problem object for prompt building */
  problem?: {
    title: string;
    formalStatement: string;
    description: string;
    backgroundSummary: string;
    tags: string[];
  };
}

export interface BuildEffortsResult {
  efforts: WorkspaceEffortOutput[];
  edges: DependencyEdgeOutput[];
}

// ========== Core Logic ==========

/**
 * Build workspace efforts from crawled resources.
 *
 * Extracted from `executeBuildWorkspace()` in init-agent.ts.
 * Steps:
 *   A. Fetch full text for arXiv papers
 *   B. Cluster papers into research directions (REFERENCE efforts)
 *   C. Generate method items via LLM
 *   D. Generate dependency edges via LLM
 */
export async function buildEffortsFromResources(
  config: BuildEffortsConfig,
  emit: (event: Record<string, unknown>) => void,
  tokenCounter: TokenCounter,
): Promise<BuildEffortsResult> {
  const { resources } = config;
  const trackerModule = config.trackerModule ?? "init-agent";
  const problem = config.problem ?? {
    title: config.problemTitle,
    formalStatement: config.formalStatement,
    description: "",
    backgroundSummary: "",
    tags: config.problemTags,
  };

  emit({ type: "log", message: `Analyzing ${resources.length} resources, building knowledge structure...` });

  // ── Fetch full text for ALL arXiv papers ──
  const arxivResources = resources.filter((r) => r.arxivId);
  const surveyResources = arxivResources.filter((r) => r.isSurvey);
  const nonSurveyResources = arxivResources.filter((r) => !r.isSurvey);
  const orderedArxivResources = [...surveyResources, ...nonSurveyResources];
  const fullTexts = new Map<string, string>();
  if (orderedArxivResources.length > 0) {
    emit({ type: "log", message: `Fetching full text for ${orderedArxivResources.length} arXiv papers (${surveyResources.length} surveys first)...` });
    for (const r of orderedArxivResources) {
      try {
        const maxChars = r.isSurvey ? SURVEY_MAX_CHARS : undefined;
        const ft = await fetchArxivFullText(r.arxivId!, maxChars);
        if (ft) {
          fullTexts.set(r.id, ft.text);
          emit({ type: "log", message: `Full text fetched (${ft.source}${r.isSurvey ? ", survey" : ""}): ${r.title.slice(0, 60)}...` });
        }
      } catch {
        // non-critical, continue
      }
    }
  }

  // ── Step A: Cluster papers into 3-8 research directions via LLM ──
  emit({ type: "log", message: "Clustering papers into research directions..." });
  let referenceItems: WorkspaceEffortOutput[] = [];

  try {
    const paperList = resources
      .map((r, i) => `[${i}] "${r.title}" by ${r.authors.slice(0, 2).join(", ")}${r.authors.length > 2 ? " et al." : ""}${r.abstract ? ` — ${r.abstract.slice(0, 200)}` : ""}`)
      .join("\n");

    const clusterPrompt = `You are clustering mathematical research papers into thematic research directions.

Given these ${resources.length} papers about "${config.problemTitle}", group them into 3-8 research directions/themes. Each direction should contain papers that share a common approach, technique, or sub-topic.

Problem statement: ${config.formalStatement.slice(0, 300)}
Tags: ${config.problemTags.join(", ")}

Papers:
${paperList}

For each direction, provide:
- "title": a concise name for this research direction
- "description": 1-2 sentence overview of what this direction covers
- "document": 200-500 word survey of the papers in this direction, citing them by [index]. Use LaTeX ($...$, $$...$$) for math.
- "paper_indices": array of paper indices (0-based) belonging to this direction
- "tags": 2-5 keyword tags

RULES:
- Every paper must appear in at least one direction
- A paper can appear in multiple directions if it spans topics
- Create 3-8 directions (fewer if there are few papers)
- Each direction must have at least 1 paper

Output JSON: {"directions": [{"title": "...", "description": "...", "document": "...", "paper_indices": [0, 2, 5], "tags": ["tag1"]}]}
Output ONLY valid JSON.`;

    const raw = await callAzureLLM(clusterPrompt, { tokenCounter, tracker: { module: trackerModule, operation: "init-cluster" }, timeoutMs: 1_080_000 });
    const parsed = JSON.parse(sanitizeLLMJson(extractJSON(raw)));

    if (Array.isArray(parsed.directions)) {
      referenceItems = parsed.directions.map((d: Record<string, unknown>) => {
        const title = String(d.title ?? "Research Direction");
        const id = slugify(title);
        const indices = Array.isArray(d.paper_indices) ? (d.paper_indices as number[]) : [];
        const dirSources = indices
          .map(i => resources[i])
          .filter((r): r is CrawledResource => r != null);

        const effort: WorkspaceEffortOutput = {
          id,
          type: "REFERENCE" as const,
          title,
          description: String(d.description ?? ""),
          status: "REFERENCE" as const,
          sources: dirSources,
          document: d.document ? String(d.document) : undefined,
          tags: Array.isArray(d.tags) ? d.tags.map(String) : undefined,
        };

        // Skip if this effort ID already exists (patrol dedup)
        if (config.existingEffortIds?.includes(id)) {
          return null;
        }

        emit({
          type: "workspace_effort_created",
          effort: { id: effort.id, type: effort.type, title: effort.title, status: effort.status },
        });
        return effort;
      }).filter((e: WorkspaceEffortOutput | null): e is WorkspaceEffortOutput => e != null);
    }

    emit({ type: "log", message: `Created ${referenceItems.length} research direction(s) from ${resources.length} papers` });
  } catch (err) {
    emit({ type: "log", message: `Paper clustering failed: ${err instanceof Error ? err.message : "unknown"}. Creating single reference group.` });
    // Fallback: single reference direction with all papers
    referenceItems = [{
      id: slugify("references-" + config.problemTitle),
      type: "REFERENCE" as const,
      title: "References",
      description: `All papers related to ${config.problemTitle}`,
      status: "REFERENCE" as const,
      sources: resources,
    }];
  }

  // ── Step B: Generate method items via LLM (first call — NO edges) ──
  // Truncate full texts if total content is too large (>100k chars ≈ ~25k tokens)
  const MAX_TOTAL_CHARS = 100_000;
  const MAX_PER_PAPER_CHARS = 8_000;
  let totalChars = 0;
  for (const [, text] of fullTexts) totalChars += text.length;
  if (totalChars > MAX_TOTAL_CHARS) {
    emit({ type: "log", message: `Full texts total ${totalChars} chars, truncating each to ${MAX_PER_PAPER_CHARS} chars` });
    for (const [id, text] of fullTexts) {
      if (text.length > MAX_PER_PAPER_CHARS) {
        fullTexts.set(id, text.slice(0, MAX_PER_PAPER_CHARS) + "\n\n[... truncated for length ...]");
      }
    }
  }

  const wsPrompt = buildWSAnalysisPrompt(problem, resources, fullTexts);
  emit({ type: "log", message: "AI is analyzing mathematical structures and methods..." });

  let methodItems: WorkspaceEffortOutput[] = [];

  try {
    const raw = await callAzureLLM(wsPrompt, { tokenCounter, tracker: { module: trackerModule, operation: "init-workspace" }, timeoutMs: 1_800_000 });
    const parsed = JSON.parse(sanitizeLLMJson(extractJSON(raw)));

    if (Array.isArray(parsed.method_items)) {
      methodItems = parsed.method_items.map((m: Record<string, unknown>) => {
        const id = slugify(String(m.title ?? m.id ?? "item"));

        // Skip if this effort ID already exists (patrol dedup)
        if (config.existingEffortIds?.includes(id)) {
          return null;
        }

        const effort: WorkspaceEffortOutput = {
          id,
          type: mapWorkspaceEffortType(String(m.type ?? "CONSTRUCTION")),
          title: String(m.title ?? ""),
          description: String(m.description ?? ""),
          status: mapWSStatus(String(m.status ?? "DRAFT")),
          subject: m.subject ? String(m.subject) : undefined,
          deadEndReason: m.dead_end_reason ? String(m.dead_end_reason) : undefined,
          erratumReason: m.erratum_reason ? String(m.erratum_reason) : undefined,
          classification: ["core", "method_group", "background"].includes(String(m.classification ?? ""))
            ? (String(m.classification) as "core" | "method_group" | "background")
            : undefined,
          document: m.document ? String(m.document) : undefined,
          tags: Array.isArray(m.tags) ? m.tags.map(String) : undefined,
          difficultyEstimate: normalizeDifficultyEstimate(String(m.difficulty_estimate ?? "")),
          narrativeRole: ["background", "core_technique", "application", "generalization", "open_direction", "dead_end"].includes(String(m.narrative_role ?? m.narrativeRole ?? ""))
            ? (String(m.narrative_role ?? m.narrativeRole) as WorkspaceEffortOutput["narrativeRole"])
            : undefined,
        };
        emit({
          type: "workspace_effort_created",
          effort: { id: effort.id, type: effort.type, title: effort.title, status: effort.status },
        });
        return effort;
      }).filter((e: WorkspaceEffortOutput | null): e is WorkspaceEffortOutput => e != null);
    }
  } catch (err) {
    emit({ type: "log", message: `Method analysis failed: ${err instanceof Error ? err.message : "unknown"}` });
  }

  // ── Step C: Generate dependency edges via SECOND LLM call ──
  const allItems = [...referenceItems, ...methodItems];
  let edges: DependencyEdgeOutput[] = [];

  if (allItems.length > 1 && methodItems.length > 0) {
    emit({ type: "log", message: "Generating dependency edges..." });
    try {
      const effortList = allItems
        .map(e => `[${e.id}] "${e.title}" (${e.type})`)
        .join("\n");

      const edgePrompt = `You are a mathematical knowledge graph builder. Given these workspace efforts about "${config.problemTitle}", generate dependency edges between them.

Efforts:
${effortList}

Generate dependency edges. Each edge connects two efforts by their EXACT id (shown in brackets).

Edge types:
- "depends_on": A requires B as a prerequisite
- "extends": A generalizes or builds upon B
- "uses": A uses techniques/results from B
- "related": A and B are thematically related
- "supersedes": A makes B obsolete
- "contradicts": A conflicts with B

NOTE: Only create edges between efforts listed above (within this project). If an effort depends on results from a different mathematical problem/project, mention the external dependency in the effort description field with a note like: [External dependency: Problem Title]

Output JSON: {"dependency_edges": [{"from": "exact-effort-id", "to": "exact-effort-id", "relation": "depends_on|extends|uses|related|supersedes|contradicts", "description": "brief explanation", "confidence": 0.9}]}

CRITICAL: Use the EXACT effort IDs from the list above. Do not invent new IDs.
Output ONLY valid JSON.`;

      const raw = await callAzureLLM(edgePrompt, { tokenCounter, tracker: { module: trackerModule, operation: "init-edge" }, timeoutMs: 1_080_000 });
      const parsed = JSON.parse(sanitizeLLMJson(extractJSON(raw)));

      if (Array.isArray(parsed.dependency_edges)) {
        edges = parsed.dependency_edges
          .map((e: Record<string, unknown>) => ({
            fromId: slugify(String(e.from ?? "")),
            toId: slugify(String(e.to ?? "")),
            relation: ((): DependencyEdgeOutput["relation"] => {
              const ALLOWED_RELATIONS: DependencyEdgeOutput["relation"][] = [
                "depends_on", "extends", "uses", "related", "supersedes", "contradicts",
              ];
              const raw = String(e.relation ?? "related");
              return ALLOWED_RELATIONS.includes(raw as DependencyEdgeOutput["relation"])
                ? (raw as DependencyEdgeOutput["relation"])
                : "related";
            })(),
            description: e.description ? String(e.description) : undefined,
            confidence: typeof e.confidence === "number" ? e.confidence : 0.8,
            source: "llm" as const,
          }))
          .filter((e: DependencyEdgeOutput) => e.fromId && e.toId);

        // Fuzzy match edge IDs to actual effort IDs (LLM often invents different slugs)
        const effortIds = allItems.map((m) => m.id);
        const fuzzyMatch = (edgeId: string): string | null => {
          if (effortIds.includes(edgeId)) return edgeId;
          const match = effortIds.find((id) => id.includes(edgeId) || edgeId.includes(id));
          if (match) return match;
          const edgeWords = new Set(edgeId.split("-"));
          let bestId: string | null = null;
          let bestOverlap = 0;
          for (const id of effortIds) {
            const idWords = id.split("-");
            const overlap = idWords.filter((w) => edgeWords.has(w)).length;
            if (overlap > bestOverlap && overlap >= 2) {
              bestOverlap = overlap;
              bestId = id;
            }
          }
          return bestId;
        };
        edges = edges.map((e) => ({
          ...e,
          fromId: fuzzyMatch(e.fromId) ?? e.fromId,
          toId: fuzzyMatch(e.toId) ?? e.toId,
        }));

        for (const edge of edges) {
          emit({
            type: "dependency_edge_created",
            from: edge.fromId,
            to: edge.toId,
            relation: edge.relation,
          });
        }
      }
    } catch (err) {
      emit({ type: "log", message: `Dependency edge generation failed: ${err instanceof Error ? err.message : "unknown"}` });
    }
  }

  emit({ type: "workspace_complete", stats: { efforts: allItems.length, edges: edges.length } });

  return { efforts: allItems, edges };
}

function normalizeDifficultyEstimate(raw: string): WorkspaceEffortOutput["difficultyEstimate"] | undefined {
  if (raw === "ROUTINE" || raw === "MODERATE" || raw === "HARD" || raw === "VERY_HARD") {
    return raw;
  }
  if (raw === "OPEN_PROBLEM") return "VERY_HARD";
  return undefined;
}
