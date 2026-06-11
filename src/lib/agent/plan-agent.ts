/**
 * Plan Agent — Project planning agent
 *
 * Converts user-submitted problem descriptions + reference links into structured math problem definitions.
 *
 * Uses Azure OpenAI API + real arXiv API for analysis.
 */

import type {
  PlanAgentEvent,
  PlanAgentResult,
  ParsedReference,
  FormalizedProblem,
  ProgramPlan,
  ProgramSubProject,
} from "./plan-types";
import { callAzureLLM, extractJSON, TokenCounter, type AzureModelId } from "./azure-llm";
import type { JobContext } from "@/lib/jobs/job-manager";
import { safeFetch } from "@/lib/safe-fetch";
import { searchArxiv } from "./shared/crawl-pipeline";

// ========== Public API ==========

/**
 * Create SSE stream for Plan Agent.
 */
export function createPlanAgentStream(
  description: string,
  referenceLinks: string[],
  model?: AzureModelId,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already closed */ } });
      const emit = (event: PlanAgentEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(data));
      };

      const keepAliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch { /* closed */ }
      }, 15_000);

      try {
        await runAIMode(description, referenceLinks, emit, model);
      } catch (err) {
        emit({
          type: "plan_error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        clearInterval(keepAliveTimer);
        controller.close();
      }
    },
    cancel() {
      // cleared on cancel to avoid enqueue-after-close
    },
  });
}

/**
 * Resolve a single reference link (for GET /api/resolve-link).
 */
export async function resolveLink(url: string): Promise<ParsedReference> {
  return resolveReferenceReal(url);
}

// ========================================================================
//  AI Mode — Copilot CLI + Real API
// ========================================================================

async function runAIMode(
  description: string,
  referenceLinks: string[],
  emit: (event: PlanAgentEvent) => void,
  model?: AzureModelId
) {
  const tokenCounter = new TokenCounter();

  // ── Phase 1: Parsing ──
  emit({ type: "plan_phase", phase: "parsing" });
  emit({ type: "plan_progress", message: "Parsing input..." });

  // Parse reference links via real APIs (parallel, capped at 5 concurrent)
  const parsedRefs: ParsedReference[] = [];
  {
    const CONCURRENCY_CAP = 5;
    for (let i = 0; i < referenceLinks.length; i += CONCURRENCY_CAP) {
      const batch = referenceLinks.slice(i, i + CONCURRENCY_CAP);
      emit({ type: "plan_progress", message: `Resolving references ${i + 1}-${Math.min(i + CONCURRENCY_CAP, referenceLinks.length)} of ${referenceLinks.length}...` });
      const results = await Promise.allSettled(
        batch.map((link) => resolveReferenceReal(link))
      );
      for (let j = 0; j < results.length; j++) {
        const result = results[j]!;
        const ref: ParsedReference = result.status === "fulfilled"
          ? result.value
          : { originalInput: batch[j]!, type: "unknown", resolved: false };
        parsedRefs.push(ref);
        emit({ type: "reference_parsed", ref });
      }
    }
  }

  // ── Phase 2: Analyzing ──
  emit({ type: "plan_phase", phase: "analyzing" });

  // Search arXiv for related work before LLM analysis (non-blocking, timeout 10s)
  emit({ type: "plan_progress", message: "Searching arXiv for related work..." });
  let arxivContext = "";
  try {
    // Extract key terms from description for search
    const searchQuery = description.trim().slice(0, 200);
    const searchPromise = searchArxiv(searchQuery, 5);
    // [P2-1 fix] Hold the timer handle so we can clear it once searchPromise
    // resolves. Previously the orphan timer lingered for 10s, delaying clean
    // process exit.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("arXiv search timeout")),
        10_000,
      );
    });
    let arxivResults: Awaited<typeof searchPromise>;
    try {
      arxivResults = await Promise.race([searchPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (arxivResults.length > 0) {
      arxivContext = "\n\n### arXiv Search Results (recent related work)\n" +
        arxivResults.map((r, i) =>
          `${i + 1}. **${r.title}** (${r.authors.slice(0, 3).join(", ")}${r.authors.length > 3 ? " et al." : ""}, ${r.year ?? "n.d."})\n   ${r.abstract?.slice(0, 200) ?? "No abstract"}...\n   URL: ${r.url}`
        ).join("\n");
      emit({ type: "plan_progress", message: `Found ${arxivResults.length} related papers on arXiv` });
    }
  } catch {
    emit({ type: "log", message: "arXiv search skipped (timeout or error)" });
  }

  emit({ type: "plan_progress", message: "Calling AI model to analyze the problem..." });

  // Build prompt with arXiv context
  const prompt = buildPlanPrompt(description, parsedRefs, arxivContext);

  const llmResponse = await callAzureLLM(prompt, { model, maxTokens: 128000, systemPrompt: PLAN_AGENT_SYSTEM_PROMPT, tokenCounter, tracker: { module: "plan-agent", operation: "plan-analyze" } });

  emit({ type: "plan_progress", message: "AI analysis complete, processing results..." });

  // ── Phase 3: Searching (concept extraction) ──
  emit({ type: "plan_phase", phase: "searching" });

  // ── Phase 4: Formalizing ──
  emit({ type: "plan_phase", phase: "formalizing" });
  emit({ type: "plan_progress", message: "Generating formalized results..." });

  // Parse LLM JSON response
  const result = parseLLMResponse(llmResponse, parsedRefs, emit);

  emit({ type: "plan_result", result });
  emit({ type: "log", message: "Plan Agent analysis complete (AI mode)" });
}

// ========== Prompt Construction ==========

function buildPlanPrompt(
  description: string,
  refs: ParsedReference[],
  arxivContext = "",
): string {
  const refSection =
    refs.length > 0
      ? refs
          .map((r, i) => {
            const parts = [`### Reference ${i + 1}`];
            if (r.title) parts.push(`Title: ${r.title}`);
            if (r.authors?.length)
              parts.push(`Authors: ${r.authors.join(", ")}`);
            if (r.abstract) parts.push(`Abstract: ${r.abstract}`);
            if (r.url) parts.push(`URL: ${r.url}`);
            parts.push(`Type: ${r.type}`);
            return parts.join("\n");
          })
          .join("\n\n")
      : "No references provided.";

  // Sanitize user input: trim, limit length, strip control characters
  const sanitized = description
    .trim()
    .slice(0, 10_000)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  return `## User Input

### Problem Description
${sanitized}

### Reference Papers
${refSection}
${arxivContext}

---

Output ONLY the JSON object. No markdown code blocks, no commentary.`;
}

const PLAN_AGENT_SYSTEM_PROMPT = `You are Mathub's Plan Agent, a specialist AI that helps mathematics researchers precisely define mathematical problems for collaborative research projects.

Your task:
1. Analyze the user's problem description and any reference papers provided
2. Identify the exact mathematical problem the user wants to research
3. Output a structured JSON result

The user may provide:
- A complete conjecture statement (best case)
- A discussion or notes about a problem
- A few keywords or field names (vaguest case)
- Reference paper links (with parsed titles, authors, abstracts)

Your output MUST be a single JSON object with these fields:

{
  "status": "single" | "multiple" | "insufficient",

  "problem": {
    "title": "English title of the problem/conjecture",
    "formal_statement": "LaTeX formal mathematical statement (use standard LaTeX notation)",
    "description": "Natural language description of the problem",
    "background_summary": "100-300 word background including history, key contributors, and significance",
    "tags": ["field1", "field2", ...],
    "current_status": "Brief current research status",
    "msc_codes": ["11", "14", ...]  // MSC 2020 primary classification codes (2-digit strings)
  },

  "candidates": [
    { "title", "formal_statement", "description", "background_summary", "tags", "current_status", "msc_codes" }
  ],

  "detected_topics": ["topic1", "topic2"],
  "follow_up_suggestions": ["suggestion1", "suggestion2"],

  "math_status": "OPEN" | "PARTIALLY_SOLVED" | "SOLVED" | "DISPUTED",
  "solved_by": "string (optional, who solved it)",
  "solved_year": number (optional, year solved),
  "solved_reference": "string (optional, key reference for the solution)",

  "reasoning": "Your analysis explanation"
}

Rules:
- If status="single": include "problem", omit "candidates"/"detected_topics"/"follow_up_suggestions"
- If status="multiple": include "candidates" (2-5 items), omit "problem"
- If status="insufficient": include "detected_topics" and "follow_up_suggestions", omit "problem"/"candidates"
- "reasoning" is always required
- formal_statement MUST use LaTeX with dollar-sign delimiters: $...$ for inline math, $$...$$ for display math. Do NOT use \[...\] or \(...\) notation.
- title MUST be in English
- background_summary can use English (preferred) or Chinese-English mix
- tags should include MSC 2020 categories where applicable (e.g., "Harmonic Analysis", "Geometric Measure Theory")
- Each background_summary: 100-300 words
- current_status should mention the latest known results, with attribution

IMPORTANT: If the input is clearly not about mathematics (e.g. software engineering, cooking, politics, general life advice), set status to "insufficient" with detected_topics explaining why (e.g. ["Software Engineering - not a mathematical topic"]) and follow_up_suggestions asking for a mathematical problem (e.g. ["Please provide a mathematical problem, conjecture, or research direction."]).

Decision criteria:
- Determine the mathematical status of this problem based on your research. If it has been fully resolved, set math_status to SOLVED with solver details (solved_by, solved_year, solved_reference). If partially resolved, use PARTIALLY_SOLVED. If the claimed solution is disputed, use DISPUTED. Default to OPEN.
- Input contains a specific conjecture/theorem name → SINGLE
- Input contains a clear LaTeX statement → SINGLE
- Reference paper points to a single clear direction → SINGLE
- Input is broad (only field keywords) → MULTIPLE (list main open problems)
- Input is too vague (very few words, no direction) → INSUFFICIENT
- Reference papers span multiple directions → MULTIPLE
- Input is a well-known research program, grand research direction, or systematic collection of related problems → PROGRAM
- Input explicitly mentions "program", "纲领", or is a famous research agenda → PROGRAM
- Examples of PROGRAM inputs: "Langlands Program", "Hilbert's Problems", "Millennium Prize Problems", "Geometric Langlands", "Mori Program", "Weil Conjectures"

If status="program": include "program" object, omit "problem"/"candidates"/"detected_topics"/"follow_up_suggestions".
The "program" object:
{
  "title": "The Langlands Program",
  "description": "High-level description of the research program",
  "background_summary": "300-500 word background",
  "tags": ["Number Theory", "Representation Theory"],
  "sub_programs": [
    {
      "title": "Geometric Langlands",
      "description": "Sub-program description",
      "background_summary": "100-300 word background",
      "tags": ["Algebraic Geometry", "Representation Theory"],
      "core_projects": [
        { "title": "...", "formal_statement": "LaTeX...", "description": "...", "background_summary": "...", "tags": [...], "current_status": "...", "math_status": "OPEN" }
      ],
      "supporting_projects": [
        { "title": "...", "formal_statement": "LaTeX...", "description": "...", "background_summary": "...", "tags": [...], "current_status": "...", "math_status": "SOLVED" }
      ]
    }
  ],
  "core_projects": [
    {
      "title": "Local Langlands Correspondence",
      "formal_statement": "LaTeX...",
      "description": "...",
      "background_summary": "...",
      "tags": [...],
      "current_status": "...",
      "math_status": "SOLVED",
      "solved_by": "...",
      "solved_year": 2000
    }
  ],
  "supporting_projects": [
    {
      "title": "Trace Formula",
      "formal_statement": "LaTeX...",
      "description": "...",
      "background_summary": "...",
      "tags": [...],
      "current_status": "...",
      "math_status": "OPEN"
    }
  ],
  "dependencies": [
    { "from": "Local Langlands Correspondence", "to": "Trace Formula", "relation": "requires", "label": "..." }
  ]
}
sub_programs: 0-5 items (nested sub-programs for large research programs). Each sub-program can have its own core_projects and supporting_projects.
core_projects: 3-10 items (central open problems/theorems of the program).
supporting_projects: 2-8 items (foundational results, tools, or solved prerequisites).
dependencies use title strings (not indices). relation should be one of: "implies", "requires", "generalizes", "specializes", "inspires".

IMPORTANT for program status: Distribute projects across sub-programs intelligently. Each sub-program's core_projects and supporting_projects should contain the projects most relevant to that sub-program's scope. Root-level core_projects and supporting_projects should only contain projects that are cross-cutting or don't fit neatly into any sub-program. Do NOT put all projects at the root level — if sub-programs exist, most projects should belong to a sub-program.`;

// ========== LLM Response Parsing ==========

function parseLLMResponse(
  rawText: string,
  parsedRefs: ParsedReference[],
  emit: (event: PlanAgentEvent) => void
): PlanAgentResult {
  const jsonText = extractJSON(rawText);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Try to repair common JSON issues (trailing commas, truncated output)
    try {
      const repaired = jsonText
        .replace(/,\s*([}\]])/g, "$1")  // trailing commas
        .replace(/[\r\n]+/g, " ");      // newlines in strings
      parsed = JSON.parse(repaired);
    } catch {
      // Last resort: try extracting just the status and program/problem fields
      emit({
        type: "plan_progress",
        message: "Warning: LLM response was not valid JSON, attempting recovery...",
      });

      // Try regex recovery for program status
      const statusProgramMatch = rawText.match(/"status"\s*:\s*"program"/);
      const titleMatch = rawText.match(/"title"\s*:\s*"([^"]+)"/);
      if (statusProgramMatch && titleMatch) {
        return {
          status: "program",
          program: {
            title: titleMatch[1]!,
            description: "",
            backgroundSummary: "",
            tags: [],
            subPrograms: [],
            subProjects: [],
            dependencies: [],
          },
          parsedReferences: parsedRefs,
        };
      }

      return {
        status: "insufficient",
        detectedTopics: ["Parse Error"],
        suggestions: [
          "The AI model returned an unexpected format. Please retry.",
          `Raw response snippet: ${rawText.slice(0, 200)}...`,
        ],
        parsedReferences: parsedRefs,
      };
    }
  }

  // IMPL [unimpl-TODOS-P1-PARSE] Normalize status: previously "Program"/"PROGRAM"
  // (or whitespace) silently fell through to "insufficient" because of strict
  // case-sensitive ===. Trim + lowercase before matching.
  const status = String(parsed.status ?? "").trim().toLowerCase();

  if (status === "single" && parsed.problem) {
    const p = parsed.problem as Record<string, unknown>;
    // Merge top-level math_status/solved fields into problem (prompt puts them at top level)
    if (!p.math_status && !p.mathStatus && parsed.math_status) p.math_status = parsed.math_status;
    if (!p.solved_by && !p.solvedBy && parsed.solved_by) p.solved_by = parsed.solved_by;
    if (!p.solved_year && !p.solvedYear && parsed.solved_year) p.solved_year = parsed.solved_year;
    if (!p.solved_reference && !p.solvedReference && parsed.solved_reference) p.solved_reference = parsed.solved_reference;
    const problem = mapToFormalizedProblem(p);

    // Emit detected concepts from tags
    for (const tag of problem.tags) {
      emit({ type: "concept_detected", concept: tag });
    }

    return {
      status: "single",
      confirmedProblem: problem,
      parsedReferences: parsedRefs,
    };
  }

  if (status === "multiple" && Array.isArray(parsed.candidates)) {
    const candidates = (parsed.candidates as Record<string, unknown>[]).map(
      mapToFormalizedProblem
    );

    const allTags = new Set(candidates.flatMap((c) => c.tags));
    for (const tag of allTags) {
      emit({ type: "concept_detected", concept: tag });
    }

    return {
      status: "multiple",
      candidates,
      parsedReferences: parsedRefs,
    };
  }

  if (status === "program") {
    // LLM may nest program data under "program" key or put it at the top level
    const prog = (parsed.program ?? parsed) as Record<string, unknown>;

    // Parse sub-programs (new hierarchical format)
    const subProgramsRaw = Array.isArray(prog.sub_programs) ? (prog.sub_programs as Record<string, unknown>[]) : [];
    const subPrograms: ProgramPlan[] = subProgramsRaw.map((sp) => {
      // Parse sub-program's own projects
      const spCoreRaw = Array.isArray(sp.core_projects) ? (sp.core_projects as Record<string, unknown>[]) : [];
      const spSupportingRaw = Array.isArray(sp.supporting_projects) ? (sp.supporting_projects as Record<string, unknown>[]) : [];
      const spSubProjectsOld = Array.isArray(sp.sub_projects) ? (sp.sub_projects as Record<string, unknown>[]) : [];

      let spSubProjects: ProgramSubProject[];
      if (spCoreRaw.length > 0 || spSupportingRaw.length > 0) {
        spSubProjects = [
          ...spCoreRaw.map((p) => ({ ...mapToFormalizedProblem(p), role: "core" as const })),
          ...spSupportingRaw.map((p) => ({ ...mapToFormalizedProblem(p), role: "supporting" as const })),
        ];
      } else {
        spSubProjects = spSubProjectsOld.map((p) => {
          const base = mapToFormalizedProblem(p);
          const role = String(p.role ?? "related");
          const validRoles = ["core", "supporting", "related"];
          return { ...base, role: (validRoles.includes(role) ? role : "related") as ProgramSubProject["role"] };
        });
      }

      return {
        title: String(sp.title ?? "Untitled Sub-Program"),
        description: String(sp.description ?? ""),
        backgroundSummary: String(sp.background_summary ?? sp.backgroundSummary ?? ""),
        tags: Array.isArray(sp.tags) ? sp.tags.map(String) : [],
        subPrograms: [],
        subProjects: spSubProjects,
        dependencies: [],
      };
    });

    // Parse projects: new format (core_projects + supporting_projects) or old format (sub_projects)
    let subProjects: ProgramSubProject[];

    if (Array.isArray(prog.core_projects) || Array.isArray(prog.supporting_projects)) {
      // New format: separate core and supporting arrays
      const coreRaw = Array.isArray(prog.core_projects) ? (prog.core_projects as Record<string, unknown>[]) : [];
      const supportingRaw = Array.isArray(prog.supporting_projects) ? (prog.supporting_projects as Record<string, unknown>[]) : [];

      const coreProjects: ProgramSubProject[] = coreRaw.map((sp) => ({
        ...mapToFormalizedProblem(sp),
        role: "core" as const,
      }));
      const supportingProjects: ProgramSubProject[] = supportingRaw.map((sp) => ({
        ...mapToFormalizedProblem(sp),
        role: "supporting" as const,
      }));

      subProjects = [...coreProjects, ...supportingProjects];
    } else {
      // Backward compat: old sub_projects format with inline role
      const subProjectsRaw = Array.isArray(prog.sub_projects) ? (prog.sub_projects as Record<string, unknown>[]) : [];
      subProjects = subProjectsRaw.map((sp) => {
        const base = mapToFormalizedProblem(sp);
        const role = String(sp.role ?? "related");
        const validRoles = ["core", "supporting", "related"];
        return {
          ...base,
          role: (validRoles.includes(role) ? role : "related") as ProgramSubProject["role"],
        };
      });
    }

    // Parse dependencies: title-based (new) or index-based (old backward compat)
    const depsRaw = Array.isArray(prog.dependencies) ? (prog.dependencies as Record<string, unknown>[]) : [];
    const dependencies = depsRaw.map((d) => ({
      from: String(d.from ?? ""),
      to: String(d.to ?? ""),
      relation: String(d.relation ?? d.kind ?? "related"),
      label: d.label ? String(d.label) : undefined,
    }));

    const programPlan: ProgramPlan = {
      title: String(prog.title ?? "Untitled Program"),
      description: String(prog.description ?? ""),
      backgroundSummary: String(prog.background_summary ?? prog.backgroundSummary ?? ""),
      tags: Array.isArray(prog.tags) ? prog.tags.map(String) : [],
      subPrograms,
      subProjects,
      dependencies,
    };

    const allTags = new Set([...programPlan.tags, ...subProjects.flatMap((sp) => sp.tags)]);
    for (const tag of allTags) {
      emit({ type: "concept_detected", concept: tag });
    }

    return {
      status: "program",
      program: programPlan,
      parsedReferences: parsedRefs,
    };
  }

  // Defensive warning for unexpected status values
  if (status && !["single", "multiple", "program", "insufficient"].includes(status)) {
    emit({ type: "plan_progress", message: `Warning: unexpected status "${status}", treating as insufficient` });
  }

  // insufficient or fallback
  const detectedTopics = Array.isArray(parsed.detected_topics)
    ? (parsed.detected_topics as string[])
    : ["Mathematics"];

  const suggestions = Array.isArray(parsed.follow_up_suggestions)
    ? (parsed.follow_up_suggestions as string[])
    : ["Please provide a more specific math problem description"];

  for (const topic of detectedTopics) {
    emit({ type: "concept_detected", concept: topic });
  }

  return {
    status: "insufficient",
    detectedTopics,
    suggestions,
    parsedReferences: parsedRefs,
  };
}

function mapToFormalizedProblem(p: Record<string, unknown>): FormalizedProblem {
  const mathStatus = String(p.math_status ?? p.mathStatus ?? "OPEN");
  const validStatuses = ["OPEN", "PARTIALLY_SOLVED", "SOLVED", "DISPUTED"];
  return {
    title: String(p.title ?? "Untitled Problem"),
    formalStatement: String(p.formal_statement ?? p.formalStatement ?? ""),
    description: String(p.description ?? ""),
    backgroundSummary: String(
      p.background_summary ?? p.backgroundSummary ?? ""
    ),
    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    currentStatus: p.current_status
      ? String(p.current_status)
      : p.currentStatus
        ? String(p.currentStatus)
        : undefined,
    mathStatus: validStatuses.includes(mathStatus) ? mathStatus as FormalizedProblem["mathStatus"] : "OPEN",
    solvedBy: p.solved_by ? String(p.solved_by) : p.solvedBy ? String(p.solvedBy) : undefined,
    solvedYear: p.solved_year ? Number(p.solved_year) : p.solvedYear ? Number(p.solvedYear) : undefined,
    solvedReference: p.solved_reference ? String(p.solved_reference) : p.solvedReference ? String(p.solvedReference) : undefined,
    mscCodes: Array.isArray(p.msc_codes) ? p.msc_codes.map(String) : Array.isArray(p.mscCodes) ? (p.mscCodes as unknown[]).map(String) : undefined,
  };
}

// ========================================================================
//  Reference Resolution — Real APIs
// ========================================================================

async function resolveReferenceReal(input: string): Promise<ParsedReference> {
  const trimmed = input.trim();

  // Detect arXiv
  const arxivId = extractArxivId(trimmed);
  if (arxivId) {
    return fetchArxivMetadata(arxivId, trimmed);
  }

  // Detect DOI
  const doi = extractDOI(trimmed);
  if (doi) {
    return fetchDOIMetadata(doi, trimmed);
  }

  // Generic URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return fetchURLMetadata(trimmed);
  }

  return {
    originalInput: trimmed,
    type: "unknown",
    resolved: false,
  };
}

// ── arXiv ──

function extractArxivId(input: string): string | null {
  const match = input.match(/(?:arxiv[:\s]*)?(\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (match) return match[1]!;

  const oldMatch = input.match(
    /(?:arxiv[:\s]*)?([a-z\-]+\/\d{7})(?:v\d+)?/i
  );
  if (oldMatch) return oldMatch[1]!;

  return null;
}

async function fetchArxivMetadata(
  id: string,
  originalInput: string
): Promise<ParsedReference> {
  try {
    const apiUrl = `https://export.arxiv.org/api/query?id_list=${id}`;
    const response = await fetch(apiUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    const xml = await response.text();

    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entryMatch) {
      return {
        originalInput,
        type: "arxiv",
        resolved: false,
        url: `https://arxiv.org/abs/${id}`,
      };
    }
    const entry = entryMatch[1]!;

    // Title: second <title> in XML (first is feed title)
    const titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)];
    const title =
      titles.length >= 2
        ? titles[1]![1]!.replace(/\s+/g, " ").trim()
        : undefined;

    const authors = [...entry.matchAll(/<name>(.*?)<\/name>/g)].map(
      (m) => m[1]!
    );

    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const abstract = summaryMatch
      ? summaryMatch[1]!.replace(/\s+/g, " ").trim()
      : undefined;

    return {
      originalInput,
      type: "arxiv",
      resolved: true,
      title,
      authors,
      url: `https://arxiv.org/abs/${id}`,
      abstract,
    };
  } catch {
    return {
      originalInput,
      type: "arxiv",
      resolved: false,
      url: `https://arxiv.org/abs/${id}`,
    };
  }
}

// ── DOI ──

function extractDOI(input: string): string | null {
  const match = input.match(/(10\.\d{4,}\/[^\s]+)/);
  return match ? match[1]! : null;
}

async function fetchDOIMetadata(
  doi: string,
  originalInput: string
): Promise<ParsedReference> {
  try {
    const response = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    const data = (await response.json()) as {
      message?: {
        title?: string[];
        author?: Array<{ given?: string; family?: string }>;
        abstract?: string;
      };
    };

    const msg = data.message;
    if (!msg) throw new Error("No message in CrossRef response");

    return {
      originalInput,
      type: "doi",
      resolved: true,
      title: msg.title?.[0],
      authors: msg.author?.map(
        (a) => [a.given, a.family].filter(Boolean).join(" ")
      ),
      url: `https://doi.org/${doi}`,
      abstract: msg.abstract?.replace(/<[^>]*>/g, ""),
    };
  } catch {
    return {
      originalInput,
      type: "doi",
      resolved: false,
      url: `https://doi.org/${doi}`,
    };
  }
}

// ── Generic URL ──

const ALLOWED_FETCH_HOSTS = [
  "arxiv.org",
  "api.crossref.org",
  "api.semanticscholar.org",
  "doi.org",
  "en.wikipedia.org",
  "mathworld.wolfram.com",
];

async function fetchURLMetadata(url: string): Promise<ParsedReference> {
  try {
    const hostname = new URL(url).hostname;
    const isAllowedHost = ALLOWED_FETCH_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
    const timeoutMs = isAllowedHost ? 10_000 : 5_000;

    // For known hosts, use simple fetch; for others, also attempt meta extraction
    const response = await safeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Mathub/1.0; +https://mathub.dev)",
      },
      redirect: "follow",
    });
    const html = await response.text();

    // Extract <title>
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1]!.replace(/\s+/g, " ").trim()
      : undefined;

    // Extract og:title or meta title as fallback
    const ogTitleMatch = html.match(
      /<meta[^>]*property=["']og:title["'][^>]*content=["']([\s\S]*?)["']/i
    );
    const metaTitle = ogTitleMatch
      ? ogTitleMatch[1]!.replace(/\s+/g, " ").trim()
      : undefined;

    // Extract description from meta tags
    const descMatch =
      html.match(
        /<meta[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["']/i
      ) ??
      html.match(
        /<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i
      );
    const description = descMatch
      ? descMatch[1]!.replace(/\s+/g, " ").trim()
      : undefined;

    // Extract authors from meta tags (common in academic sites)
    const authorMatches = [
      ...html.matchAll(
        /<meta[^>]*name=["'](?:author|citation_author)["'][^>]*content=["']([\s\S]*?)["']/gi
      ),
    ];
    const authors =
      authorMatches.length > 0
        ? authorMatches.map((m) => m[1]!.trim())
        : undefined;

    return {
      originalInput: url,
      type: "url",
      resolved: true,
      title: metaTitle ?? title ?? hostname,
      authors,
      url,
      abstract: description,
    };
  } catch {
    return {
      originalInput: url,
      type: "url",
      resolved: false,
      url,
    };
  }
}

// ========== JobManager Integration ==========

/**
 * Run the plan agent pipeline within a JobManager context.
 * Consumes the SSE stream from createPlanAgentStream and maps events
 * to ctx.checkpoint / ctx.log / ctx.progress / ctx.emit.
 *
 * Returns the plan result.
 */
export async function runPlanWithJobContext(
  description: string,
  referenceLinks: string[],
  model: AzureModelId | undefined,
  ctx: JobContext,
): Promise<unknown> {
  await ctx.log("Starting plan generation...");
  await ctx.progress(5);

  const stream = createPlanAgentStream(description, referenceLinks, model, ctx.signal);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let planResult: unknown = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(trimmed.slice(6));

        if (event.type === "plan_phase") {
          await ctx.log(event.message ?? event.phase ?? "Processing...");
          await ctx.checkpoint(event.phase, event);
          ctx.emit(event);
        } else if (event.type === "plan_progress") {
          if (event.progress) await ctx.progress(event.progress);
          if (event.message) await ctx.log(event.message);
          ctx.emit(event);
        } else if (event.type === "plan_result") {
          planResult = event.result;
          await ctx.progress(100);
          ctx.emit(event);
        } else if (event.type === "error" || event.type === "plan_error") {
          throw new Error(event.message ?? "Unknown plan error");
        }
      } catch (e) {
        // Re-throw intentional errors
        if (e instanceof Error && e.message.includes("plan error")) {
          throw e;
        }
        // skip malformed events
      }
    }
  }

  return planResult;
}
