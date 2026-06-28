/**
 * Spine-First Architecture — LLM Prompts
 *
 * All prompts for the spine pipeline: node extraction, structure assembly,
 * effort document generation, and spine-driven wiki page generation.
 */

import type { NarrativeSpine, SpineNode, SpineThread, SpineOpenQuestion } from "./types.js";
import type { PaperRead } from "../../../paper-graph/types.js";

// ============================================================
//  Phase 1: Paper Relevance Scoring
// ============================================================

export function buildRelevanceScoringPrompt(
  papers: Array<{ id: string; title: string; authors: string[]; abstract?: string; year?: number }>,
  projectContext: { title: string; formalStatement: string; tags: string[] },
): string {
  const paperList = papers.map((p, i) =>
    `[${i}] "${p.title}" (${p.year ?? "?"}) by ${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? " et al." : ""}
   Abstract: ${(p.abstract ?? "").slice(0, 300)}...`
  ).join("\n\n");

  return `You are scoring papers for relevance to a mathematical research project.

PROJECT: ${projectContext.title}
STATEMENT: ${projectContext.formalStatement.slice(0, 500)}
TAGS: ${projectContext.tags.join(", ")}

PAPERS TO SCORE:
${paperList}

For each paper, score relevance 1-10:
- 1-3: Not relevant
- 4-5: Tangentially related
- 6-7: Directly relevant
- 8-10: Core to the problem

Output a JSON array:
[{"index": 0, "score": 8, "reason": "brief reason"}, ...]

Output ONLY valid JSON.`;
}

// ============================================================
//  Phase 2: Spine Node Extraction (per batch)
// ============================================================

export function buildNodeExtractionPrompt(
  papers: Array<{
    id: string;
    title: string;
    authors: string[];
    year?: number;
    abstract?: string;
    fullText?: string;
  }>,
  citations: Array<{
    citingId: string;
    citedId: string;
  }>,
  context: {
    projectTitle: string;
    formalStatement: string;
    existingNodeTitles: string[];
  },
): string {
  const paperDetails = papers.map((p) => {
    // 2026-06-26 (sync-upgrade P1-C) — when fullText is present (the
    // arxiv .tex source spliced in by spine builder), prefer it over
    // abstract and DO NOT truncate further; the upstream loader has
    // already capped per-paper / per-batch sizes.
    const text = p.fullText
      ? `LaTeX source (main .tex):\n${p.fullText}`
      : `Abstract: ${p.abstract ?? "(none)"}`;
    return `### Paper [${p.id}]: "${p.title}" (${p.year ?? "?"})
Authors: ${p.authors.slice(0, 5).join(", ")}
${text}`;
  }).join("\n\n");

  const citationInfo = citations.length > 0
    ? `\nCITATION RELATIONSHIPS IN THIS BATCH:\n${citations.map(c => `- [${c.citingId}] cites [${c.citedId}]`).join("\n")}\n`
    : "";

  const existingNodes = context.existingNodeTitles.length > 0
    ? `\nALREADY KNOWN CONTRIBUTIONS (do NOT duplicate these):\n${context.existingNodeTitles.map(t => `- ${t}`).join("\n")}\n`
    : "";

  return `You are extracting key mathematical contributions from a batch of papers about "${context.projectTitle}".

PROBLEM STATEMENT: ${context.formalStatement.slice(0, 500)}
${existingNodes}${citationInfo}
PAPERS IN THIS BATCH:
${paperDetails}

For each paper (or group of papers presenting the same result), extract the KEY CONTRIBUTION as a spine node. Not every paper deserves a node — only extract genuinely important results, techniques, or barriers.

For each node, provide:
- "id": a slug like "author-year-brief-description"
- "type": one of "foundation" | "milestone" | "technique_origin" | "refinement" | "barrier" | "bridge" | "dead_end" | "open_direction"
- "title": e.g., "Hardy (1914): Infinitely many zeros on the critical line"
- "year": integer
- "authors": array of key author names
- "statement": The PRECISE mathematical statement in LaTeX. Not a paraphrase — the actual theorem/bound/construction.
- "significance": 2-3 sentences explaining why this matters for the problem
- "proof_idea": 1-2 sentences on the key proof technique (optional)
- "paper_ids": array of paper IDs this node is derived from
- "depth": "foundational" | "major" | "incremental"
- "suggested_edges": array of connections to OTHER nodes (including existing ones):
  [{"target": "node-id-or-existing-id", "type": "enables|improves|generalizes|applies_technique|contradicts|reveals_barrier", "context": "one sentence"}]

Output JSON: {"nodes": [...]}
Output ONLY valid JSON.`;
}

// ============================================================
//  Phase 2: Spine Structure Assembly
// ============================================================

export function buildSpineAssemblyPrompt(
  candidates: Array<{
    id: string;
    type: string;
    title: string;
    year?: number;
    statement: string;
    significance: string;
    depth: string;
  }>,
  context: {
    projectTitle: string;
    formalStatement: string;
    tags: string[];
    existingSpine?: NarrativeSpine;
  },
): string {
  const candidateList = candidates.map((c) =>
    `- [${c.id}] (${c.type}, ${c.year ?? "?"}): ${c.title}
  Statement: ${c.statement.slice(0, 200)}...
  Significance: ${c.significance.slice(0, 150)}...
  Depth: ${c.depth}`
  ).join("\n\n");

  const existingContext = context.existingSpine
    ? `
EXISTING SPINE (incremental update — integrate new nodes into this structure):
Global thesis: ${context.existingSpine.globalThesis}
Eras: ${context.existingSpine.eras.map(e => `${e.name} (${e.nodeIds.length} nodes)`).join(", ")}
Threads: ${context.existingSpine.threads.map(t => `${t.name} [${t.status}] (${t.nodeIds.length} nodes)`).join(", ")}
Existing node IDs: ${context.existingSpine.nodes.map(n => n.id).join(", ")}
`
    : "";

  return `You are assembling a Narrative Spine for the mathematical problem "${context.projectTitle}".

PROBLEM: ${context.formalStatement.slice(0, 500)}
TAGS: ${context.tags.join(", ")}
${existingContext}
SPINE NODE CANDIDATES:
${candidateList}

Assemble these candidates into a complete Narrative Spine. The spine tells the story of this problem's research history.

CRITICAL — ERA NAMES ARE NARRATIVE ARCS, NOT DATE BRACKETS:
- Each era \`name\` MUST describe the intellectual move the era represents — what changed in how researchers attacked the problem.
- BAD names: "1920-1973", "Modern era (2000-2020)", "Early period", "Sieve era 1950-1970".
- GOOD names: "First-wave combinatorial sieve", "Large-sieve breakthrough and dispersion", "Circle-method ternary breakthrough", "Post-Helfgott computational frontier", "Parity-barrier era".
- The (start_year-end_year) bracket is a SEPARATE field; DO NOT duplicate it in \`name\`.
- A reader who only sees the era names should already learn the methodological story.

Same principle for THREAD names: name the research move, not the topic ("Sieve approach to 1+2", "Bombieri-Vinogradov-style mean values for moduli"), not noun-clumps ("Sieve methods", "Distribution of primes").

Output a JSON object with this EXACT structure:
{
  "global_thesis": "One sentence capturing the central tension/story of this problem",
  "eras": [
    {
      "name": "Narrative arc name describing the intellectual move (NO date bracket)",
      "start_year": 1859,
      "end_year": 1950,
      "summary": "What changed in this era — what move the field made (2-3 sentences)",
      "node_ids": ["node-id-1", "node-id-2"]
    }
  ],
  "edges": [
    {
      "from": "node-id-1",
      "to": "node-id-2",
      "type": "enables|improves|generalizes|applies_technique|contradicts|reveals_barrier",
      "context": "One sentence explaining the connection"
    }
  ],
  "threads": [
    {
      "id": "thread-slug",
      "name": "Research thread name describing the intellectual move (verb-first if possible)",
      "description": "What this line of research pursues (1-2 sentences)",
      "node_ids": ["node-id-1", "node-id-3"],
      "status": "active|stalled|converged|dead_end",
      "current_frontier": "Best known result on this thread (LaTeX)",
      "barrier": "What blocks further progress (if stalled/converged)"
    }
  ],
  "open_questions": [
    {
      "title": "Open Question Title",
      "statement": "Precise mathematical statement in LaTeX",
      "related_node_ids": ["node-id-1"],
      "barrier": "What's blocking a solution",
      "partial_progress": "Known partial results"
    }
  ]
}

RULES:
- Every candidate node must appear in at least one era and at least one thread
- Eras must be in chronological order
- Thread node_ids must be in chronological order
- Edges should capture the most important relationships (not every pair)
- Threads should capture distinct research directions, not just group by era
${context.existingSpine ? "- INCREMENTAL MODE: preserve existing eras/threads/edges, add new nodes into them or create new eras/threads as needed" : ""}

Output ONLY valid JSON.`;
}

// ============================================================
//  Phase 3: Effort Document Generation (per spine node)
// ============================================================

export function buildEffortDocumentPrompt(
  node: SpineNode,
  papers: Array<{ title: string; authors: string[]; year?: number; abstract?: string; fullText?: string }>,
  spineContext: {
    era?: string;
    threadName?: string;
    predecessors: Array<{ title: string; context: string }>;
    successors: Array<{ title: string; context: string }>;
  },
  problemTitle: string,
): string {
  const paperDetails = papers.map((p) => {
    const text = p.fullText
      ? `LaTeX source (main .tex):\n${p.fullText}`
      : `Abstract: ${p.abstract ?? "(none)"}`;
    return `### "${p.title}" (${p.year ?? "?"})
Authors: ${p.authors.slice(0, 5).join(", ")}
${text}`;
  }).join("\n\n");

  const predecessorText = spineContext.predecessors.length > 0
    ? `\nPREDECESSORS (what this builds on):\n${spineContext.predecessors.map(p => `- ${p.title}: ${p.context}`).join("\n")}\n`
    : "";

  const successorText = spineContext.successors.length > 0
    ? `\nSUCCESSORS (what builds on this):\n${spineContext.successors.map(s => `- ${s.title}: ${s.context}`).join("\n")}\n`
    : "";

  return `Write a detailed technical document for a workspace effort about "${node.title}" in the context of "${problemTitle}".

SPINE CONTEXT:
- Era: ${spineContext.era ?? "unknown"}
- Research thread: ${spineContext.threadName ?? "general"}
- Node type: ${node.type}
- Significance: ${node.significance}
- Key statement: ${node.statement}
${predecessorText}${successorText}
SOURCE PAPERS:
${paperDetails}

Write a thorough markdown document that a working mathematician could use as a reference. It MUST include:

1. **Precise Setup**: Define the mathematical objects, notation, and standing assumptions.
2. **Main Results**: State every key theorem/lemma with FULL LaTeX — all quantifiers, conditions, bounds.
3. **Proof Strategy**: Outline the proof in concrete steps. For each step, state what tool is used and why.
4. **Historical Development**: When was this introduced? By whom? How has it evolved?
5. **Why This Approach**: What is the conceptual insight? What motivates it?
6. **Technical Dependencies**: List prerequisite results with precise statements.
7. **Limitations & Barriers**: Where exactly does this approach break down? What is the quantitative boundary?

Use LaTeX extensively ($...$ inline, $$...$$ display). Write at survey-article level.

Output ONLY the markdown document, no JSON wrapping.`;
}

// ============================================================
//  Phase 3: Thread Survey Document Generation
// ============================================================

export function buildThreadDocumentPrompt(
  thread: SpineThread,
  nodes: SpineNode[],
  papers: Array<{ title: string; authors: string[]; year?: number; abstract?: string }>,
  problemTitle: string,
): string {
  const nodeList = nodes.map((n) =>
    `- [${n.year ?? "?"}] ${n.title}: ${n.statement.slice(0, 200)}...`
  ).join("\n");

  return `Write a comprehensive survey document for the research direction "${thread.name}" in the context of "${problemTitle}".

THREAD DESCRIPTION: ${thread.description}
STATUS: ${thread.status}
${thread.currentFrontier ? `CURRENT FRONTIER: ${thread.currentFrontier}` : ""}
${thread.barrier ? `BARRIER: ${thread.barrier}` : ""}

KEY MILESTONES (chronological):
${nodeList}

Write a markdown survey (1000-2000 words) tracing this research direction from its origins to the present. For each milestone:
- State the precise result in LaTeX
- Explain how it improved over the previous best
- Describe the key technique

End with the current state and open challenges.
Use LaTeX extensively. Write at survey-article level.

Output ONLY the markdown document.`;
}

// ============================================================
//  Phase 4: Spine-Driven Wiki Page Generation
// ============================================================

export function buildOverviewFromSpinePrompt(
  problem: { title: string; formalStatement: string; description: string; tags: string[] },
  spine: NarrativeSpine,
  mathStatus?: string,
): string {
  const eraDetails = spine.eras.map((era) => {
    const eraNodes = era.nodeIds
      .map((id) => spine.nodes.find((n) => n.id === id))
      .filter(Boolean) as SpineNode[];
    const milestones = eraNodes.map((n) =>
      `  - ${n.title} (${n.year ?? "?"}): ${n.statement.slice(0, 200)}
    Significance: ${n.significance.slice(0, 150)}`
    ).join("\n");
    return `### ${era.name}
${era.summary}
MILESTONES:
${milestones}`;
  }).join("\n\n");

  const threadSummaries = spine.threads.map((t) =>
    `- **${t.name}** [${t.status}]: ${t.description}${t.currentFrontier ? ` Current best: ${t.currentFrontier.slice(0, 100)}` : ""}`
  ).join("\n");

  return `You are writing the Overview wiki page for "${problem.title}" on Mathub.

## Problem
Title: ${problem.title}
Formal Statement: ${problem.formalStatement}
Description: ${problem.description}
Status: ${mathStatus ?? "OPEN"}

## Narrative Spine
Global thesis: ${spine.globalThesis}

## Eras and Milestones
${eraDetails}

## Research Threads
${threadSummaries}

## Instructions
Write a detailed overview with these EXACT sections:

1. **Problem Statement**: The precise formal statement with ALL quantifiers in full LaTeX.
2. **Historical Development**: A narrative tracing the problem through each era. For each milestone from the spine, include who, when, what they proved (use the precise statements above), and how it changed research direction.
3. **Relationship to the Broader Landscape**: Connections to other conjectures/theories.
4. **Current State of the Art**: Best known results with exact bounds in LaTeX.
5. **Proof Strategy Overview**: For solved problems, outline the proof architecture. For open, outline the most promising threads and where they get stuck.

CRITICAL: Use the precise mathematical statements from the spine nodes. Do NOT paraphrase them into vagueness.
Cross-reference workspace efforts using [claim text](@ws:effort-id) links.
Start with: > [AI-GENERATED] This content was automatically generated and requires human review.

Output ONLY the markdown content.`;
}

export function buildKeyResultsFromSpinePrompt(
  problem: { title: string; formalStatement: string },
  timelineNodes: SpineNode[],
  spine: NarrativeSpine,
): string {
  const entries = timelineNodes.map((n) => {
    const era = spine.eras.find((e) => e.nodeIds.includes(n.id));
    return `### ${n.title}
- Year: ${n.year ?? "unknown"}
- Era: ${era?.name ?? "unknown"}
- Type: ${n.type}
- Statement: ${n.statement}
- Significance: ${n.significance}
${n.proofIdea ? `- Proof idea: ${n.proofIdea}` : ""}
- Paper IDs: ${n.paperIds.join(", ")}`;
  }).join("\n\n");

  return `You are writing the "Key Results & Timeline" wiki page for "${problem.title}" on Mathub.

PROBLEM: ${problem.formalStatement.slice(0, 500)}

CHRONOLOGICAL SPINE NODES (your content source):
${entries}

Write a detailed chronicle ordered by time. For EACH entry above:
- **Precise theorem statement** in full LaTeX (use the statement from above, expand it)
- **Authors and year**
- **Proof technique**: 2-3 sentence explanation of the key idea
- **Improvement over prior work**: What was previous best, how does this improve it?
- **Significance**: New method? Settled a conjecture? Opened a direction?

Include ALL quantitative bounds. A reader should trace the evolution of best known constants through the timeline.
Start with: > [AI-GENERATED] This content was automatically generated and requires human review.

Output ONLY the markdown content.`;
}

export function buildTechniquesFromSpinePrompt(
  problem: { title: string; formalStatement: string },
  threads: SpineThread[],
  spine: NarrativeSpine,
): string {
  const threadDetails = threads.map((t) => {
    const threadNodes = t.nodeIds
      .map((id) => spine.nodes.find((n) => n.id === id))
      .filter(Boolean) as SpineNode[];
    const nodeList = threadNodes.map((n) =>
      `  - ${n.title}: ${n.statement.slice(0, 300)}
    ${n.proofIdea ? `Proof idea: ${n.proofIdea}` : ""}`
    ).join("\n");
    return `### Thread: ${t.name}
Description: ${t.description}
Status: ${t.status}
${t.currentFrontier ? `Current frontier: ${t.currentFrontier}` : ""}
${t.barrier ? `Barrier: ${t.barrier}` : ""}
Key milestones:
${nodeList}`;
  }).join("\n\n");

  return `You are writing the "Technical Methods" wiki page for "${problem.title}" on Mathub.

PROBLEM: ${problem.formalStatement.slice(0, 500)}

RESEARCH THREADS (each becomes a major section):
${threadDetails}

Write a technical exposition. Each thread becomes a ## section. For each technique within a thread:

1. **Mathematical Setup**: Define notation, spaces, objects.
2. **Key Lemmas & Theorems**: Full LaTeX — all quantifiers, conditions, bounds.
3. **Proof Sketch**: Walk through the main argument step by step.
4. **Motivation**: What is the conceptual insight? Why this approach?
5. **Historical Evolution**: From original to current best form.
6. **Limitations & Barriers**: Where does it break down? Exact quantitative boundary.
7. **Connections**: How does it relate to other threads?

ANTI-VAGUENESS: Never write "X used Y technique" without explaining HOW and WHY.
Start with: > [AI-GENERATED] This content was automatically generated and requires human review.

Output ONLY the markdown content.`;
}

export function buildOpenProblemsFromSpinePrompt(
  problem: { title: string; formalStatement: string },
  openQuestions: SpineOpenQuestion[],
  barrierNodes: SpineNode[],
): string {
  const questionDetails = openQuestions.map((q) =>
    `### ${q.title}
Statement: ${q.statement}
Barrier: ${q.barrier}
Partial progress: ${q.partialProgress}
Related nodes: ${q.relatedNodeIds.join(", ")}`
  ).join("\n\n");

  const barrierDetails = barrierNodes.map((n) =>
    `- ${n.title}: ${n.statement.slice(0, 200)} — Significance: ${n.significance.slice(0, 150)}`
  ).join("\n");

  return `You are writing the "Open Problems" wiki page for "${problem.title}" on Mathub.

PROBLEM: ${problem.formalStatement.slice(0, 500)}

OPEN QUESTIONS FROM SPINE:
${questionDetails}

KNOWN BARRIERS:
${barrierDetails}

For each open question:
1. **Exact Conjecture Statement**: Full LaTeX with all quantifiers.
2. **Partial Progress**: Best partial results with precise bounds.
3. **Technical Barriers**: What SPECIFIC obstruction prevents current methods? Be concrete.
4. **Possible Approaches**: What strategies might work? What analogies suggest themselves?
5. **Quantitative Targets**: What numerical improvement would constitute progress?

Start with: > [AI-GENERATED] This content was automatically generated and requires human review.

Output ONLY the markdown content.`;
}

export function buildBibliographyFromSpinePrompt(
  problem: { title: string },
  papers: Array<{ title: string; authors: string[]; year?: number; arxivId?: string; url?: string }>,
  spine: NarrativeSpine,
): string {
  const paperList = papers.map((p) =>
    `- ${p.authors.slice(0, 5).join(", ")}${p.authors.length > 5 ? " et al." : ""} (${p.year ?? "?"}). "${p.title}". ${p.arxivId ? `arXiv:${p.arxivId}` : ""}${p.url && !p.arxivId ? p.url : ""}`
  ).join("\n");

  return `Compile a bibliography for "${problem.title}" on Mathub.

PAPERS (from paper graph):
${paperList}

SPINE THREADS: ${spine.threads.map(t => t.name).join(", ")}

Group by: Primary Papers (directly about the problem), Foundational References (key prerequisites), Related Work (techniques/analogies from other areas), Survey Articles.
Use standard academic citation format. Include arXiv IDs where available.
Start with: > [AI-GENERATED] This content was automatically generated and requires human review.

Output ONLY the markdown content.`;
}

// ============================================================
//  v3: Spine from PaperReads (high-density distillations)
// ============================================================
//
// These prompts replace raw-.tex node extraction with the agent's own
// multi-pass PaperRead distillations. The crucial property is that
// SpineNode.statement is taken VERBATIM from PaperReadMainResult.statement
// (the read pass already captured it with no `\cdots` truncation); the
// LLM only chooses WHICH statement and HOW to organize — it never
// re-types or paraphrases the LaTeX. The extraction prompt asks the model
// to echo `sourcePaperId` + `sourceResultLabel` so the caller can splice
// the verbatim statement back in from the read corpus.

export function buildSpineNodeExtractionFromReadsPrompt(
  problem: { title: string; formalStatement: string; mathStatus?: string },
  reads: PaperRead[],
): string {
  const readDetails = reads.map((r) => {
    const body = r.read;
    const mainResults = (body?.mainResults ?? []).map((m, i) =>
      `    [result ${i}] label="${m.label}" (where: ${m.whereInPaper})
      statement: ${m.statement}
      noveltyVsPrior: ${m.noveltyVsPrior}`
    ).join("\n");
    const techniques = (body?.keyTechniques ?? []).map((t) => t.name).join(", ");
    const deps = (body?.technicalDependencies ?? [])
      .map((d) => `${d.claim} (${d.source})`)
      .join("; ");
    return `### Paper [${r.paperId}] — role: ${body?.role ?? "unknown"}
One-line: ${r.skim.oneLineSummary}
Main contribution: ${r.skim.mainContribution}
Main results (statements are VERBATIM — copy exactly, do not edit):
${mainResults || "    (none extracted)"}
Proof strategy: ${body?.proofStrategy ?? "(none)"}
Novel contributions: ${body?.novelContributions ?? "(none)"}
Key techniques: ${techniques || "(none)"}
Technical dependencies: ${deps || "(none)"}`;
  }).join("\n\n");

  return `You are extracting Narrative-Spine nodes from a corpus of carefully-read papers about "${problem.title}".

PROBLEM STATEMENT: ${problem.formalStatement.slice(0, 800)}
STATUS: ${problem.mathStatus ?? "OPEN"}

Each paper below comes with its MAIN RESULTS already transcribed verbatim from the source (no truncation, full LaTeX). Your job is to decide which results deserve to be spine nodes and to classify/connect them.

PAPERS (read distillations):
${readDetails}

For each genuinely important result, technique, or barrier, emit ONE spine node. Not every paper needs a node; group papers that present the same result.

CRITICAL — VERBATIM STATEMENTS:
- Do NOT paraphrase, shorten, or "clean up" any mathematical statement.
- For "statement", copy the EXACT statement string from the relevant "[result i]" above.
- ALSO set "sourcePaperId" to that paper's id and "sourceResultLabel" to that result's label, so the statement can be verified. If a node summarizes a non-theorem contribution with no precise statement, set "statement" to "" and omit the source fields.

For each node, provide:
- "id": a slug like "author-year-brief-description"
- "type": one of "foundation" | "milestone" | "technique_origin" | "refinement" | "barrier" | "bridge" | "dead_end" | "open_direction"
- "title": e.g., "Hardy (1914): Infinitely many zeros on the critical line"
- "year": integer (if known)
- "authors": array of key author names
- "statement": the VERBATIM LaTeX statement copied from above
- "sourcePaperId": the paper id the statement was copied from
- "sourceResultLabel": the result label the statement was copied from
- "significance": 2-3 sentences on why this matters for the problem
- "proof_idea": 1-2 sentences on the key proof technique (optional)
- "paper_ids": array of paper ids this node derives from
- "depth": "foundational" | "major" | "incremental"
- "suggested_edges": [{"target": "node-id", "type": "enables|improves|generalizes|applies_technique|contradicts|reveals_barrier", "context": "one sentence"}]

Output JSON: {"nodes": [...]}
Output ONLY valid JSON.`;
}

export function buildSpineAssemblyFromReadsPrompt(
  problem: { title: string; formalStatement: string },
  candidateNodes: Array<{ id: string; title: string; year?: number; type: string; depth: string }>,
  surveyStructuralPriors: Array<{ surveyTitle: string; outline: string[] }>,
): string {
  const candidateList = candidateNodes.map((c) =>
    `- [${c.id}] (${c.type}, ${c.year ?? "?"}, depth=${c.depth}): ${c.title}`
  ).join("\n");

  const priors = surveyStructuralPriors.length > 0
    ? `\nExisting surveys consulted for structural prior:\n${surveyStructuralPriors
        .map((s) => `  - "${s.surveyTitle}" divides this field into: ${s.outline.length > 0 ? s.outline.join(" | ") : "(no outline captured)"}`)
        .join("\n")}\nYou MAY use these as priors when grouping nodes into threads, but override them when the corpus suggests a better organization.\n`
    : "";

  return `You are assembling a Narrative Spine for the mathematical problem "${problem.title}".

PROBLEM: ${problem.formalStatement.slice(0, 800)}
${priors}
SPINE NODES (already extracted — organize these, do not invent new statements):
${candidateList}

Organize these nodes into the structural story of the problem.

CRITICAL — ERA NAMES ARE NARRATIVE ARCS, NOT DATE BRACKETS:
- Each era \`name\` MUST describe the intellectual move the era represents.
- BAD names: "1920-1973", "Modern era", "Sieve era 1950-1970".
- GOOD names: "First-wave combinatorial sieve", "Large-sieve breakthrough and dispersion", "Circle-method ternary breakthrough".
- The (start_year-end_year) bracket is a SEPARATE field; DO NOT duplicate it in \`name\`.
- A reader who only sees the era names should already learn the methodological story.

Same principle for THREAD names: name the research move, not the topic.

Output a JSON object with this EXACT structure:
{
  "global_thesis": "One sentence capturing the central tension/story of this problem",
  "eras": [
    { "name": "Narrative arc describing the intellectual move (NO date bracket)", "start_year": 1859, "end_year": 1950, "summary": "What move the field made (2-3 sentences)", "node_ids": ["node-id-1"] }
  ],
  "edges": [
    { "from": "node-id-1", "to": "node-id-2", "type": "enables|improves|generalizes|applies_technique|contradicts|reveals_barrier", "context": "One sentence" }
  ],
  "threads": [
    { "id": "thread-slug", "name": "Research thread name describing the intellectual move", "description": "What this line pursues (1-2 sentences)", "node_ids": ["node-id-1"], "status": "active|stalled|converged|dead_end", "current_frontier": "Best known result (LaTeX)", "barrier": "What blocks progress" }
  ],
  "open_questions": [
    { "title": "Open Question Title", "statement": "Precise statement in LaTeX", "related_node_ids": ["node-id-1"], "barrier": "What's blocking", "partial_progress": "Known partial results" }
  ]
}

RULES:
- Every node id must appear in at least one era and at least one thread.
- Eras in chronological order; thread node_ids in chronological order.
- Edges capture the most important relationships (not every pair).
- Threads capture distinct research directions, not just eras.

Output ONLY valid JSON.`;
}
