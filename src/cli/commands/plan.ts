/**
 * `mathran plan` — read-only planning ChatSession on top of the curated
 * `search` + `read_file_summary` built-in tools (v0.3 §13).
 *
 * Sub-commands:
 *
 *   mathran plan "<objective>"         — run the planning runner, save draft
 *   mathran plan list                   — list plans on disk
 *   mathran plan show <plan-id>         — print the markdown body
 *   mathran plan accept <plan-id>        — promote draft to effort + seed goal
 *   mathran plan reject <plan-id>        — shelve the draft
 *
 * The accept flow needs `--project` because efforts live under a project.
 * Effort type defaults to AUXILIARY (which is the catch-all bucket and is
 * always valid in the type allow-list).
 */

import * as os from "node:os";
import * as path from "node:path";

import { PlanStore } from "../../core/plan/store.js";
import { runPlan } from "../../core/plan/runner.js";
import { initEffort, appendEffortDocument } from "../../core/effort/store.js";
import {
  BUILTIN_EFFORT_TYPES,
  isBuiltinEffortType,
  type BuiltinEffortType,
} from "../../core/effort/types.js";
import { createGoal } from "../../core/goal/store.js";
import { loadConfig } from "../../core/config.js";
import { ModelRouter } from "../../providers/index.js";

const DEFAULT_MODEL = "copilot/gpt-5.5";

function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return path.resolve(explicit);
  const env = process.env.MATHRAN_WORKSPACE;
  if (env && env.length > 0) return path.resolve(env);
  return path.join(os.homedir(), "mathran-workspace");
}

/**
 * Resolve a plan id from a possibly-prefixed input. Exact match on disk
 * wins; otherwise we fall back to a unique-prefix scan. Returns the full id
 * when resolved, otherwise null.
 */
async function resolvePlanId(store: PlanStore, raw: string): Promise<string | null> {
  // Fast path: exact match.
  if (await store.get(raw)) return raw;
  if (raw.length < 4) return null;
  const all = await store.list();
  const hits = all.filter((p) => p.id.startsWith(raw));
  if (hits.length === 1) return hits[0].id;
  return null;
}

// ── plan run ─────────────────────────────────────────────────────────────

export interface PlanRunOptions {
  workspace?: string;
  configPath?: string;
  model?: string;
  maxTurns?: number;
}

/**
 * `mathran plan "<objective>"` — drive the planning runner end-to-end and
 * print a summary on completion. Returns a process exit code.
 */
export async function runPlanRun(objective: string, opts: PlanRunOptions): Promise<number> {
  if (!objective || !objective.trim()) {
    console.error("mathran plan: objective is required");
    return 2;
  }
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const config = loadConfig(opts.configPath);
  const model = opts.model ?? config.defaultModel ?? DEFAULT_MODEL;
  const router = new ModelRouter(config);

  console.log(`mathran: planning '${objective.split("\n")[0].slice(0, 80)}'`);
  console.log(`  model: ${model}`);

  try {
    const r = await runPlan({
      objective,
      workspace,
      llm: router,
      model,
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    });
    console.log("");
    console.log(`Plan ${r.planId} (turns=${r.turns}${r.truncated ? ", truncated" : ""}${r.aborted ? ", aborted" : ""}):`);
    console.log("");
    console.log(r.body || "(empty plan)");
    console.log("");
    console.log(`Accept with: mathran plan accept ${r.planId} --project <slug>`);
    console.log(`Or reject:   mathran plan reject ${r.planId}`);
    return 0;
  } catch (err: any) {
    console.error(`mathran plan: ${err?.message ?? err}`);
    return 1;
  }
}

// ── plan list ─────────────────────────────────────────────────────────────

export interface PlanListOptions {
  workspace?: string;
  json?: boolean;
  /** When true, include accepted/rejected plans; default true (lists everything). */
  all?: boolean;
}

export async function runPlanList(opts: PlanListOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const store = new PlanStore({ workspace });
  const all = await store.list();
  const plans = opts.all === false ? all.filter((p) => p.status === "draft") : all;
  if (opts.json) {
    console.log(JSON.stringify({ plans }, null, 2));
    return 0;
  }
  if (plans.length === 0) {
    console.log("No plans yet.");
    return 0;
  }
  console.log(`Plans (${plans.length}):`);
  for (const p of plans) {
    const obj = p.objective.split("\n")[0].slice(0, 70);
    const eff = p.acceptedEffortId ? `→ effort ${p.acceptedEffortId}` : "";
    console.log(`  ${p.id}  [${p.status.padEnd(8)}] ${obj} ${eff}`.trimEnd());
  }
  return 0;
}

// ── plan show ─────────────────────────────────────────────────────────────

export interface PlanShowOptions {
  workspace?: string;
}

export async function runPlanShow(planId: string, opts: PlanShowOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const store = new PlanStore({ workspace });
  const resolved = await resolvePlanId(store, planId);
  if (!resolved) {
    console.error(`mathran plan show: not found or ambiguous: ${planId}`);
    return 1;
  }
  const p = await store.get(resolved);
  if (!p) {
    console.error(`mathran plan show: not found: ${resolved}`);
    return 1;
  }
  console.log(`# Plan ${p.id}`);
  console.log(`- objective: ${p.objective}`);
  console.log(`- status: ${p.status}`);
  console.log(`- createdAt: ${p.createdAt}`);
  console.log(`- updatedAt: ${p.updatedAt}`);
  if (p.modelHint) console.log(`- modelHint: ${p.modelHint}`);
  if (p.acceptedEffortId) console.log(`- effort: ${p.acceptedEffortId}`);
  console.log("");
  console.log(p.body || "(empty)");
  return 0;
}

// ── plan accept ───────────────────────────────────────────────────────────

export interface PlanAcceptOptions {
  workspace?: string;
  configPath?: string;
  /** Project slug to create the new effort in. Required. */
  project?: string;
  /** Override the effort slug (defaults to a slugification of the objective). */
  effortSlug?: string;
  /** Effort type. Defaults to AUXILIARY for plan-derived efforts. */
  effortType?: string;
  /** Override the model recorded on the seed goal. */
  model?: string;
}

/**
 * `mathran plan accept <plan-id>` — promote a draft plan into an effort.
 *
 * Steps (kept transparent in the result file so anyone debugging knows the
 * exact effort/goal API names we use):
 *
 *   1. `PlanStore.get(id)` → require status === "draft"
 *   2. `initEffort(workspace, project, { title, type, slug? })` → new effort
 *      under `<workspace>/projects/<project>/efforts/<slug>/`
 *   3. `appendEffortDocument(workspace, project, slug, "# Plan\\n...\\n")` →
 *      seed `document.md` with the plan body as the outline
 *   4. `createGoal(workspace, { objective, scope, model })` → seed goal in
 *      the new effort scope (status="active", no budgets by default)
 *   5. `PlanStore.accept(id, effortSlug)` → mark plan accepted, link it
 */
export async function runPlanAccept(planId: string, opts: PlanAcceptOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  if (!opts.project) {
    console.error("mathran plan accept: --project <slug> is required");
    return 2;
  }
  const projectSlug = opts.project;

  const store = new PlanStore({ workspace });
  const resolved = await resolvePlanId(store, planId);
  if (!resolved) {
    console.error(`mathran plan accept: not found or ambiguous: ${planId}`);
    return 1;
  }
  const plan = await store.get(resolved);
  if (!plan) {
    console.error(`mathran plan accept: not found: ${resolved}`);
    return 1;
  }
  if (plan.status !== "draft") {
    console.error(`mathran plan accept: plan ${plan.id} is ${plan.status}; cannot accept`);
    return 1;
  }

  const typeRaw = (opts.effortType ?? "AUXILIARY").toUpperCase();
  if (!isBuiltinEffortType(typeRaw)) {
    console.error(
      `mathran plan accept: invalid --effort-type "${typeRaw}". Must be one of: ${BUILTIN_EFFORT_TYPES.join(", ")}`,
    );
    return 1;
  }
  const effortType = typeRaw as BuiltinEffortType;

  // 1. Create effort.
  let effortSlug: string;
  let effortDir: string;
  try {
    const result = await initEffort(workspace, projectSlug, {
      title: plan.objective,
      type: effortType,
      ...(opts.effortSlug ? { slug: opts.effortSlug } : {}),
      description: `Seeded from plan ${plan.id}.`,
    });
    effortSlug = result.slug;
    effortDir = result.effortDir;
  } catch (err: any) {
    console.error(`mathran plan accept: effort creation failed: ${err?.message ?? err}`);
    return 1;
  }

  // 2. Seed document.md with the plan body. We use appendEffortDocument so we
  //    stay on the exact same atomic-write helper effort/store.ts uses; it
  //    also bumps `updatedAt` for free.
  const seed =
    `# Plan (from ${plan.id})\n\n` +
    `**Objective:** ${plan.objective}\n\n` +
    `*Created from plan ${plan.id} on ${new Date().toISOString()}.*\n\n` +
    (plan.body.trim().length > 0 ? plan.body.trim() + "\n" : "_(plan body was empty)_\n");
  try {
    await appendEffortDocument(workspace, projectSlug, effortSlug, seed);
  } catch (err: any) {
    console.error(`mathran plan accept: seeding document.md failed: ${err?.message ?? err}`);
    return 1;
  }

  // 3. Seed goal in the new effort scope.
  const config = loadConfig(opts.configPath);
  const model = opts.model ?? config.defaultModel ?? DEFAULT_MODEL;
  let goalId: string;
  try {
    const goal = await createGoal(workspace, {
      objective: plan.objective,
      scope: { kind: "effort", projectSlug, effortSlug },
      model,
    });
    goalId = goal.id;
  } catch (err: any) {
    console.error(`mathran plan accept: goal creation failed: ${err?.message ?? err}`);
    return 1;
  }

  // 4. Flip plan to accepted.
  await store.accept(plan.id, effortSlug);

  console.log(`Plan accepted → effort ${effortSlug}, goal ${goalId}`);
  console.log(`  effortDir: ${effortDir}`);
  console.log(`  resume with: mathran goal resume ${goalId}`);
  return 0;
}

// ── plan reject ───────────────────────────────────────────────────────────

export interface PlanRejectOptions {
  workspace?: string;
}

export async function runPlanReject(planId: string, opts: PlanRejectOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const store = new PlanStore({ workspace });
  const resolved = await resolvePlanId(store, planId);
  if (!resolved) {
    console.error(`mathran plan reject: not found or ambiguous: ${planId}`);
    return 1;
  }
  try {
    const p = await store.reject(resolved);
    console.log(`Plan ${p.id} rejected.`);
    return 0;
  } catch (err: any) {
    console.error(`mathran plan reject: ${err?.message ?? err}`);
    return 1;
  }
}
