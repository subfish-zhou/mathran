/**
 * LLM prompts for frontier-expansion's relevance filter.
 *
 * One-shot, batched filter: given the project's spine (or the problem
 * fallback) + N candidate papers (title + abstract + year + which concept
 * surfaced them), the LLM returns a verdict per candidate.
 *
 * Bounded LLM cost: ONE call per expansion tick, regardless of how many
 * concepts ran. We pack up to ~50 candidates per call (well within
 * 16K-context models when each abstract is ≤300 chars).
 */

import type { NarrativeSpine } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";
import type { FrontierCandidate } from "./types.js";

export const FRONTIER_FILTER_PROMPT_VERSION = "v1";

export interface FrontierFilterPromptInput {
  problemTitle: string;
  problemFormalStatement: string;
  problemTags: string[];
  spine: NarrativeSpine | null;
  /** Already-read papers — gives the LLM context for "we already covered X". */
  recentReads: Array<{ title: string; year: number; oneLineSummary: string }>;
  /** Candidates to judge. */
  candidates: FrontierCandidate[];
}

/**
 * Build the relevance-filter prompt. Truncates abstracts to 300 chars
 * (the first paragraph of an arxiv abstract is enough signal) and
 * read summaries to 200 chars.
 */
export function buildFrontierFilterPrompt(input: FrontierFilterPromptInput): string {
  const lines: string[] = [];

  lines.push(
    `You are filtering recent arXiv papers for inclusion in an automated`,
    `survey of a math problem. For each candidate, return a verdict:`,
    `KEEP (read it next, it directly bears on the problem) or SKIP (it`,
    `merely mentions a keyword but isn't on-topic, or duplicates what`,
    `is already covered).`,
    ``,
    `## The problem`,
    `Title: ${input.problemTitle}`,
    `Formal statement: ${trunc(input.problemFormalStatement, 800)}`,
    `Tags: ${input.problemTags.join(", ") || "(none)"}`,
    ``,
  );

  if (input.spine) {
    lines.push(
      `## Current narrative spine (what the survey already knows)`,
      `Global thesis: ${trunc(input.spine.globalThesis ?? "", 400)}`,
    );
    const threads = input.spine.threads ?? [];
    if (threads.length > 0) {
      lines.push(`Threads:`);
      for (const t of threads.slice(0, 8)) {
        lines.push(`  - ${t.name}: ${trunc(t.description ?? "", 120)}`);
      }
    }
    const opens = input.spine.openQuestions ?? [];
    if (opens.length > 0) {
      lines.push(`Open questions:`);
      for (const q of opens.slice(0, 5)) {
        lines.push(`  - ${trunc(q.statement, 200)}`);
      }
    }
    lines.push(``);
  }

  if (input.recentReads.length > 0) {
    lines.push(`## Papers already read (do NOT re-recommend)`);
    for (const r of input.recentReads.slice(0, 15)) {
      lines.push(`  - [${r.year}] "${trunc(r.title, 80)}" — ${trunc(r.oneLineSummary, 200)}`);
    }
    lines.push(``);
  }

  lines.push(`## Candidates`);
  for (let i = 0; i < input.candidates.length; i++) {
    const c = input.candidates[i]!;
    lines.push(
      ``,
      `### Candidate ${i + 1} (arxivId: ${c.arxivId})`,
      `Title: ${c.title}`,
      `Authors: ${c.authors.slice(0, 5).join(", ")}${c.authors.length > 5 ? " et al." : ""}`,
      `Year: ${c.year}`,
      `Surfaced by concept: "${c.fromConcept}"`,
      `Abstract: ${trunc(c.abstract, 300)}`,
    );
  }

  lines.push(
    ``,
    `## Decision criteria`,
    `KEEP a paper when:`,
    `  - Its title + abstract are PLAUSIBLY about the problem (not just a`,
    `    keyword match in an unrelated context).`,
    `  - It contributes a result, technique, or barrier NOT already covered`,
    `    by papers in "already read".`,
    `  - It is a real paper (not a crank "proof of Goldbach" type submission`,
    `    making sweeping claims with no rigorous content visible from the`,
    `    abstract).`,
    `SKIP when:`,
    `  - Keyword appears but the paper is about a different problem (e.g.`,
    `    "binary" matches binary-tree or binary-classification papers).`,
    `  - It duplicates a result already in the spine / already read.`,
    `  - It is a vague restatement or non-rigorous philosophical commentary.`,
    ``,
    `For each KEEP, set priorityBand:`,
    `  - "essential" if the abstract claims a NEW theorem directly on the`,
    `    main problem (e.g. improves an exceptional set bound for binary`,
    `    Goldbach by an order of magnitude).`,
    `  - "supporting" if it advances a technique or sub-problem in a thread.`,
    `  - "passing" (default) if it's tangentially relevant but worth a glance.`,
    ``,
    `## Output`,
    `Return ONLY a JSON object of the shape:`,
    `{`,
    `  "verdicts": [`,
    `    {"arxivId": "...", "decision": "keep"|"skip", "reason": "...", "priorityBand": "essential"|"supporting"|"passing"},`,
    `    ...`,
    `  ]`,
    `}`,
    `Include every candidate's arxivId exactly once. No prose outside the JSON.`,
  );

  return lines.join("\n");
}

function trunc(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
