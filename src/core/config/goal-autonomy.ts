/**
 * v0.17 mathub parity W11 — per-scope goal autonomy config.
 *
 * Lets the user set default goal-loop behaviour per workspace and globally:
 *
 *  - `enabled`           — gate auto-promote / suggest-goal flows
 *  - `autonomyLevel`     — manual / conservative / balanced / aggressive
 *                          (drives the prompt fragment runners splice in)
 *  - `summaryGranularity`— realtime / hourly / daily (forward-compat field;
 *                          runner does not consume yet)
 *  - `summaryIntervalMs` — companion to granularity (>= 1min)
 *  - `defaultMaxRounds`  — fallback when caller doesn't pass `maxRounds`
 *  - `defaultTokensCap?` — fallback when caller doesn't pass `budgetTokens`
 *
 * Two-layer storage (project + global). The "project" layer here means
 * **the current workspace** (not per-project-slug), matching how
 * workspace-scoped state already lives under `<workspace>/.mathran/`:
 *
 *  - Global  : `<HOME>/.mathran/goal-autonomy.json`
 *  - Project : `<workspace>/.mathran/goal-autonomy.json`
 *
 * `loadGoalAutonomy()` returns the effective view (project ∪ global ∪
 * DEFAULT, in that precedence) plus each raw layer so callers can render
 * "where did this value come from?" badges.
 *
 * Never throws on I/O: missing / corrupt files are treated as "layer
 * absent", falling back to the next layer. This matches the MATHRAN.md
 * loader convention in `src/core/memory/index.ts`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWriteFile } from "../chat/atomic-write.js";

// ───────────────────────────────────────────────────────────────────────────
// Schema
// ───────────────────────────────────────────────────────────────────────────

export type AutonomyLevel =
  | "manual"
  | "conservative"
  | "balanced"
  | "aggressive";

export type SummaryGranularity = "realtime" | "hourly" | "daily";

export interface GoalAutonomyConfig {
  enabled: boolean;
  autonomyLevel: AutonomyLevel;
  summaryGranularity: SummaryGranularity;
  /** >= 60_000 (one minute). */
  summaryIntervalMs: number;
  /** >= 1. */
  defaultMaxRounds: number;
  /** When set, must be > 0. Omitted = no token cap fallback. */
  defaultTokensCap?: number;
  /** Last-write timestamp (epoch ms). 0 for the in-code default. */
  updatedAt: number;
}

export const DEFAULT_GOAL_AUTONOMY: GoalAutonomyConfig = {
  enabled: true,
  autonomyLevel: "balanced",
  summaryGranularity: "realtime",
  summaryIntervalMs: 30 * 60 * 1000,
  defaultMaxRounds: 12,
  updatedAt: 0,
};

/**
 * The on-disk shape of a raw layer file. Stores ONLY the keys the user
 * explicitly set, so a partial project layer can correctly fall back to
 * global for the keys it doesn't override. `updatedAt` is always present.
 */
export interface StoredGoalAutonomyLayer {
  enabled?: boolean;
  autonomyLevel?: AutonomyLevel;
  summaryGranularity?: SummaryGranularity;
  summaryIntervalMs?: number;
  defaultMaxRounds?: number;
  defaultTokensCap?: number;
  updatedAt: number;
}

/** Which on-disk layer a saved override lives in. */
export type GoalAutonomyLayer = "global" | "project";

/** Combined load result — effective merged view + each raw layer. */
export interface GoalAutonomyLoadResult {
  effective: GoalAutonomyConfig;
  global: StoredGoalAutonomyLayer | null;
  project: StoredGoalAutonomyLayer | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Path resolution
// ───────────────────────────────────────────────────────────────────────────

export interface ScopePaths {
  workspace: string;
  /** Override HOME for tests. */
  home?: string;
}

export function globalGoalAutonomyPath(home?: string): string {
  return path.join(home ?? os.homedir(), ".mathran", "goal-autonomy.json");
}

export function projectGoalAutonomyPath(workspace: string): string {
  return path.join(workspace, ".mathran", "goal-autonomy.json");
}

// ───────────────────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────────────────

const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  "manual",
  "conservative",
  "balanced",
  "aggressive",
] as const;

const SUMMARY_GRANULARITIES: readonly SummaryGranularity[] = [
  "realtime",
  "hourly",
  "daily",
] as const;

/** Minimum allowed `summaryIntervalMs` — one minute. */
export const MIN_SUMMARY_INTERVAL_MS = 60_000;

/** True if `v` is a finite integer >= `min`. */
function isFiniteIntAtLeast(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= min;
}

/**
 * Validate a `Partial<GoalAutonomyConfig>` patch. Returns the parsed
 * patch with unknown keys stripped, or an error string for the first
 * offending field. Caller decides whether to merge into a layer.
 *
 * `updatedAt` is intentionally NOT accepted from the wire — it's
 * server-stamped at write time so two writers can't backdate each other.
 */
export function validateGoalAutonomyPatch(
  raw: unknown,
):
  | { ok: true; patch: Partial<GoalAutonomyConfig> }
  | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "patch must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;
  const out: Partial<GoalAutonomyConfig> = {};

  if ("enabled" in r) {
    if (typeof r.enabled !== "boolean") {
      return { ok: false, error: "'enabled' must be a boolean" };
    }
    out.enabled = r.enabled;
  }
  if ("autonomyLevel" in r) {
    if (typeof r.autonomyLevel !== "string" ||
        !AUTONOMY_LEVELS.includes(r.autonomyLevel as AutonomyLevel)) {
      return {
        ok: false,
        error: `'autonomyLevel' must be one of: ${AUTONOMY_LEVELS.join(", ")}`,
      };
    }
    out.autonomyLevel = r.autonomyLevel as AutonomyLevel;
  }
  if ("summaryGranularity" in r) {
    if (typeof r.summaryGranularity !== "string" ||
        !SUMMARY_GRANULARITIES.includes(r.summaryGranularity as SummaryGranularity)) {
      return {
        ok: false,
        error: `'summaryGranularity' must be one of: ${SUMMARY_GRANULARITIES.join(", ")}`,
      };
    }
    out.summaryGranularity = r.summaryGranularity as SummaryGranularity;
  }
  if ("summaryIntervalMs" in r) {
    if (!isFiniteIntAtLeast(r.summaryIntervalMs, MIN_SUMMARY_INTERVAL_MS)) {
      return {
        ok: false,
        error: `'summaryIntervalMs' must be an integer >= ${MIN_SUMMARY_INTERVAL_MS}`,
      };
    }
    out.summaryIntervalMs = r.summaryIntervalMs;
  }
  if ("defaultMaxRounds" in r) {
    if (!isFiniteIntAtLeast(r.defaultMaxRounds, 1)) {
      return { ok: false, error: "'defaultMaxRounds' must be an integer >= 1" };
    }
    out.defaultMaxRounds = r.defaultMaxRounds;
  }
  if ("defaultTokensCap" in r) {
    // Treat null / undefined as "clear this field" (sentinel: explicit null).
    if (r.defaultTokensCap === null || r.defaultTokensCap === undefined) {
      out.defaultTokensCap = undefined;
    } else if (!isFiniteIntAtLeast(r.defaultTokensCap, 1)) {
      return {
        ok: false,
        error: "'defaultTokensCap' must be an integer >= 1, or null to clear",
      };
    } else {
      out.defaultTokensCap = r.defaultTokensCap;
    }
  }

  return { ok: true, patch: out };
}

/**
 * Coerce a parsed-from-disk record to a `StoredGoalAutonomyLayer`. Keys
 * that fail validation are silently dropped (we never want a corrupt
 * on-disk file to brick the runner). Returns `null` when the input
 * isn't even an object.
 *
 * NB: this preserves the sparse shape — only keys the user explicitly
 * set survive — so the merge can correctly fall back across layers.
 */
export function parseStoredGoalAutonomy(
  raw: unknown,
): StoredGoalAutonomyLayer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: StoredGoalAutonomyLayer = {
    updatedAt: isFiniteIntAtLeast(r.updatedAt, 0) ? r.updatedAt : 0,
  };

  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (
    typeof r.autonomyLevel === "string" &&
    AUTONOMY_LEVELS.includes(r.autonomyLevel as AutonomyLevel)
  ) {
    out.autonomyLevel = r.autonomyLevel as AutonomyLevel;
  }
  if (
    typeof r.summaryGranularity === "string" &&
    SUMMARY_GRANULARITIES.includes(r.summaryGranularity as SummaryGranularity)
  ) {
    out.summaryGranularity = r.summaryGranularity as SummaryGranularity;
  }
  if (isFiniteIntAtLeast(r.summaryIntervalMs, MIN_SUMMARY_INTERVAL_MS)) {
    out.summaryIntervalMs = r.summaryIntervalMs;
  }
  if (isFiniteIntAtLeast(r.defaultMaxRounds, 1)) {
    out.defaultMaxRounds = r.defaultMaxRounds;
  }
  if (isFiniteIntAtLeast(r.defaultTokensCap, 1)) {
    out.defaultTokensCap = r.defaultTokensCap;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Disk I/O
// ───────────────────────────────────────────────────────────────────────────

async function readJsonOrNull(file: string): Promise<unknown | null> {
  try {
    const txt = await fs.readFile(file, "utf-8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function readLayer(file: string): Promise<StoredGoalAutonomyLayer | null> {
  const raw = await readJsonOrNull(file);
  return raw === null ? null : parseStoredGoalAutonomy(raw);
}

/** Apply a sparse layer onto an accumulator in place. */
function applyLayer(
  eff: GoalAutonomyConfig,
  layer: StoredGoalAutonomyLayer | null,
): void {
  if (!layer) return;
  if (typeof layer.enabled === "boolean") eff.enabled = layer.enabled;
  if (layer.autonomyLevel) eff.autonomyLevel = layer.autonomyLevel;
  if (layer.summaryGranularity) eff.summaryGranularity = layer.summaryGranularity;
  if (typeof layer.summaryIntervalMs === "number") eff.summaryIntervalMs = layer.summaryIntervalMs;
  if (typeof layer.defaultMaxRounds === "number") eff.defaultMaxRounds = layer.defaultMaxRounds;
  if (typeof layer.defaultTokensCap === "number") eff.defaultTokensCap = layer.defaultTokensCap;
}

/**
 * Three-layer merge: project ∪ global ∪ DEFAULT. Each field independently
 * falls through — a key absent in `project` inherits from `global` and
 * then from `DEFAULT_GOAL_AUTONOMY`. `updatedAt` on the effective config
 * reflects `max(project.updatedAt, global.updatedAt, 0)`.
 */
export function mergeGoalAutonomy(
  global: StoredGoalAutonomyLayer | null,
  project: StoredGoalAutonomyLayer | null,
): GoalAutonomyConfig {
  const eff: GoalAutonomyConfig = { ...DEFAULT_GOAL_AUTONOMY };
  // Strip the default's `defaultTokensCap` (it's absent in DEFAULT_GOAL_AUTONOMY,
  // but we keep this delete defensive in case a future DEFAULT carries one).
  delete (eff as Partial<GoalAutonomyConfig>).defaultTokensCap;
  applyLayer(eff, global);
  applyLayer(eff, project);
  eff.updatedAt = Math.max(
    project?.updatedAt ?? 0,
    global?.updatedAt ?? 0,
    0,
  );
  return eff;
}

/**
 * Load both layers (project + global) and return the effective merged
 * config along with the raw layers (for UI badges / "reset to default"
 * affordances). Never throws.
 */
export async function loadGoalAutonomy(
  scope: ScopePaths,
): Promise<GoalAutonomyLoadResult> {
  const [globalCfg, projectCfg] = await Promise.all([
    readLayer(globalGoalAutonomyPath(scope.home)),
    readLayer(projectGoalAutonomyPath(scope.workspace)),
  ]);
  return {
    effective: mergeGoalAutonomy(globalCfg, projectCfg),
    global: globalCfg,
    project: projectCfg,
  };
}

/**
 * Apply a validated patch to the named layer. Reads the existing sparse
 * layer (or `{}` when absent), merges the patch onto it, stamps
 * `updatedAt`, atomically writes, and returns the fresh load result.
 *
 * Sparse on-disk shape is essential: keys NOT in the layer file fall
 * through to the next layer. A key explicitly passed as `undefined` is
 * removed (used by the SPA to clear a field). All other patch keys
 * overwrite the corresponding layer value.
 *
 * Only known fields land on disk — `validateGoalAutonomyPatch` strips
 * junk. Callers should validate before invoking this.
 */
export async function saveGoalAutonomy(
  scope: ScopePaths,
  layer: GoalAutonomyLayer,
  patch: Partial<GoalAutonomyConfig>,
): Promise<GoalAutonomyLoadResult> {
  const file =
    layer === "global"
      ? globalGoalAutonomyPath(scope.home)
      : projectGoalAutonomyPath(scope.workspace);

  const existing = (await readLayer(file)) ?? { updatedAt: 0 };
  const merged: StoredGoalAutonomyLayer = { ...existing };

  // Apply patch key-by-key, treating `undefined` as a clear sentinel.
  if ("enabled" in patch) {
    if (patch.enabled === undefined) delete merged.enabled;
    else merged.enabled = patch.enabled;
  }
  if ("autonomyLevel" in patch) {
    if (patch.autonomyLevel === undefined) delete merged.autonomyLevel;
    else merged.autonomyLevel = patch.autonomyLevel;
  }
  if ("summaryGranularity" in patch) {
    if (patch.summaryGranularity === undefined) delete merged.summaryGranularity;
    else merged.summaryGranularity = patch.summaryGranularity;
  }
  if ("summaryIntervalMs" in patch) {
    if (patch.summaryIntervalMs === undefined) delete merged.summaryIntervalMs;
    else merged.summaryIntervalMs = patch.summaryIntervalMs;
  }
  if ("defaultMaxRounds" in patch) {
    if (patch.defaultMaxRounds === undefined) delete merged.defaultMaxRounds;
    else merged.defaultMaxRounds = patch.defaultMaxRounds;
  }
  if ("defaultTokensCap" in patch) {
    if (patch.defaultTokensCap === undefined) delete merged.defaultTokensCap;
    else merged.defaultTokensCap = patch.defaultTokensCap;
  }
  merged.updatedAt = Date.now();

  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify(merged, null, 2) + "\n");

  return loadGoalAutonomy(scope);
}

/**
 * Delete the named layer entirely, so subsequent reads fall back to the
 * other layer (or to `DEFAULT_GOAL_AUTONOMY`). Returns the new load
 * result. Missing file is not an error.
 */
export async function deleteGoalAutonomyLayer(
  scope: ScopePaths,
  layer: GoalAutonomyLayer,
): Promise<GoalAutonomyLoadResult> {
  const file =
    layer === "global"
      ? globalGoalAutonomyPath(scope.home)
      : projectGoalAutonomyPath(scope.workspace);
  try {
    await fs.unlink(file);
  } catch {
    /* missing is fine */
  }
  return loadGoalAutonomy(scope);
}

// ───────────────────────────────────────────────────────────────────────────
// Prompt fragment
// ───────────────────────────────────────────────────────────────────────────

/**
 * One-line autonomy-level guidance the goal runner appends to the
 * GOAL-MODE system prompt. Returns `""` for the `balanced` default so
 * the prompt isn't bloated with no-op text. Never throws.
 */
export function renderAutonomyLevelFragment(level: AutonomyLevel): string {
  switch (level) {
    case "manual":
      return [
        "# Autonomy: manual",
        "",
        "Stop after each step and confirm with the user before continuing.",
        "Prefer asking via `ask_user` over driving the loop on your own.",
      ].join("\n");
    case "conservative":
      return [
        "# Autonomy: conservative",
        "",
        "Prefer reading and asking; only act when clearly safe.",
        "If an action is irreversible (file delete, network write, git push),",
        "explicitly verify with `ask_user` before performing it.",
      ].join("\n");
    case "aggressive":
      return [
        "# Autonomy: aggressive",
        "",
        "Use the full budget. Try harder before giving up — spawn sub-goals,",
        "switch approaches after a failed attempt, and only call `give_up`",
        "when you've genuinely exhausted realistic options.",
      ].join("\n");
    case "balanced":
    default:
      return "";
  }
}
