/**
 * Self-grade rubric prompt (#5).
 *
 * Builds the system + user prompt for the background grading round and parses
 * the model's JSON reply into a validated {@link RubricReply}. The grader is a
 * separate, single-shot inference (NOT part of the main chat history) so it
 * can be fired-and-forgotten without polluting the goal conversation.
 *
 * The prompt deliberately demands a strict JSON object and nothing else; the
 * parser tolerates the common failure mode of a model wrapping the JSON in a
 * ```json fence or surrounding prose by extracting the first balanced object.
 */

import {
  rubricReplySchema,
  redactSecrets,
  type RubricReply,
} from "./schema.js";
import type { LLMMessage } from "../providers/llm.js";

export const RUBRIC_SYSTEM_PROMPT = [
  "You are a strict but fair engineering reviewer grading a just-finished",
  "autonomous coding goal. Score the run on three axes from 1 (poor) to 5",
  "(excellent):",
  "  - correctness: did the work actually solve the objective without bugs?",
  "  - completeness: did it cover the whole ask, or leave gaps / TODOs?",
  "  - efficiency: was the path to done direct (few wasted rounds/tool calls)?",
  "",
  "Then write `lessons`: 1-3 short paragraphs of concrete, reusable advice a",
  "future agent should remember when tackling a SIMILAR goal — what worked,",
  "what to avoid, and any gotchas. Be specific, not generic.",
  "",
  "Finally extract `contextTags`: 3-8 lowercase keywords describing the",
  "domain/tech/shape of the task (e.g. \"typescript\", \"refactor\",",
  "\"test\", \"approval\", \"lean\").",
  "",
  "Reply with ONLY a JSON object, no prose, no code fence:",
  '{ "rubric": { "correctness": <1-5>, "completeness": <1-5>, "efficiency": <1-5> },',
  '  "lessons": "<1-3 paragraphs>", "contextTags": ["..."] }',
].join("\n");

export interface RubricPromptInput {
  objective: string;
  resolution: "complete" | "abandoned" | "blocked";
  endReason?: string;
  /**
   * Compact, human-readable trace of the run (assistant turns + tool calls).
   * Caller is responsible for trimming this to a sane size; it is redacted
   * here defensively before being embedded in the prompt.
   */
  trace: string;
}

/** Build the user-message body the grader reads. */
export function buildRubricUserPrompt(input: RubricPromptInput): string {
  const reasonLine = input.endReason
    ? `End reason: ${redactSecrets(input.endReason)}`
    : "End reason: (none recorded)";
  return [
    `Objective: ${redactSecrets(input.objective)}`,
    `Resolution: ${input.resolution}`,
    reasonLine,
    "",
    "Run trace (assistant text + tool calls, chronological):",
    "------",
    redactSecrets(input.trace).trim() || "(empty trace)",
    "------",
    "",
    "Grade this run now. Output JSON only.",
  ].join("\n");
}

/** Assemble the full two-message request for the grader. */
export function buildRubricMessages(input: RubricPromptInput): LLMMessage[] {
  return [
    { role: "system", content: RUBRIC_SYSTEM_PROMPT },
    { role: "user", content: buildRubricUserPrompt(input) },
  ];
}

/**
 * Extract the first balanced top-level `{...}` object from a string. Handles
 * models that wrap JSON in prose or a ```json fence. Returns null when no
 * balanced object is found.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse + validate the grader's raw reply. Throws on malformed / out-of-range
 * input so the caller (self-grade) can log + swallow a single failure without
 * persisting a junk outcome.
 */
export function parseRubricReply(raw: string): RubricReply {
  const json = extractJsonObject(raw);
  if (!json) {
    throw new Error("rubric reply contained no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `rubric reply was not valid JSON: ${(err as Error).message}`,
    );
  }
  return rubricReplySchema.parse(parsed);
}
