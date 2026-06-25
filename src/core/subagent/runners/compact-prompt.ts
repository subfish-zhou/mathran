/**
 * Compaction prompt — TODO-2 §5.4 / C4.
 *
 * Builds a 9-section structured summarization prompt over the dropped
 * middle chunk of a conversation. The shape comes from Claude Code's
 * structured-compaction skill
 * (~/.openclaw/workspace/skills/structured-compaction/SKILL.md), which
 * outperforms codex's 4-bullet style on identifier preservation and
 * user-intent fidelity — both critical for the long, multi-tool-call
 * goals mathran runs.
 *
 * The 9 sections:
 *   1. Primary Request and Intent
 *   2. Key Technical Concepts
 *   3. Files and Code Sections
 *   4. Errors and Fixes
 *   5. Problem Solving
 *   6. All User Messages (verbatim — DO NOT paraphrase)
 *   7. Pending Tasks
 *   8. Current Work
 *   9. Optional Next Step
 *
 * Section 6 is the rigid requirement: user messages must be preserved
 * verbatim so any post-compaction turn can replay the user's exact
 * phrasing. Identifier loss (file paths, commit SHAs, function names)
 * was yachiyo's 6/14 root-cause for a 778-line memory becoming an
 * 85-line empty rebuild.
 */

import type { LLMMessage } from "../../providers/llm.js";

const SYS_PROMPT =
  "You are a conversation summarizer. Output ONLY the structured " +
  "summary content; no preamble, no headers about being a summarizer, " +
  "no explanation of what you're doing. Begin with the literal text " +
  '"## 1. Primary Request and Intent" — nothing before it.';

/** Returns the system prompt used by LocalCompactionStrategy when calling the LLM. */
export function summarizationSystemPrompt(): string {
  return SYS_PROMPT;
}

/**
 * Build a 9-section structured summarization user prompt over the dropped
 * middle chunk. Inserts a rendered transcript of `middle` between
 * BEGIN/END markers so the model has the raw material to summarize.
 */
export function build9SectionPrompt(middle: LLMMessage[]): string {
  return [
    `Summarize the following conversation history into a structured handoff for another LLM that will resume this work.`,
    ``,
    `Use EXACTLY these 9 sections, in this order, each preceded by its Markdown heading:`,
    ``,
    `## 1. Primary Request and Intent`,
    `The user's explicit request and goals. Include success criteria if stated.`,
    ``,
    `## 2. Key Technical Concepts`,
    `Frameworks, libraries, patterns, APIs, terminology used.`,
    ``,
    `## 3. Files and Code Sections`,
    `File paths read or modified, key code snippets, what changed and why. Always include the full path.`,
    ``,
    `## 4. Errors and Fixes`,
    `Errors encountered, their root cause, the fix applied. FLAG any user-corrected mistakes.`,
    ``,
    `## 5. Problem Solving`,
    `Two subsections: Resolved (problem → solution) and Still investigating (problem → current hypothesis).`,
    ``,
    `## 6. All User Messages (verbatim)`,
    `Copy every non-tool-result user message VERBATIM. Do NOT paraphrase. Preserve user intent exactly.`,
    ``,
    `## 7. Pending Tasks`,
    `Checklist of work that remains.`,
    ``,
    `## 8. Current Work`,
    `What is being actively worked on right now, including relevant code snippets.`,
    ``,
    `## 9. Optional Next Step`,
    `Suggested next action to continue.`,
    ``,
    `RULES:`,
    `- Be specific: include real file paths, function names, error messages, key code snippets.`,
    `- Empty sections may be omitted, but NEVER merge sections.`,
    `- Section 6 is the rigid requirement — user messages must be verbatim.`,
    `- Prefer too much detail over too little. Target ~1500-2000 tokens total.`,
    ``,
    `--- BEGIN CONVERSATION HISTORY ---`,
    renderMiddleAsTranscript(middle),
    `--- END CONVERSATION HISTORY ---`,
    ``,
    `Now produce the structured summary, starting with "## 1. Primary Request and Intent".`,
  ].join("\n");
}

/**
 * Render the middle chunk as a single text transcript the summarizer LLM
 * can read. Truncates very long bodies (head + tail) so a single huge tool
 * result doesn't blow the summarizer's own input budget. Tool messages
 * are tagged with their tool name so the summary can attribute outputs.
 */
export function renderMiddleAsTranscript(middle: LLMMessage[]): string {
  const lines: string[] = [];
  for (const m of middle) {
    const tag = m.role.toUpperCase();
    let body = typeof m.content === "string" ? m.content : "";
    if (m.toolCalls && m.toolCalls.length > 0) {
      const calls = m.toolCalls
        .map((c) => `  → ${c.name}(${truncate(c.arguments, 500)})`)
        .join("\n");
      body = body ? `${body}\n${calls}` : calls;
    }
    if (m.role === "tool" && m.name) {
      lines.push(`[${tag} ${m.name}]\n${truncate(body, 2000)}`);
    } else {
      lines.push(`[${tag}]\n${truncate(body, 2000)}`);
    }
  }
  return lines.join("\n\n");
}

/**
 * Truncate a long string with head + tail kept, middle dropped with a
 * marker. Used per-message in renderMiddleAsTranscript so any single
 * huge tool result doesn't drown out the structural signal.
 *
 * Splits the available budget ~70% head / ~30% tail; the truncation
 * marker text (~60 chars) is added on top of `max`, so the actual
 * output may be slightly longer than `max` — this is intentional
 * (callers care about "didn't keep all the bytes", not "stayed under
 * an exact byte budget").
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(1, max - head); // never drop the tail entirely
  return `${s.slice(0, head)}\n... [truncated ${s.length - max} chars] ...\n${s.slice(-tail)}`;
}
