/**
 * Wiki Agent — generates wiki pages using an agent loop with tools.
 *
 * Instead of single-shot LLM calls with truncated context, this agent
 * can read efforts and wiki pages on demand (no truncation) using tools,
 * then output pages via write_wiki_page.
 */

import { runAgentLoop } from "./executor";
import { ToolRegistry } from "./tools/registry";
import { createWikiTools } from "./wiki-agent-tools";
import { getMathStatusEmphasis } from "./init-prompts";
import type { WikiPageOutput } from "./init-types";
import type { RequiredWikiPageSpec } from "./init-spec";
import type { ToolContext } from "./tools/types";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";

export interface WikiAgentConfig {
  projectId: string;
  userId: string;
  problem: {
    title: string;
    formalStatement: string;
    description: string;
    backgroundSummary: string;
    tags: string[];
    currentStatus?: string;
    mathStatus?: string;
    solvedBy?: string;
    solvedYear?: number;
    solvedReference?: string;
  };
  existingPages: Array<{ slug: string; title: string }>;
  requiredPages: RequiredWikiPageSpec[];
  mode: "full" | "incremental";
  newDiscoveries?: Array<{ title: string; abstract: string; url?: string }>;
  maxIterations?: number;
}

export async function wikiAgentGenerate(config: WikiAgentConfig): Promise<WikiPageOutput[]> {
  const collectedPages: WikiPageOutput[] = [];
  const tools = createWikiTools(collectedPages);
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }

  const toolContext: ToolContext = {
    userId: config.userId,
    projectId: config.projectId,
    db: getDb(),
  };

  const systemPrompt = buildWikiAgentSystemPrompt(config);

  const userMessage =
    config.mode === "full"
      ? "Generate all the required wiki pages listed above. Use the tools to read effort documents and existing pages as needed. Start by listing efforts to understand what's available, then read relevant ones before writing each page."
      : "Update the existing wiki pages based on the new discoveries listed in the system prompt. Read existing pages first to understand current content, then read relevant efforts, and write updated pages. Also generate any missing required pages.";

  await runAgentLoop({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    tools: registry,
    toolContext,
    maxIterations: config.maxIterations ?? 50,
    parallelToolCalls: true,
  });

  return collectedPages;
}

function buildWikiAgentSystemPrompt(config: WikiAgentConfig): string {
  const { problem, existingPages, requiredPages, mode, newDiscoveries } = config;

  const mathStatus = problem.mathStatus ?? "OPEN";
  const statusEmphasis = getMathStatusEmphasis(mathStatus);

  const existingPagesIndex =
    existingPages.length > 0
      ? existingPages.map((p) => `- ${p.slug}: ${p.title}`).join("\n")
      : "(none)";

  const requiredPagesSection = requiredPages
    .map(
      (spec) =>
        `### ${spec.slug}\n- Title template: ${spec.titleTemplate}\n- Priority: ${spec.priority}\n- Instruction: ${spec.instruction}\n- Required sections: ${spec.requiredSections.length > 0 ? spec.requiredSections.join(", ") : "(none)"}`,
    )
    .join("\n\n");

  let discoveriesSection = "";
  if (mode === "incremental" && newDiscoveries && newDiscoveries.length > 0) {
    discoveriesSection = `\n## New Discoveries to Integrate\n${newDiscoveries
      .map(
        (d, i) =>
          `### Discovery ${i + 1}: "${d.title}"${d.url ? `\nURL: ${d.url}` : ""}\n${d.abstract}`,
      )
      .join("\n\n")}\n`;
  }

  return `You are a mathematical wiki writer agent for the Mathub platform. You generate high-quality wiki pages for mathematical research projects by reading workspace efforts and existing pages on demand using your tools.

## Problem
Title: ${problem.title}
Formal Statement: ${problem.formalStatement}
Description: ${problem.description}
Background: ${problem.backgroundSummary}
Current Status: ${problem.currentStatus ?? "Unknown"}
Math Status: ${mathStatus}${problem.solvedBy ? `\nSolved By: ${problem.solvedBy}` : ""}${problem.solvedYear ? `\nSolved Year: ${problem.solvedYear}` : ""}${problem.solvedReference ? `\nSolution Reference: ${problem.solvedReference}` : ""}

## Status-Specific Emphasis
${statusEmphasis}

## Existing Wiki Pages (index only)
${existingPagesIndex}

## Required Pages to Generate
${requiredPagesSection}
${discoveriesSection}
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

## Tool Usage Instructions
You have the following tools available:
1. **list_efforts** — List all workspace efforts to understand what data is available. Call this first.
2. **read_effort** — Read a single effort's full document (no truncation). Use this to get detailed mathematical content.
3. **read_wiki_page** — Read an existing wiki page's full content by slug. Use for incremental updates.
4. **search_efforts** — Search efforts by keyword. Use when looking for specific topics.
5. **write_wiki_page** — Output a generated wiki page. Call this for each page you generate.

Strategy:
- Start by calling list_efforts to see all available workspace efforts.
- For each page you need to write, read the relevant efforts to get full mathematical details.
- For incremental mode, read existing pages first to understand current content before updating.
- Write each page using write_wiki_page with complete, high-quality content.
- You may call multiple tools in parallel for efficiency.
- Beyond the required pages, if you discover that a major technique, sub-problem, or research thread deserves its own dedicated page, feel free to create additional pages using write_wiki_page with a descriptive slug.`;
}
