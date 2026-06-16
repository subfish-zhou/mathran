/**
 * `mathran goal start|status|list|pause|resume|cancel` — long-running
 * agent runs tracked on disk (GAP #11).
 *
 * Layout:
 *
 *   <workspace>/.mathran/goals/<goalId>.json     — the goal record
 *   <workspace>/.mathran/global-chat/<id>.jsonl   — backing chat
 *   <workspace>/projects/<slug>/chat/<id>.jsonl   — (scope=project)
 *   <workspace>/projects/<slug>/efforts/<eff>/chat/<id>.jsonl — (scope=effort)
 *
 * "start" both creates the goal record and runs the first round. "resume"
 * reuses the goal id and runs another round. "pause" / "cancel" / "status"
 * are filesystem-only and do not touch the LLM.
 */

import * as os from "node:os";
import * as path from "node:path";

import { ChatSession, createLeanCheckTool } from "../../core/chat/index.js";
import {
  createGoal,
  endGoal,
  listGoals,
  readGoal,
  writeGoal,
  type Goal,
} from "../../core/goal/store.js";
import { runGoalRound } from "../../core/goal/runner.js";
import type { ChatScope } from "../../core/chat/store.js";
import { loadConfig } from "../../core/config.js";
import { ModelRouter, LocalLeanProvider } from "../../providers/index.js";

const DEFAULT_MODEL = "copilot/gpt-5.5";

function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return path.resolve(explicit);
  const env = process.env.MATHRAN_WORKSPACE;
  if (env && env.length > 0) return path.resolve(env);
  return path.join(os.homedir(), "mathran-workspace");
}

/**
 * Parse the `--scope` flag value. Accepts:
 *
 *   "global"
 *   "project:<slug>"
 *   "effort:<projectSlug>/<effortSlug>"
 */
export function parseScope(raw: string | undefined): ChatScope {
  if (!raw || raw === "global") return { kind: "global" };
  if (raw.startsWith("project:")) {
    const slug = raw.slice("project:".length).trim();
    if (!slug) throw new Error(`invalid --scope: missing project slug`);
    return { kind: "project", projectSlug: slug };
  }
  if (raw.startsWith("effort:")) {
    const rest = raw.slice("effort:".length).trim();
    const slash = rest.indexOf("/");
    if (slash < 0) throw new Error(`invalid --scope: effort needs <project>/<effort>`);
    const projectSlug = rest.slice(0, slash).trim();
    const effortSlug = rest.slice(slash + 1).trim();
    if (!projectSlug || !effortSlug) throw new Error(`invalid --scope: empty slug`);
    return { kind: "effort", projectSlug, effortSlug };
  }
  throw new Error(`invalid --scope: ${raw}. Expected global | project:<slug> | effort:<p>/<e>`);
}

/**
 * Resolve a possibly-prefixed goal id against the goals/ directory. Returns
 * the full id if exactly one match is found, otherwise `null` (caller should
 * surface a useful error). Exact-match always wins to preserve correctness
 * once goal ids stop being globally unique short strings.
 */
async function resolveGoalId(workspace: string, raw: string): Promise<string | null> {
  // Fast path: exact id present on disk.
  if (await readGoal(workspace, raw)) return raw;
  if (raw.length < 4) return null;
  const all = await listGoals(workspace);
  const hits = all.filter((g) => g.id.startsWith(raw));
  if (hits.length === 1) return hits[0].id;
  return null;
}

export interface GoalStartOptions {
  workspace?: string;
  scope?: string;
  budgetTokens?: number;
  maxRounds?: number;
  model?: string;
  configPath?: string;
  /** When true, only create the record; do not run the first round. */
  noRun?: boolean;
}

/**
 * `mathran goal start "<objective>"` — create a goal record AND drive the
 * first round (unless --no-run).
 */
export async function runGoalStart(objective: string, opts: GoalStartOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  let scope: ChatScope;
  try {
    scope = parseScope(opts.scope);
  } catch (err: any) {
    console.error(`mathran goal start: ${err?.message ?? err}`);
    return 2;
  }
  const config = loadConfig(opts.configPath);
  const model = opts.model ?? config.defaultModel ?? DEFAULT_MODEL;

  const goal = await createGoal(workspace, {
    objective,
    scope,
    model,
    budgetTokensMax: opts.budgetTokens ?? null,
    budgetRoundsMax: opts.maxRounds ?? null,
  });
  console.log(`mathran: created goal ${goal.id}`);
  console.log(`  objective: ${goal.objective}`);
  console.log(`  scope:     ${formatScope(goal.scope)}`);
  console.log(`  model:     ${goal.model}`);
  if (goal.budget.tokensMax !== null) console.log(`  tokensMax: ${goal.budget.tokensMax}`);
  if (goal.budget.roundsMax !== null) console.log(`  roundsMax: ${goal.budget.roundsMax}`);
  console.log(`  file:      ${workspace}/.mathran/goals/${goal.id}.json`);

  if (opts.noRun) {
    console.log(`mathran: goal created (no round run; use 'mathran goal resume ${goal.id}' to start)`);
    return 0;
  }

  return await driveOneRound(workspace, goal.id, objective, opts);
}

export interface GoalResumeOptions {
  workspace?: string;
  configPath?: string;
  message?: string;
}

/**
 * `mathran goal resume <goalId>` — drive another round of work.
 *
 * The default prompt is "continue with the current objective"; --message
 * overrides it. Refuses to run when goal is not active.
 */
export async function runGoalResume(goalId: string, opts: GoalResumeOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const resolved = await resolveGoalId(workspace, goalId);
  if (!resolved) {
    console.error(`mathran goal resume: not found or ambiguous: ${goalId}`);
    return 1;
  }
  const g = await readGoal(workspace, resolved);
  if (!g) {
    console.error(`mathran goal resume: not found: ${resolved}`);
    return 1;
  }
  if (g.status !== "active") {
    console.error(`mathran goal resume: goal is ${g.status} (${g.endReason ?? "no reason"}); cannot resume`);
    return 1;
  }
  const userMessage = opts.message ?? "Continue with the current objective.";
  return await driveOneRound(workspace, resolved, userMessage, opts);
}

async function driveOneRound(
  workspace: string,
  goalId: string,
  userMessage: string,
  opts: { configPath?: string },
): Promise<number> {
  const config = loadConfig(opts.configPath);
  const router = new ModelRouter(config);
  const lean = new LocalLeanProvider();
  const tools = [createLeanCheckTool(lean)];

  try {
    const r = await runGoalRound({
      workspace,
      goalId,
      userMessage,
      llm: router,
      tools,
    });
    if (r.text.trim().length > 0) {
      console.log("");
      console.log(r.text.trim());
      console.log("");
    }
    if (r.completed) {
      console.log(`mathran: goal COMPLETE — ${r.endReason}`);
      return 0;
    }
    if (r.failed) {
      console.log(`mathran: goal FAILED — ${r.endReason}`);
      return 0;
    }
    if (r.exhausted) {
      console.log(`mathran: goal EXHAUSTED — ${r.endReason}`);
      return 0;
    }
    console.log(`mathran: round done. Stats: ${r.goal.stats.roundsRun} rounds, ${r.goal.stats.tokensUsed} tokens, ${r.goal.stats.toolCallCount} tool calls.`);
    console.log(`mathran: resume with 'mathran goal resume ${goalId}'.`);
    return 0;
  } catch (err: any) {
    console.error(`mathran goal: round failed: ${err?.message ?? err}`);
    // Mark failed so the goal isn't left in a half-stuck "active" state.
    await endGoal(workspace, goalId, "failed", String(err?.message ?? err));
    return 1;
  }
}

export interface GoalStatusOptions {
  workspace?: string;
  json?: boolean;
}

export async function runGoalStatus(goalId: string, opts: GoalStatusOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const resolved = await resolveGoalId(workspace, goalId);
  if (!resolved) {
    console.error(`mathran goal status: not found or ambiguous: ${goalId}`);
    return 1;
  }
  const g = await readGoal(workspace, resolved);
  if (!g) {
    console.error(`mathran goal status: not found: ${resolved}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(g, null, 2));
    return 0;
  }
  printGoalSummary(g);
  return 0;
}

export interface GoalListOptions {
  workspace?: string;
  json?: boolean;
  /** When true, include ended goals; default false. */
  all?: boolean;
}

export async function runGoalList(opts: GoalListOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const goals = await listGoals(workspace);
  const filtered = opts.all ? goals : goals.filter((g) => g.status === "active" || g.status === "paused");
  if (opts.json) {
    console.log(JSON.stringify({ goals: filtered }, null, 2));
    return 0;
  }
  if (filtered.length === 0) {
    console.log(opts.all ? "No goals." : "No active goals. (use --all to see ended goals)");
    return 0;
  }
  console.log(`Goals (${filtered.length}):`);
  for (const g of filtered) {
    const shortId = g.id.slice(0, 8);
    const objLine = g.objective.split("\n")[0].slice(0, 80);
    console.log(`  ${shortId}  [${g.status.padEnd(9)}] r=${g.stats.roundsRun} t=${g.stats.tokensUsed}  ${objLine}`);
  }
  return 0;
}

export interface GoalSimpleOptions {
  workspace?: string;
}

export async function runGoalPause(goalId: string, opts: GoalSimpleOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const resolved = await resolveGoalId(workspace, goalId);
  if (!resolved) {
    console.error(`mathran goal pause: not found or ambiguous: ${goalId}`);
    return 1;
  }
  const g = await readGoal(workspace, resolved);
  if (!g) {
    console.error(`mathran goal pause: not found: ${resolved}`);
    return 1;
  }
  if (g.status !== "active") {
    console.error(`mathran goal pause: goal is ${g.status}; can only pause active goals`);
    return 1;
  }
  g.status = "paused";
  g.steps.push({ at: new Date().toISOString(), kind: "status", payload: { to: "paused", reason: "user pause" } });
  await writeGoal(workspace, g);
  console.log(`mathran: paused ${resolved}. Resume with 'mathran goal resume ${resolved}'.`);
  return 0;
}

export async function runGoalCancel(goalId: string, opts: GoalSimpleOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const resolved = await resolveGoalId(workspace, goalId);
  if (!resolved) {
    console.error(`mathran goal cancel: not found or ambiguous: ${goalId}`);
    return 1;
  }
  const g = await readGoal(workspace, resolved);
  if (!g) {
    console.error(`mathran goal cancel: not found: ${resolved}`);
    return 1;
  }
  if (g.status === "complete" || g.status === "failed" || g.status === "cancelled" || g.status === "exhausted") {
    console.error(`mathran goal cancel: goal already ${g.status}`);
    return 1;
  }
  const ended = await endGoal(workspace, resolved, "cancelled", "user cancelled");
  console.log(`mathran: cancelled ${ended?.id}`);
  return 0;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function formatScope(s: ChatScope): string {
  if (s.kind === "global") return "global";
  if (s.kind === "project") return `project:${s.projectSlug}`;
  return `effort:${s.projectSlug}/${s.effortSlug}`;
}

function printGoalSummary(g: Goal): void {
  console.log(`Goal ${g.id}`);
  console.log(`  status:     ${g.status}`);
  console.log(`  objective:  ${g.objective}`);
  console.log(`  scope:      ${formatScope(g.scope)}`);
  console.log(`  model:      ${g.model}`);
  console.log(`  budget:     tokens=${g.budget.tokensMax ?? "∞"}  rounds=${g.budget.roundsMax ?? "∞"}`);
  console.log(`  spent:      ${g.stats.tokensUsed} tokens, ${g.stats.roundsRun} rounds, ${g.stats.toolCallCount} tool calls`);
  console.log(`  createdAt:  ${g.createdAt}`);
  if (g.endedAt) {
    console.log(`  endedAt:    ${g.endedAt}`);
    console.log(`  endReason:  ${g.endReason ?? ""}`);
  }
  console.log(`  conversations: ${g.conversationIds.length}`);
  console.log(`  steps:      ${g.steps.length}`);
  console.log(`  last 5 steps:`);
  for (const s of g.steps.slice(-5)) {
    const pl = typeof s.payload === "string" ? s.payload.split("\n")[0].slice(0, 80) : JSON.stringify(s.payload).slice(0, 80);
    console.log(`    ${s.at.slice(11, 19)}  [${s.kind.padEnd(11)}]  ${pl}`);
  }
}
