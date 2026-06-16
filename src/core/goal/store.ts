/**
 * `mathran goal` — long-running, state-tracked agent runs (GAP #11).
 *
 * A Goal is a persistent record of one objective the assistant is working
 * toward, with a budget, an audit log of steps, and a reference to the chat
 * conversation(s) that produced them. Compared with a plain chat session a
 * Goal:
 *
 *   - has an explicit `objective` (frozen at start),
 *   - has explicit budgets (token + round caps),
 *   - records every assistant turn / tool call / tool result to disk so a
 *     later run (resume) can pick up exactly where it left off,
 *   - tracks status (active / paused / complete / failed / cancelled) and
 *     a single end-reason string.
 *
 * One Goal owns at least one chat conversation; the conversation jsonl is
 * the source of truth for replay, and `steps[]` is a denormalised audit
 * trail mirroring the same events for human reading. (`steps` is *derived*
 * — failures writing it do not fail the underlying chat flush.)
 *
 * Filesystem layout:
 *
 *   <workspace>/.mathran/goals/<goalId>.json     // this file
 *
 * The chat history lives in the existing scoped chat store:
 *
 *   <workspace>/.mathran/global-chat/<conversationId>.jsonl
 *   <workspace>/projects/<slug>/chat/<conversationId>.jsonl
 *   <workspace>/projects/<slug>/efforts/<eff>/chat/<conversationId>.jsonl
 *
 * `Goal.conversationIds` carries the reverse pointer.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type { ChatScope } from "../chat/store.js";

const GOALS_DIR = path.join(".mathran", "goals");

/** Persisted goal state. */
export interface Goal {
  id: string;
  /** Frozen at start time. */
  objective: string;
  scope: ChatScope;
  /**
   * "active"     started, currently being worked on or ready to be resumed
   * "paused"     explicit user pause (resume to continue)
   * "complete"   the assistant marked the goal complete or hit \"done\"
   * "failed"     unrecoverable error during the run
   * "cancelled"  user cancelled via \`mathran goal cancel\`
   * "exhausted"  budget hit before completion
   */
  status: "active" | "paused" | "complete" | "failed" | "cancelled" | "exhausted";
  /** Budgets and the model used for this run. `null` = no budget set. */
  budget: { tokensMax: number | null; roundsMax: number | null };
  model: string;
  createdAt: string;
  endedAt?: string;
  endReason?: string;
  stats: {
    tokensUsed: number;
    roundsRun: number;
    toolCallCount: number;
  };
  /** Chat conversation ids this goal spawned. The first one is the primary. */
  conversationIds: string[];
  /** Append-only step audit log. */
  steps: GoalStep[];
}

/** One row in the goal's audit log. */
export interface GoalStep {
  /** ISO timestamp. */
  at: string;
  kind:
    | "objective"
    | "text"
    | "tool-call"
    | "tool-result"
    | "plan"
    | "reflect"
    | "status";
  payload: Record<string, unknown> | string;
}

export interface GoalStoreOptions {
  workspace: string;
}

/** Path on disk for one goal. */
export function goalFileFor(workspace: string, goalId: string): string {
  return path.join(workspace, GOALS_DIR, `${goalId}.json`);
}

/** Path on disk for the goals directory. */
export function goalsDirFor(workspace: string): string {
  return path.join(workspace, GOALS_DIR);
}

/** Read one goal from disk. Returns null if not found. */
export async function readGoal(workspace: string, goalId: string): Promise<Goal | null> {
  try {
    const raw = await fs.readFile(goalFileFor(workspace, goalId), "utf-8");
    return JSON.parse(raw) as Goal;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** Write one goal to disk, creating the goals/ directory if needed. */
export async function writeGoal(workspace: string, goal: Goal): Promise<void> {
  const file = goalFileFor(workspace, goal.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(goal, null, 2) + "\n", "utf-8");
}

/** List all goals on disk, newest first. */
export async function listGoals(workspace: string): Promise<Goal[]> {
  const dir = goalsDirFor(workspace);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const goals: Goal[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf-8");
      const g = JSON.parse(raw) as Goal;
      goals.push(g);
    } catch {
      /* skip malformed */
    }
  }
  goals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return goals;
}

export interface CreateGoalInput {
  objective: string;
  scope: ChatScope;
  model: string;
  budgetTokensMax?: number | null;
  budgetRoundsMax?: number | null;
}

/**
 * Make a brand-new Goal on disk. The caller still has to actually drive it
 * (build a ChatSession, send the objective, append steps). This helper only
 * scaffolds the record.
 */
export async function createGoal(
  workspace: string,
  input: CreateGoalInput,
): Promise<Goal> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const goal: Goal = {
    id,
    objective: input.objective,
    scope: input.scope,
    status: "active",
    budget: {
      tokensMax: input.budgetTokensMax ?? null,
      roundsMax: input.budgetRoundsMax ?? null,
    },
    model: input.model,
    createdAt: now,
    stats: { tokensUsed: 0, roundsRun: 0, toolCallCount: 0 },
    conversationIds: [],
    steps: [
      { at: now, kind: "objective", payload: input.objective },
    ],
  };
  await writeGoal(workspace, goal);
  return goal;
}

/**
 * Append a step to the goal's audit log and persist.
 *
 * Failure to write is *not* propagated — the same convention as the chat
 * Markdown transcript (GAP #13). Goal.steps is a derived view; the chat
 * jsonl remains the source of truth.
 */
export async function appendStep(
  workspace: string,
  goalId: string,
  step: Omit<GoalStep, "at"> & { at?: string },
): Promise<void> {
  try {
    const g = await readGoal(workspace, goalId);
    if (!g) return;
    g.steps.push({ at: step.at ?? new Date().toISOString(), kind: step.kind, payload: step.payload });
    await writeGoal(workspace, g);
  } catch {
    /* swallow */
  }
}

/** Bump aggregate counters on the goal record. */
export async function updateGoalStats(
  workspace: string,
  goalId: string,
  delta: Partial<Goal["stats"]>,
): Promise<void> {
  const g = await readGoal(workspace, goalId);
  if (!g) return;
  g.stats = {
    tokensUsed: g.stats.tokensUsed + (delta.tokensUsed ?? 0),
    roundsRun: g.stats.roundsRun + (delta.roundsRun ?? 0),
    toolCallCount: g.stats.toolCallCount + (delta.toolCallCount ?? 0),
  };
  await writeGoal(workspace, g);
}

/** Mark the goal as ended with a final status + reason. */
export async function endGoal(
  workspace: string,
  goalId: string,
  status: Goal["status"],
  reason: string,
): Promise<Goal | null> {
  const g = await readGoal(workspace, goalId);
  if (!g) return null;
  g.status = status;
  g.endedAt = new Date().toISOString();
  g.endReason = reason;
  g.steps.push({
    at: g.endedAt,
    kind: "status",
    payload: { to: status, reason },
  });
  await writeGoal(workspace, g);
  return g;
}

/**
 * Attach a chat conversation id to the goal (idempotent).
 * Called when the runner spins up its first ChatSession so the goal can
 * point back at the chat jsonl on disk.
 */
export async function attachConversation(
  workspace: string,
  goalId: string,
  conversationId: string,
): Promise<void> {
  const g = await readGoal(workspace, goalId);
  if (!g) return;
  if (!g.conversationIds.includes(conversationId)) {
    g.conversationIds.push(conversationId);
    await writeGoal(workspace, g);
  }
}

/** Decide whether the goal still has budget to spend. */
export function withinBudget(g: Goal): { ok: true } | { ok: false; reason: string } {
  if (g.budget.tokensMax !== null && g.stats.tokensUsed >= g.budget.tokensMax) {
    return { ok: false, reason: `token budget exhausted (${g.stats.tokensUsed}/${g.budget.tokensMax})` };
  }
  if (g.budget.roundsMax !== null && g.stats.roundsRun >= g.budget.roundsMax) {
    return { ok: false, reason: `round budget exhausted (${g.stats.roundsRun}/${g.budget.roundsMax})` };
  }
  return { ok: true };
}
