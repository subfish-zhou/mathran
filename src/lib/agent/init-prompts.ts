/**
 * Prompt templates for the Initialization Agent LLM calls.
 */

import type {
  CrawledResource,
  WikiPageOutput,
  VerificationIssue,
  WorkspaceResult,
  SourceCorpusEntry,
  NarrativeOutline,
  CitationEntry,
} from "./init-types";

export function buildConceptExtractionPrompt(
  problem: { title: string; formalStatement: string; description: string; backgroundSummary: string; tags: string[] },
  papers: CrawledResource[],
  wikiSummary?: string | null
): string {
  const paperList = papers
    .slice(0, 10)
    .map((p) => `- "${p.title}" by ${p.authors.join(", ")}${p.abstract ? ` — ${p.abstract.slice(0, 200)}` : ""}`)
    .join("\n");

  const wikiSection = wikiSummary
    ? `\n## Wikipedia Context\n${wikiSummary.slice(0, 1000)}\n`
    : "";

  return `You are a mathematical research assistant specializing in identifying key concepts and generating search queries.

Given the following mathematical problem and initial papers, extract the core mathematical concepts and generate search queries for deeper research.

## Problem
Title: ${problem.title}
Formal Statement: ${problem.formalStatement}
Description: ${problem.description}
Background: ${problem.backgroundSummary}
Tags: ${problem.tags.join(", ")}
${wikiSection}
## Initial Papers Found
${paperList || "(none yet)"}

## Output Requirements
Output a JSON object with:
1. "concepts": array of objects with "name" (string) and "importance" (0-1 float)
   - Include: mathematical objects, techniques, theorems, conjectures mentioned
   - Importance: 1.0 = central to the problem, 0.5 = related, 0.3 = peripheral
2. "search_queries": array of 3-8 search query strings for arXiv
   - Focus on specific mathematical terms, not generic phrases
   - Include: key techniques, related conjectures, important authors' methods
   - Queries should target specific mathematical objects, theorems, techniques, and author names. Examples: "Bombieri-Vinogradov theorem level of distribution", "Goldston-Pintz-Yildirim sieve DHL". NOT generic phrases like "prime numbers".
   - Example format: "Kakeya conjecture Hausdorff dimension", "incidence geometry finite field"

Output ONLY valid JSON, no markdown formatting.`;
}

export function buildWSAnalysisPrompt(
  problem: { title: string; formalStatement: string; description: string; backgroundSummary: string; tags: string[] },
  resources: CrawledResource[],
  fullTexts?: Map<string, string>
): string {
  const resourceList = resources
    .slice(0, 15)
    .map((r, i) => {
      let entry = `[${i + 1}] "${r.title}" (${r.authors.slice(0, 2).join(", ")}${r.authors.length > 2 ? " et al." : ""}, ${r.year ?? "?"})`;
      const ft = fullTexts?.get(r.id);
      if (ft) {
        entry += `\n    Full text excerpt: ${ft}`;
      }
      return entry;
    })
    .join("\n");

  return `Analyze the mathematical problem and create structured knowledge items. You are writing for an audience of working mathematicians and advanced graduate students.

Problem: ${problem.title}
Statement: ${problem.formalStatement}
Background: ${problem.backgroundSummary}

Papers found (${resources.length}):
${resourceList}

Create as many method efforts as needed to fully cover the problem (NOT reference efforts). Each effort should represent a distinct technique, approach, reduction, estimate, or barrier.

Classify approaches:
- "core": directly attacks the problem
- "method_group": shared technique used by multiple approaches
- "background": supporting theory or context

IMPORTANT: "type" and "status" are separate fields.
- type must be one of: CONSTRUCTION | ESTIMATE | PROOF_ATTEMPT | REDUCTION | COMPUTATION | FORMALIZATION | AUXILIARY
- status must be one of: VERIFIED | DRAFT | DEAD_END | REFERENCE | ERRATUM
- For a known dead-end approach, use type=PROOF_ATTEMPT + status=DEAD_END (NOT type=DEAD_END)
- For an approach with known errors, use status=ERRATUM with erratum_reason
- For reference/survey material, use status=REFERENCE

For each method item, provide rich detail:
- "document": A thorough markdown document that a working mathematician could use as a reference. It MUST include:
  1. **Precise Setup**: Define the mathematical objects, notation, and standing assumptions. State the exact problem this effort addresses.
  2. **Main Results**: State every key theorem/lemma with FULL LaTeX — all quantifiers, all conditions. Not "X proved a bound" but "X proved that for all primes $p > p_0$, we have $\\|f\\|_p \\leq C p^{-\\delta}$ where $\\delta = ...$"
  3. **Proof Strategy**: Outline the proof in concrete steps. For each step, state what tool/lemma is used and why. Not "using sieve methods" but "Apply a Selberg sieve with sifting level $z = x^{1/4}$ to the set $\\mathcal{A} = \\{n \\leq x : n \\equiv a \\pmod{q}\\}$, exploiting that..."
  4. **Historical Development**: Who introduced this technique? For what original purpose? How has it evolved? Key milestones with dates and authors.
  5. **Why This Approach**: What is the conceptual insight? Why would one think to apply this tool to this problem? What analogy or structural observation motivates it?
  6. **Technical Dependencies**: List prerequisite results with precise statements, not just names. Not "uses the large sieve" but "uses the large sieve inequality: $\\sum_{q \\leq Q} \\sum_{a \\pmod{q}}^* |S(a/q)|^2 \\leq (N + Q^2) \\sum |a_n|^2$"
  7. **Limitations & Barriers**: Where exactly does this approach break down? What is the precise obstruction? Is it a "parity barrier", a "convexity bound", a "square-root cancellation limit"? State the quantitative boundary.
  Use LaTeX extensively. Write at the level of a survey article in a research journal.
- "subject": The specific mathematical object/claim targeted (e.g., "Lemma 3.2 of [Alavi et al.]", "$I(T;x)$ real-rootedness for caterpillar trees")
- "tags": Array of 2-5 keyword tags (e.g., ["unimodality", "log-concavity", "independence-polynomial"])
- "difficulty_estimate": One of "ROUTINE" | "MODERATE" | "HARD" | "VERY_HARD"
- "narrative_role": One of "background" | "core_technique" | "application" | "generalization" | "open_direction" | "dead_end" — describes this effort's role in the overall narrative of the problem

If a method/effort depends on results from a different mathematical problem outside the scope of this project, include a note in the description: "⚠️ External dependency: [name of the external problem/result]"

Output JSON (method items ONLY, no dependency edges):
{"method_items":[{"id":"slug-id","type":"CONSTRUCTION|ESTIMATE|PROOF_ATTEMPT|REDUCTION|COMPUTATION","title":"Title","description":"Detailed description covering the mathematical content, key results, and significance","document":"Full document following the 7-point structure above","subject":"specific target","tags":["tag1","tag2"],"difficulty_estimate":"ROUTINE|MODERATE|HARD|VERY_HARD","status":"VERIFIED|DRAFT|DEAD_END|REFERENCE|ERRATUM","dead_end_reason":"only when status=DEAD_END","erratum_reason":"only when status=ERRATUM","classification":"core|method_group|background","narrative_role":"background|core_technique|application|generalization|open_direction|dead_end"}]}

Output ONLY valid JSON, no markdown.`;
}

export function getMathStatusEmphasis(status: string): string {
  switch (status) {
    case "SOLVED":
      return "This problem has been SOLVED. Emphasize: proof history, key breakthroughs, proof outline, impact on the field, generalizations and extensions.";
    case "OPEN":
      return "This problem is OPEN. Emphasize: partial results, promising methods, known obstacles, attack vectors and strategies.";
    case "PARTIALLY_SOLVED":
      return "This problem is PARTIALLY SOLVED. Emphasize: which cases are solved, remaining open cases, comparison of methods across solved/unsolved cases.";
    case "DISPUTED":
      return "This problem's solution is DISPUTED. Emphasize: the controversy, known gaps in claimed proofs, different viewpoints and critiques.";
    default:
      return "Provide balanced coverage of known results and open questions.";
  }
}

export function buildSinglePagePrompt(
  problem: { title: string; formalStatement: string; description: string; backgroundSummary: string; tags: string[]; currentStatus?: string; mathStatus?: string; solvedBy?: string; solvedYear?: number; solvedReference?: string },
  workspace: WorkspaceResult,
  spec: { slug: string; title: string; instruction: string },
  mathStatus?: string,
  allPageTitles?: string[],
  outline?: NarrativeOutline,
  previousPages?: Array<{ title: string; summary: string }>
): string {
  const methodItems = workspace.efforts
    .filter((i) => i.type !== "REFERENCE")
    .map((i) => {
      let line = `- @ws:${i.id} "${i.title}" (${i.type}, ${i.status}): ${i.description}`;
      const doc = (i as { document?: string }).document;
      if (doc) line += `\n  Document:\n${doc}`;
      return line;
    })
    .join("\n");

  const refItems = workspace.efforts
    .filter((i) => i.type === "REFERENCE")
    .slice(0, 15)
    .map((i) => `- @ws:${i.id} "${i.title}" (${i.sources?.[0]?.year ?? "?"}): ${i.description}`)
    .join("\n");

  return `You are a mathematical wiki writer for the Mathub platform.

## Problem
Title: ${problem.title}
Formal Statement: ${problem.formalStatement}
Description: ${problem.description}
Background: ${problem.backgroundSummary}
Current Status: ${problem.currentStatus ?? "Unknown"}
Math Status: ${mathStatus ?? problem.mathStatus ?? "OPEN"}${problem.solvedBy ? `\nSolved By: ${problem.solvedBy}` : ""}${problem.solvedYear ? `\nSolved Year: ${problem.solvedYear}` : ""}${problem.solvedReference ? `\nSolution Reference: ${problem.solvedReference}` : ""}

## Status-Specific Emphasis
${getMathStatusEmphasis(mathStatus ?? problem.mathStatus ?? "OPEN")}

## Workspace Efforts (Methods & Results)
${methodItems || "(none)"}

## References
${refItems || "(none)"}

## Page to Write
Title: ${spec.title}
Slug: ${spec.slug}

## Instructions
${spec.instruction}

## Writing Rules
- Start with: > [AI-GENERATED] This content was automatically generated and requires human review.
- Use LaTeX: $...$ inline, $$...$$ display
- Cross-reference workspace efforts using natural hyperlinks. Every mathematical claim must be a clickable link to its source.
- Format: [the actual claim or citation](@ws:effort-id#anchor) where anchor points to the specific location
- For theorems/lemmas: [Theorem statement](@ws:effort-id#thm-n)
- For equations referenced from efforts: add superscript after display math: <sup>[source](@ws:effort-id#eq-label)</sup>
- For literature references: [Author, Year](@ws:effort-slug) as natural inline citations
- The link text should be meaningful - either the claim itself or a standard citation like [Zhang, 2014]
- NEVER show bare @ws: syntax to the reader - everything must be a clickable hyperlink
- Use ## headers for sections
- Write for an audience of working mathematicians and graduate students in the field. Assume the reader has standard graduate-level background. Do not simplify or omit technical details for accessibility.
- Every key mathematical claim, result, or theorem should cite its source using [descriptive text](@ws:effort-id#anchor) links with precise anchors
- Include precise theorem statements, proof sketches or outlines where appropriate, key lemmas with their statements, and explicit references to specific results in the literature.
- When discussing bounds or estimates, state the exact values with full mathematical notation.

## Anti-Vagueness Rules (CRITICAL)
- NEVER write "X used Y technique" without explaining HOW Y was applied and WHY it works here.
- NEVER write "the key insight is..." without stating the precise mathematical content of that insight.
- NEVER mention a tool (sieve, deformation theory, L-function, etc.) without defining its setup in this specific context.
- NEVER say "improved the bound" without stating both the old bound and the new bound in full LaTeX.
- NEVER write "under certain conditions" — state the exact conditions.
- If an effort's document contains precise theorems, lemmas, or proof outlines, INCORPORATE them into the wiki page — do not summarize them into vagueness.

## WikiLink Syntax
When referencing other wiki pages in this project, use [[PageTitle]] syntax.
When referencing pages in other projects, use [[project:ProjectSlug/PageTitle]] syntax.

## Heading Standards
Use clear heading hierarchy (## for main sections, ### for subsections).
Every page should have at least 3 meaningful headings for table of contents generation.

## Mathematical Content Formats
For mathematical content, use these standard formats:
- Theorems: **Theorem (Name).** Statement
- Proofs: *Proof.* Content □
- Definitions: **Definition.** Content
- Lemmas: **Lemma.** Statement
${allPageTitles && allPageTitles.length > 0 ? `
## Related Wiki Pages
These are other wiki pages in this project that you can reference using [[PageTitle]] syntax:
${allPageTitles.map((t) => "- " + t).join("\n")}
` : ""}${outline ? (() => {
  const pageOutline = outline.pages.find((p) => p.slug === spec.slug);
  let outlineSection = `\n## Narrative Outline Context\nGlobal thesis: ${outline.globalThesis}\n`;
  if (pageOutline) {
    outlineSection += `\nThis page's narrative role: ${pageOutline.narrativeRole}\n`;
    if (pageOutline.keyPoints.length > 0) {
      outlineSection += `Key points this page MUST cover:\n${pageOutline.keyPoints.map((k) => "- " + k).join("\n")}\n`;
    }
    if (pageOutline.transitionTo) {
      outlineSection += `This page should transition to: ${pageOutline.transitionTo}\n`;
    }
  }
  return outlineSection;
})() : ""}${previousPages && previousPages.length > 0 ? `
## Previously Generated Pages (summaries)
${previousPages.map((p) => `### ${p.title}\n${p.summary}`).join("\n\n")}
` : ""}
Output ONLY the markdown content for this page. No JSON wrapping.`;
}

export function buildVerificationPrompt(
  page: WikiPageOutput,
  problem: { title: string; formalStatement: string; tags: string[] },
  sourceCorpus: SourceCorpusEntry[]
): string {
  // Only include sources with abstracts for meaningful verification
  const sourcesWithAbstracts = sourceCorpus
    .filter((s) => s.abstract && s.abstract.length > 30)
    .slice(0, 20);

  const sourceList = sourcesWithAbstracts
    .map((s, i) => {
      const authorStr = s.authors.length > 0 ? ` by ${s.authors.slice(0, 3).join(", ")}` : "";
      const yearStr = s.year ? ` (${s.year})` : "";
      return `[S${i + 1}] "${s.title}"${authorStr}${yearStr}: ${s.abstract!.slice(0, 250)}`;
    })
    .join("\n");

  return `You are a rigorous mathematical fact-checker for the Mathub platform. Your job is to verify the factual claims in a Wiki page by cross-referencing against known source material.

## Problem Context
Title: ${problem.title}
Formal Statement: ${problem.formalStatement}

## Wiki Page to Verify
Title: ${page.title} (slug: ${page.slug})

Content:
${page.content.slice(0, 4000)}

## Available Source Material
${sourceList || "(no sources with abstracts available)"}

## Verification Task
Extract the 5-12 most important FACTUAL CLAIMS from the wiki page. For each claim, verify it against the source material above. Focus on:

1. **Attribution accuracy** — Did the right person prove/conjecture this? Is the year correct?
2. **Mathematical correctness** — Are theorem statements, bounds, or formulas stated correctly?
3. **Relationship accuracy** — Are the claimed relationships between results/methods correct?
4. **Chronological accuracy** — Is the timeline of results correct?
5. **Status accuracy** — Is a claimed "open problem" actually still open? Is a "proved" result actually proved?

For each claim, assign:
- **status**: "verified" (supported by sources), "unverified" (no source found — does NOT mean incorrect), "incorrect" (contradicts source material)
- **severity**: "correct" (no issue), "minor" (small inaccuracy, e.g. approximate year), "major" (meaningful error, e.g. wrong attribution), "critical" (fundamental mathematical error)

## Output Format
Output a JSON object:
{
  "claims": [
    {
      "claim": "exact text or paraphrase of the claim from the wiki",
      "status": "verified|unverified|incorrect",
      "severity": "correct|minor|major|critical",
      "explanation": "why this verdict — cite [S#] sources",
      "source_evidence": "relevant excerpt from source if available",
      "suggested_fix": "correction text if status is incorrect"
    }
  ]
}

IMPORTANT RULES:
- Be CONSERVATIVE: only mark as "incorrect" if you have clear evidence from the sources.
- "unverified" is NOT a problem — it just means no source was found to confirm the claim.
- Use [S#] references to cite source material.
- Focus on the MOST important claims, not every sentence.
- Mathematical notation should be checked carefully.

Output ONLY valid JSON, no markdown formatting.`;
}

export function buildCorrectionPrompt(
  page: WikiPageOutput,
  issues: VerificationIssue[],
  problem: { title: string; formalStatement: string; tags: string[] },
  sourceCorpus: SourceCorpusEntry[]
): string {
  const issueList = issues
    .map((issue, i) => {
      let entry = `[Issue ${i + 1}] (${issue.severity}) Claim: "${issue.claim}"\n  Problem: ${issue.explanation}`;
      if (issue.sourceEvidence) {
        entry += `\n  Source evidence: ${issue.sourceEvidence}`;
      }
      if (issue.suggestedFix) {
        entry += `\n  Suggested fix: ${issue.suggestedFix}`;
      }
      return entry;
    })
    .join("\n\n");

  const relevantSources = sourceCorpus
    .filter((s) => s.abstract && s.abstract.length > 30)
    .slice(0, 15)
    .map((s) => {
      const authorStr = s.authors.length > 0 ? ` by ${s.authors.slice(0, 2).join(", ")}` : "";
      return `- "${s.title}"${authorStr}${s.year ? ` (${s.year})` : ""}: ${s.abstract!.slice(0, 200)}`;
    })
    .join("\n");

  return `You are a mathematical wiki writer correcting factual errors found during verification.

## Problem
Title: ${problem.title}
Formal Statement: ${problem.formalStatement}

## Original Page
Title: ${page.title}
Content:
${page.content}

## Verified Issues to Fix
${issueList}

## Source Material (ground truth)
${relevantSources || "(none)"}

## Task
Rewrite the ENTIRE page content, correcting ALL the issues listed above. Keep the same structure, style, and LaTeX formatting. Only change the parts that contain errors.

Rules:
- Start with: > [AI-GENERATED] [AI-VERIFIED] This content was automatically generated, verified, and corrected.
- Preserve all [descriptive text](@ws:effort-id) reference links
- Preserve ## section headers
- Fix ONLY the identified issues — do not rewrite correct content
- If a claim cannot be verified and was marked incorrect, either correct it based on source material or add a caveat like "(attribution needs verification)"
- Use LaTeX: $...$ inline, $$...$$ display

Output ONLY the corrected markdown content. No JSON wrapping.`;
}

// ========== Narrative Outline Prompt ==========

export function buildNarrativeOutlinePrompt(
  problem: { title: string; description: string; tags: string[] },
  efforts: Array<{ title: string; description: string; document?: string }>,
  surveyExcerpts: string[],
  wikiSpec: Array<{ slug: string; title: string; instruction: string }>
): string {
  const effortList = efforts
    .map((e, i) => `[${i + 1}] "${e.title}": ${e.description.slice(0, 300)}${e.document ? `\n  Key content: ${e.document.slice(0, 500)}` : ""}`)
    .join("\n");

  const surveySection = surveyExcerpts.length > 0
    ? `\n## Survey Paper Excerpts\n${surveyExcerpts.slice(0, 5).join("\n\n")}\n`
    : "";

  const specList = wikiSpec
    .map((s) => `- ${s.slug}: "${s.title}"`)
    .join("\n");

  return `You are planning the narrative structure for a mathematical wiki about "${problem.title}".

## Problem
Title: ${problem.title}
Description: ${problem.description}
Tags: ${problem.tags.join(", ")}

## Available Research Efforts
${effortList || "(none)"}
${surveySection}
## Wiki Pages to Generate
${specList}

## Task
Create a narrative outline that tells a coherent story across all wiki pages. The outline should:
1. Define a global thesis — the central narrative thread connecting all pages
2. For each page, specify its narrative role, key points it must cover, and how it transitions to the next page
3. Ensure the pages build on each other rather than being independent

Output a JSON object with this structure:
{
  "globalThesis": "The central narrative thread...",
  "pages": [
    {
      "slug": "overview",
      "title": "Page Title",
      "narrativeRole": "What role this page plays in the story",
      "coreSections": ["Section 1", "Section 2"],
      "transitionTo": "next-page-slug",
      "keyPoints": ["Point 1", "Point 2"]
    }
  ]
}

Output ONLY valid JSON, no markdown formatting.`;
}

// ========== Wiki Review Prompt ==========

export function buildWikiReviewPrompt(
  pageTitle: string,
  pageContent: string,
  outline: NarrativeOutline,
  citations: CitationEntry[]
): string {
  const citationList = citations
    .slice(0, 30)
    .map((c) => `[@${c.key}] ${c.authors.slice(0, 2).join(", ")}${c.year ? ` (${c.year})` : ""}: "${c.title}"${c.isSurvey ? " [SURVEY]" : ""}`)
    .join("\n");

  const outlineContext = outline.globalThesis
    ? `\nGlobal thesis: ${outline.globalThesis}\n`
    : "";

  return `You are reviewing a mathematical wiki page for quality.

## Page Title: ${pageTitle}
${outlineContext}
## Page Content:
${pageContent.slice(0, 8000)}

## Available Citations:
${citationList || "(none)"}

## Review Criteria
Evaluate the page on:
1. **Narrative coherence** — Is there a clear central argument? Does the page tell a story or just list facts?
2. **Technical depth** — Are key theorems stated precisely with full LaTeX? Are proof sketches included?
3. **Citations** — Does the page reference sufficient literature? Are claims properly attributed?
4. **Outline consistency** — Does the page fulfill its narrative role?

## Output Format
Output a JSON object:
{
  "issues": [
    {
      "section": "section name or 'overall'",
      "problem": "description of the issue",
      "suggestion": "how to fix it"
    }
  ],
  "overallScore": 8
}

overallScore: 1-10 (10 = excellent, 7+ = acceptable, <7 = needs revision)

Output ONLY valid JSON, no markdown formatting.`;
}
