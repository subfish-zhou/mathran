/**
 * Effort resolution — precedence cascade (#6).
 *
 * Resolves the effective reasoning-effort level for a chat turn from the
 * available sources, highest precedence first:
 *
 *   1. `--effort` CLI flag           (explicit, per-invocation)
 *   2. `/effort` session override    (set live in the REPL/SPA session)
 *   3. settings `chat.modelEffort[<model>]`  (per-model default)
 *   4. settings `chat.defaultEffort`         (workspace/project default)
 *   5. built-in default `medium`
 *
 * Every source is optional; the first one that yields a valid level wins.
 * Unknown/invalid strings are ignored (treated as absent) so a typo never
 * crashes a turn — it just falls through to the next source.
 */

import {
  DEFAULT_EFFORT_LEVEL,
  isReasoningEffortLevel,
  type ReasoningEffortLevel,
} from "./effort-levels.js";

/** The `chat` settings block fields relevant to effort resolution. */
export interface ChatEffortSettings {
  /** Workspace/project default effort. */
  defaultEffort?: ReasoningEffortLevel | string;
  /** Per-model override, keyed by the routing model string. */
  modelEffort?: Record<string, ReasoningEffortLevel | string>;
}

export interface ResolveEffortInput {
  /** `--effort` flag value (already lower-cased canonical, or raw string). */
  flag?: string | ReasoningEffortLevel;
  /** `/effort` session override. */
  session?: ReasoningEffortLevel;
  /** The routing model string (for `modelEffort` lookup), e.g. `copilot/gpt-5.5`. */
  model?: string;
  /** The merged `chat` settings block. */
  settings?: ChatEffortSettings;
  /** Override the final fallback (defaults to `medium`). */
  fallback?: ReasoningEffortLevel;
}

function coerce(v: unknown): ReasoningEffortLevel | undefined {
  return isReasoningEffortLevel(v) ? v : undefined;
}

/**
 * Resolve the effective effort level following the precedence cascade. Always
 * returns a valid level (never throws).
 */
export function resolveEffort(input: ResolveEffortInput): ReasoningEffortLevel {
  const fallback = input.fallback ?? DEFAULT_EFFORT_LEVEL;

  const fromFlag = coerce(input.flag);
  if (fromFlag) return fromFlag;

  const fromSession = coerce(input.session);
  if (fromSession) return fromSession;

  const model = input.model;
  const modelEffort = input.settings?.modelEffort;
  if (model && modelEffort) {
    const fromModel = coerce(modelEffort[model]);
    if (fromModel) return fromModel;
  }

  const fromDefault = coerce(input.settings?.defaultEffort);
  if (fromDefault) return fromDefault;

  return fallback;
}
