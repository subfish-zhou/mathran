/**
 * Goal "ask" — natural-language status query — NEW-F7.
 *
 * Builds a compact read-only context bundle from a goal record so a
 * lightweight one-shot LLM call can answer questions like "how far
 * along is this?", "what files did it change?", "did it hit any
 * errors?", "what's the plan look like now?".
 *
 * Read-only: this lib only formats existing goal state. It does NOT
 * mutate the goal, write audit steps, or touch the conversation
 * history. The server endpoint that wraps it (POST /api/goals/:id/ask)
 * uses a fresh ChatSession against the user's chosen model and
 * discards everything when the answer streams back.
 */

import type { Goal } from "./store.js";
import { extractFilesChanged } from "./files-changed.js";

const MAX_RECENT_STEPS = 25;
const MAX_PLAN_CHARS = 4000;
const MAX_OBJECTIVE_CHARS = 600;

export function buildGoalAskContext(goal: Goal, opts: { planBody?: string } = {}): string {
  const lines: string[] = [];
  lines.push("# Goal-ask context (read-only)");
  lines.push("");
  lines.push("You are answering a user question about an in-flight or finished goal.");
  lines.push("Only the structured context below is authoritative; if you don't know, say so.");
  lines.push("Do NOT propose actions, write files, or call tools — this is a read-only query.");
  lines.push("");

  // 1. Goal identity + status
  lines.push("## Identity");
  lines.push("");
  lines.push(`- id: ${goal.id}`);
  lines.push(`- status: ${goal.status}`);
  lines.push(`- scope: ${formatScope(goal)}`);
  lines.push(`- model: ${goal.model}`);
  lines.push(`- createdAt: ${goal.createdAt}`);
  if (goal.endedAt) lines.push(`- endedAt: ${goal.endedAt}`);
  if (goal.endReason) lines.push(`- endReason: ${goal.endReason}`);
  lines.push("");

  // 2. Objective
  lines.push("## Objective");
  lines.push("");
  lines.push(goal.objective.slice(0, MAX_OBJECTIVE_CHARS));
  if (goal.objective.length > MAX_OBJECTIVE_CHARS) lines.push("…(truncated)");
  lines.push("");

  // 3. Stats snapshot
  lines.push("## Progress stats");
  lines.push("");
  lines.push(`- iterationsRun: ${goal.stats.iterationsRun}`);
  lines.push(`- assistantTurnsTotal: ${goal.stats.assistantTurnsTotal}`);
  lines.push(`- llmCallsTotal: ${goal.stats.llmCallsTotal}`);
  lines.push(`- toolCallCount: ${goal.stats.toolCallCount}`);
  lines.push(`- tokensUsed: ${goal.stats.tokensUsed}`);
  if (goal.budget.tokensMax) lines.push(`- tokensMax: ${goal.budget.tokensMax}`);
  if (goal.budget.roundsMax) lines.push(`- roundsMax: ${goal.budget.roundsMax}`);
  if (goal.stats.compactionRuns > 0) {
    lines.push(`- compactionRuns: ${goal.stats.compactionRuns}`);
    lines.push(`- compactionTokensDropped: ${goal.stats.compactionTokensDropped}`);
  }
  lines.push("");

  // 4. Plan summary (if any). Caller supplies the body so we don't need
  //    a filesystem dependency in this pure formatter.
  if (opts.planBody && opts.planBody.trim().length > 0) {
    lines.push("## Active plan (truncated to first 4000 chars)");
    lines.push("");
    lines.push(opts.planBody.slice(0, MAX_PLAN_CHARS));
    if (opts.planBody.length > MAX_PLAN_CHARS) lines.push("…(truncated)");
    lines.push("");
  }

  // 5. Files changed summary (top 10 by recency).
  const changed = extractFilesChanged(goal).slice(0, 10);
  if (changed.length > 0) {
    lines.push("## Files changed (top 10 most recent)");
    lines.push("");
    for (const e of changed) {
      const status = e.ok ? "ok" : "FAILED";
      lines.push(`- ${e.path}  [${e.op} via ${e.tool}, x${e.writeCount}, ${status}, at ${e.at}]`);
    }
    lines.push("");
  }

  // 6. Recent audit steps (compact projection).
  const recent = goal.steps.slice(-MAX_RECENT_STEPS);
  if (recent.length > 0) {
    lines.push(`## Recent audit steps (last ${recent.length})`);
    lines.push("");
    for (const s of recent) {
      lines.push(`- [${s.at}] ${s.kind}${formatStepPayload(s)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function formatScope(goal: Goal): string {
  if (goal.scope.kind === "global") return "global";
  if (goal.scope.kind === "project") return `project:${goal.scope.projectSlug}`;
  return `effort:${goal.scope.projectSlug}/${goal.scope.effortSlug}`;
}

function formatStepPayload(step: { kind: string; payload?: unknown }): string {
  if (!step.payload || typeof step.payload !== "object") return "";
  const p = step.payload as Record<string, unknown>;
  // Project commonly-useful fields without dumping huge JSON.
  const pick = (k: string): string => {
    const v = p[k];
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return ` ${k}=${v.slice(0, 80)}`;
    if (typeof v === "number" || typeof v === "boolean") return ` ${k}=${v}`;
    return "";
  };
  const interesting = ["name", "ok", "to", "from", "reason", "error", "summary", "totalDroppedTokens"];
  let out = "";
  for (const k of interesting) out += pick(k);
  return out;
}
