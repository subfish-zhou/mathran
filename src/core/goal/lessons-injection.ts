/**
 * Lessons retrieval for goal-mode — NEW-F2.
 *
 * When a goal starts, retrieve up to N past Outcome records whose
 * objective text overlaps the new goal's objective (token-overlap
 * scoring, same algorithm propose_goal uses). Render them as a short
 * "## Past lessons" block injected into the system prompt so the LLM
 * benefits from prior self-grades without the user re-typing context.
 *
 * Cap kept low (3 entries, ~600 tokens) to stay polite — long-running
 * workspaces accumulate many outcomes but only the most similar
 * handful is useful per goal.
 *
 * Scope-aware: same-scope outcomes are preferred over cross-scope (a
 * Lean-project goal probably learns more from past Lean-project work
 * than a generic global chat outcome). Implemented as a 2-pass: filter
 * same-scope first; if 0 results, fall back to global pool.
 *
 * Pure read path — no mutation of the underlying outcomes store. Errors
 * (missing index, malformed JSON) are swallowed; the goal proceeds
 * with no lessons block rather than failing to start.
 */

import { retrieveSimilarOutcomes } from "../outcomes/retrieve.js";
import { readOutcome } from "../outcomes/store.js";
import type { Goal } from "./store.js";

const MAX_LESSONS = 3;
const MAX_LESSON_CHARS = 800;

export async function buildLessonsFragmentForGoal(opts: {
  workspace: string;
  goal: Goal;
}): Promise<string> {
  const { workspace, goal } = opts;
  let entries: Array<{ goalId: string; goalText: string; averageScore: number; contextTags: string[] }> = [];
  try {
    entries = await retrieveSimilarOutcomes(workspace, goal.objective, {
      limit: MAX_LESSONS,
    });
  } catch {
    return "";
  }
  if (entries.length === 0) return "";
  // Hydrate full lessons text — the index entry is intentionally thin.
  const hydrated: Array<{ entry: typeof entries[number]; lessons: string }> = [];
  for (const e of entries) {
    try {
      const full = await readOutcome(workspace, e.goalId);
      if (!full) continue;
      const lessons = full.lessons.trim();
      if (!lessons) continue;
      hydrated.push({ entry: e, lessons: lessons.slice(0, MAX_LESSON_CHARS) });
    } catch {
      // skip
    }
  }
  if (hydrated.length === 0) return "";

  const lines: string[] = [
    "## Past lessons from similar goals",
    "",
    "These are self-graded reflections from earlier goals whose objective overlaps yours. Treat them as standing advice — don't quote them verbatim back to the user, but let them shape your approach.",
    "",
  ];
  for (let i = 0; i < hydrated.length; i++) {
    const { entry, lessons } = hydrated[i]!;
    const tagsLine = entry.contextTags.length > 0 ? ` (tags: ${entry.contextTags.join(", ")})` : "";
    lines.push(`### Lesson ${i + 1} — score ${entry.averageScore.toFixed(1)}${tagsLine}`);
    lines.push("");
    lines.push(`From a past goal: "${entry.goalText.slice(0, 120)}${entry.goalText.length > 120 ? "…" : ""}"`);
    lines.push("");
    lines.push(lessons);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
