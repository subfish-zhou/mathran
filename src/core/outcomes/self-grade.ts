/**
 * Self-grade trigger (#5) — fire-and-forget goal grading.
 *
 * Called by the goal runner the moment a goal reaches a terminal state
 * (`mark_done` → complete, `give_up` → abandoned). The contract is strict:
 *
 *   - It runs a SEPARATE, single-shot LLM inference (the same `LLMProvider`
 *     the goal used — i.e. the host's router; we never hard-code OpenAI).
 *   - It is NOT awaited by the runner: the goal is already marked terminal and
 *     returns immediately. Grading happens in the background.
 *   - It NEVER throws. Any failure (transport error, malformed JSON,
 *     out-of-range scores, disk error) is logged via `console.warn` and
 *     swallowed. A missing/garbled grade must not affect the main flow.
 *
 * On success it writes a redacted {@link Outcome} to the outcome store, which
 * the next `propose_goal` retrieves for few-shot context.
 */

import {
  computeAverageScore,
  type Outcome,
  type OutcomeResolution,
} from "./schema.js";
import { buildRubricMessages, parseRubricReply } from "./rubric-prompt.js";
import { writeOutcome } from "./store.js";
import type { LLMMessage, LLMProvider } from "../providers/llm.js";

/** Map the runner's completion outcome to an outcome resolution. */
export function resolutionFromCompletion(
  outcome: "done" | "give_up",
): OutcomeResolution {
  return outcome === "done" ? "complete" : "abandoned";
}

/**
 * Flatten a goal conversation history into a compact, chronological trace the
 * grader can read. Caps total length so a giant goal doesn't blow the grader's
 * context window.
 */
export function buildTraceFromHistory(
  history: LLMMessage[],
  maxChars = 12000,
): string {
  const parts: string[] = [];
  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const text = (m.content ?? "").trim();
      if (text) parts.push(`ASSISTANT: ${text}`);
      for (const tc of m.toolCalls ?? []) {
        parts.push(`  → tool ${tc.name}(${tc.arguments})`);
      }
    } else if (m.role === "tool") {
      const text = (m.content ?? "").trim();
      if (text) parts.push(`TOOL[${m.name ?? "result"}]: ${truncate(text, 600)}`);
    } else if (m.role === "user") {
      const text = (m.content ?? "").trim();
      if (text) parts.push(`USER: ${truncate(text, 800)}`);
    }
  }
  const joined = parts.join("\n");
  if (joined.length <= maxChars) return joined;
  // Keep the tail — the end of a run is the most diagnostic part.
  return "…(trace truncated)…\n" + joined.slice(joined.length - maxChars);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/** Drain a streaming completion to a single string. */
async function collectText(llm: LLMProvider, messages: LLMMessage[], model: string): Promise<string> {
  const response = await llm.chat({ messages, model });
  let buf = "";
  for await (const chunk of response.stream()) {
    if (chunk.type === "text") buf += chunk.delta;
  }
  return buf;
}

export interface SelfGradeInput {
  workspace: string;
  goalId: string;
  objective: string;
  resolution: OutcomeResolution;
  endReason?: string;
  startedAt: number;
  endedAt: number;
  /** Conversation history of the goal run (used to build the trace). */
  history: LLMMessage[];
  llm: LLMProvider;
  model: string;
}

/**
 * Run the background grading round and persist the outcome. Resolves to the
 * written {@link Outcome} on success, or `null` when grading was skipped or
 * failed (the error is logged, never thrown).
 */
export async function selfGradeGoal(
  input: SelfGradeInput,
): Promise<Outcome | null> {
  try {
    const trace = buildTraceFromHistory(input.history);
    const messages = buildRubricMessages({
      objective: input.objective,
      resolution: input.resolution,
      endReason: input.endReason,
      trace,
    });

    const raw = await collectText(input.llm, messages, input.model);
    const reply = parseRubricReply(raw);

    const outcome: Outcome = {
      goalId: input.goalId,
      goalText: input.objective,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      resolution: input.resolution,
      rubric: reply.rubric,
      averageScore: computeAverageScore(reply.rubric),
      lessons: reply.lessons.trim(),
      contextTags: reply.contextTags
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0),
    };

    await writeOutcome(input.workspace, outcome);
    return outcome;
  } catch (err) {
    // Fire-and-forget contract: log + swallow. A failed grade must never
    // disturb the goal's terminal flow.
    // eslint-disable-next-line no-console
    console.warn(
      `[mathran] self-grade failed for goal ${input.goalId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Fire-and-forget wrapper the runner calls. Defers the grading inference to a
 * macrotask (`setImmediate`) so it never runs synchronously inside the
 * completing round — the goal's terminal flow (and, for sub-goals, the parent
 * round's own follow-up inference) finishes first. Guarantees the scheduled
 * work never surfaces an unhandled rejection (`selfGradeGoal` already swallows
 * all errors).
 */
export function triggerSelfGrade(input: SelfGradeInput): void {
  setImmediate(() => {
    void selfGradeGoal(input).catch(() => {
      /* selfGradeGoal already swallows; defensive only */
    });
  });
}
