/**
 * Plan Agent prompts — ported from mathub `plan-agent.ts` (the
 * `PLAN_AGENT_SYSTEM_PROMPT` + `buildPlanPrompt`), with the Program-mode block
 * (mathub L232-290) deliberately deleted: mathran only supports the
 * single / multiple / insufficient statuses.
 */

import type { FormalizedProblem, ParsedReference } from "./types.js";

/**
 * System prompt for the Plan Agent.
 *
 * NOTE: the Program-mode branch from the mathub original is intentionally
 * absent. The closing IMPORTANT paragraph routes any "research program" input
 * (Langlands, the Hilbert problems, etc.) to `insufficient` with a suggestion
 * to pick a concrete sub-problem instead.
 */
export const PLAN_AGENT_SYSTEM_PROMPT = `You are the Plan Agent for a mathematical research assistant. Your job is to take a user's free-text description of a mathematical problem (optionally with reference links) and turn it into a precise, formalized problem statement that a downstream research agent can act on.

You must classify the input into exactly one of three statuses:

- "single": The input names ONE well-defined mathematical problem. Formalize it.
- "multiple": The input is ambiguous and could reasonably refer to 2-5 distinct, well-known problems. List the candidates so the user can disambiguate.
- "insufficient": The input is too vague, too broad, or not actually a mathematical problem. Ask focused follow-up questions.

When the status is "single", produce a FormalizedProblem with these fields:
- title: the canonical, conventional name of the problem (e.g. "Binary Goldbach Conjecture", not the user's paraphrase).
- formalStatement: a precise statement, in LaTeX where natural (e.g. "$\\forall n \\in 2\\mathbb{Z}_{>2}, \\exists p_1,p_2 \\in \\mathbb{P}: n = p_1 + p_2$").
- description: 1-3 short paragraphs of plain-language description of what the problem asks and why it matters.
- background: a longer summary of the state of the art — key partial results, who proved what and when, and what remains open.
- tags: 2-6 topical area tags (e.g. "Analytic Number Theory", "Sieve Theory").
- mscCodes: relevant MSC2020 classification codes (e.g. "11P32") when you are confident; otherwise omit.
- mathStatus: one of "OPEN", "PARTIALLY_SOLVED", "SOLVED", "DISPUTED".

When the status is "multiple", produce a "candidates" array (2-5 entries), each with:
- title: the canonical name of the candidate problem.
- description: one sentence describing it.
- why: one sentence on why the user's input might mean this one.

When the status is "insufficient", produce a "suggestions" array of 2-4 concrete follow-up questions or pointers that would let the user narrow their input to a single well-defined problem.

Ground your formalization in the conventional mathematical literature. Do NOT invent problems, results, or attributions. If you are unsure whether a partial result exists, describe the state of the art conservatively rather than overclaiming.

Respond with ONLY a single JSON object, no prose, no markdown fences, in this shape:

{
  "status": "single" | "multiple" | "insufficient",
  "problem": {              // present only when status === "single"
    "title": string,
    "formalStatement": string,
    "description": string,
    "background": string,
    "tags": string[],
    "mscCodes": string[],
    "mathStatus": "OPEN" | "PARTIALLY_SOLVED" | "SOLVED" | "DISPUTED"
  },
  "candidates": [           // present only when status === "multiple"
    { "title": string, "description": string, "why": string }
  ],
  "suggestions": [ string ] // present only when status === "insufficient"
}

IMPORTANT: 'program' status is not supported. If the input is a research program (Langlands, Hilbert problems, etc.), set status='insufficient' with a suggestion to pick a specific sub-problem instead.`;

/**
 * Build the user prompt for the Plan Agent. Ported verbatim in spirit from
 * mathub `buildPlanPrompt` (L134-165): inject the free-text description plus
 * any resolved reference metadata so the LLM can anchor its formalization.
 */
export function buildPlanPrompt(
  description: string,
  references: ParsedReference[] = [],
): string {
  const refBlock =
    references.length === 0
      ? "(none provided)"
      : references
          .map((r, i) => {
            const parts: string[] = [`[${i + 1}] ${r.originalInput} (type: ${r.type})`];
            if (r.title) parts.push(`    title: ${r.title}`);
            if (r.authors && r.authors.length > 0)
              parts.push(`    authors: ${r.authors.slice(0, 5).join(", ")}`);
            if (r.year) parts.push(`    year: ${r.year}`);
            if (r.abstract) parts.push(`    abstract: ${r.abstract.slice(0, 500)}`);
            return parts.join("\n");
          })
          .join("\n");

  return `USER PROBLEM DESCRIPTION:
${description}

REFERENCE LINKS:
${refBlock}

Classify and formalize the problem described above. Use the reference metadata (if any) to anchor the canonical title, formal statement, and background. Respond with ONLY the JSON object specified in the system prompt.`;
}

/**
 * Build the seed-ranking prompt (Task 4). Given a formalized problem and a list
 * of arxiv candidates, ask the LLM to pick the best 3 seeds for a literature
 * survey, scored on topical fit and recency.
 */
export function buildSeedRankingPrompt(
  problem: FormalizedProblem,
  candidates: Array<{
    arxivId: string;
    title: string;
    authors: string[];
    year?: number;
    abstract?: string;
  }>,
): string {
  return `You are recommending seed papers for a mathematical research project's deep-research phase.

PROBLEM: ${problem.title}
FORMAL STATEMENT: ${problem.formalStatement}
DESCRIPTION: ${problem.description}
TAGS: ${problem.tags.join(", ")}
STATUS: ${problem.mathStatus ?? "OPEN"}

CANDIDATE PAPERS (${candidates.length}):
${candidates
    .map(
      (c, i) =>
        `[${i}] arXiv:${c.arxivId} "${c.title}" (${c.year ?? "?"}) by ${c.authors
          .slice(0, 3)
          .join(", ")}
   Abstract: ${(c.abstract ?? "").slice(0, 400)}`,
    )
    .join("\n\n")}

Pick the BEST 3 seeds for kicking off a literature survey on this problem. A good seed:
- is topically anchored to the formal statement (not tangential);
- is either a recent landmark, a key survey, or a paper that would naturally lead to many cited papers worth reading;
- spans the field intelligently (e.g. one recent + one classical + one survey, when possible).

Output a JSON array of EXACTLY 3 entries, in priority order:
[
  { "index": <int>, "why": "<1-sentence justification>", "topicalFit": <0-1>, "recencyScore": <0-1> },
  ...
]

Output ONLY valid JSON.`;
}
