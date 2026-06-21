/**
 * SPA-side REST helpers for the goal-autonomy config (v0.17 mathub parity W11).
 *
 * Mirrors `src/core/config/goal-autonomy.ts`. The server returns the
 * same shape via `/api/scopes/:scopeId/goal-autonomy` (GET / PATCH /
 * DELETE). We keep these helpers in their own file so the autonomy card
 * doesn't have to drag the whole chat-lib graph into its bundle slice.
 */

import type { ChatScopeSpec } from "./api.ts";

export type AutonomyLevel =
  | "manual"
  | "conservative"
  | "balanced"
  | "aggressive";

export type SummaryGranularity = "realtime" | "hourly" | "daily";

/** The effective merged shape (project ∪ global ∪ DEFAULT). */
export interface GoalAutonomyConfig {
  enabled: boolean;
  autonomyLevel: AutonomyLevel;
  summaryGranularity: SummaryGranularity;
  summaryIntervalMs: number;
  defaultMaxRounds: number;
  defaultTokensCap?: number;
  updatedAt: number;
}

/**
 * One on-disk layer — sparse, only the keys the user explicitly set.
 * `updatedAt` is always present. Matches `StoredGoalAutonomyLayer` on
 * the server.
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

export interface GoalAutonomyResponse {
  effective: GoalAutonomyConfig;
  global: StoredGoalAutonomyLayer | null;
  project: StoredGoalAutonomyLayer | null;
  defaults: GoalAutonomyConfig;
}

export type GoalAutonomyLayer = "global" | "project";

/**
 * Encode a `ChatScopeSpec` to the URL-safe scopeId scheme the server
 * accepts. Mirrors `isValidAutonomyScopeId` in `serve.ts`.
 */
export function scopeIdFromScope(scope: ChatScopeSpec): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "project") return `project~${scope.projectSlug}`;
  return `effort~${scope.projectSlug}~${scope.effortSlug}`;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") msg = body.error;
    } catch {
      /* leave default */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function fetchGoalAutonomy(
  scope: ChatScopeSpec,
): Promise<GoalAutonomyResponse> {
  const url = `/api/scopes/${scopeIdFromScope(scope)}/goal-autonomy`;
  const res = await fetch(url);
  return jsonOrThrow<GoalAutonomyResponse>(res);
}

export async function patchGoalAutonomy(
  scope: ChatScopeSpec,
  layer: GoalAutonomyLayer,
  patch: Partial<GoalAutonomyConfig>,
): Promise<GoalAutonomyResponse> {
  const url = `/api/scopes/${scopeIdFromScope(scope)}/goal-autonomy`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: layer, patch }),
  });
  return jsonOrThrow<GoalAutonomyResponse>(res);
}

export async function deleteGoalAutonomyLayer(
  scope: ChatScopeSpec,
  layer: GoalAutonomyLayer,
): Promise<GoalAutonomyResponse> {
  const url = `/api/scopes/${scopeIdFromScope(scope)}/goal-autonomy?scope=${layer}`;
  const res = await fetch(url, { method: "DELETE" });
  return jsonOrThrow<GoalAutonomyResponse>(res);
}

/** UI helper: short, human-readable label for each level. */
export const AUTONOMY_LEVEL_LABEL: Record<AutonomyLevel, string> = {
  manual: "Manual",
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

/** UI helper: one-line description rendered as a hint below the picker. */
export const AUTONOMY_LEVEL_HINT: Record<AutonomyLevel, string> = {
  manual: "Stop after each step and ask before continuing.",
  conservative: "Prefer reading & asking; verify before irreversible actions.",
  balanced: "Default. No extra prompt guidance.",
  aggressive: "Use the full budget; try harder before giving up.",
};
