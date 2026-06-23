/**
 * LLM prompt templates for the init-project agent. Adapted from mathub's
 * `init-prompts.ts` but trimmed to the v1a pipeline (concept extraction +
 * single-page wiki generation). No mathub-specific provider assumptions.
 */

import type { CrawledResource, FormalizedProblem } from "./types.js";

export function buildConceptExtractionPrompt(
  problem: FormalizedProblem,
  papers: CrawledResource[],
  wikiSummary?: string | null,
): string {
  const paperList = papers
    .slice(0, 10)
    .map((p) => `- "${p.title}" by ${p.authors.join(", ")}${p.abstract ? ` — ${p.abstract.slice(0, 200)}` : ""}`)
    .join("\n");

  const wikiSection = wikiSummary ? `\n## Wikipedia Context\n${wikiSummary.slice(0, 1000)}\n` : "";

  return `You are a mathematical research assistant specializing in identifying key concepts and generating search queries.

Given the following mathematical problem and initial papers, extract the core mathematical concepts and generate arXiv search queries for deeper research.

## Problem
Title: ${problem.title}
Formal Statement: ${problem.formalStatement ?? "(none)"}
Description: ${problem.description ?? "(none)"}
Background: ${problem.backgroundSummary ?? "(none)"}
Tags: ${(problem.tags ?? []).join(", ")}
${wikiSection}
## Initial Papers Found
${paperList || "(none yet)"}

## Output Requirements
Output a JSON object with:
1. "concepts": array of objects with "name" (string) and "importance" (0-1 float)
2. "search_queries": array of 3-8 specific arXiv search query strings
   - Target specific mathematical objects, theorems, techniques, author methods
   - NOT generic phrases like "prime numbers"

Output ONLY valid JSON, no markdown formatting.`;
}

export interface WikiPageSpec {
  slug: string;
  title: string;
  instruction: string;
}

export function buildWikiPagePrompt(
  problem: FormalizedProblem,
  resources: CrawledResource[],
  spec: WikiPageSpec,
): string {
  const refList = resources
    .slice(0, 20)
    .map((r, i) => {
      const auth = r.authors.slice(0, 3).join(", ") + (r.authors.length > 3 ? " et al." : "");
      return `[${i + 1}] "${r.title}" (${auth}, ${r.year ?? "?"})${r.arxivId ? ` arXiv:${r.arxivId}` : ""}${r.abstract ? `\n    ${r.abstract.slice(0, 300)}` : ""}`;
    })
    .join("\n");

  return `You are a mathematical wiki writer for the Mathran platform.

## Problem
Title: ${problem.title}
Formal Statement: ${problem.formalStatement ?? "(none)"}
Description: ${problem.description ?? "(none)"}
Background: ${problem.backgroundSummary ?? "(none)"}
Math Status: ${problem.mathStatus ?? "OPEN"}

## References (use these as the literature basis)
${refList || "(none)"}

## Page to Write
Title: ${spec.title}
Slug: ${spec.slug}

## Instructions
${spec.instruction}

## Writing Rules
- Begin with: > [AI-GENERATED] This content was automatically generated and requires human review.
- Use LaTeX: $...$ inline, $$...$$ display.
- Use ## headers for sections; include at least 3 meaningful headings.
- Write for working mathematicians and graduate students; do not omit technical detail.
- Cite references inline as [Author, Year] using the references above.
- Be precise: state bounds, conditions, and theorem statements in full — no vague "improved the bound".

Output ONLY the markdown content for this page. No JSON wrapping.`;
}
