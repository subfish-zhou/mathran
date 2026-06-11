/**
 * Goal prompt loader + template renderer.
 *
 * Loads the 6 markdown templates from disk on first call (sync readFileSync at
 * module import time is intentional — these files are tiny and the process
 * has just started). Subsequent calls hit the in-memory cache.
 *
 * Template variables use codex-style `{{ varname }}` placeholders. Substitution
 * is a simple `.replaceAll`; we deliberately do not introduce handlebars /
 * mustache / EJS — these prompts are static text with 5 vars max.
 *
 * Ported: 2026-06-10 (commit 5a/6 of mathub-ai-codex-upgrade).
 * Source: codex `codex-rs/ext/goal/templates/goals/*.md`.
 */

import { readFileSync } from "fs";
import { join } from "path";

export type GoalPromptName = "continuation" | "budget_limit" | "objective_updated";
export type GoalPromptLocale = "en" | "zh";

export interface GoalPromptVars {
  /** User-provided objective text (treat as data, never as instructions). */
  objective: string;
  /** Tokens consumed so far for this goal run. */
  tokens_used: number;
  /** Token budget, or null/undefined for unlimited. Rendered as "unlimited" when absent. */
  token_budget?: number | null;
  /** Tokens remaining (token_budget - tokens_used); rendered as "unlimited" when no budget. */
  remaining_tokens?: number | null;
  /** Wall-clock seconds spent on this goal (monotonic). */
  time_used_seconds?: number;
}

const PROMPT_DIR = join(__dirname);

interface CacheEntry {
  en: string;
  zh: string;
}

const cache: Map<GoalPromptName, CacheEntry> = new Map();

function loadOne(name: GoalPromptName, locale: GoalPromptLocale): string {
  const path = join(PROMPT_DIR, `${name}.${locale}.md`);
  return readFileSync(path, "utf8");
}

/**
 * Return the raw template body for a given prompt + locale. Cached after first
 * call. Locale fallback: if `zh` is requested but the file is missing for any
 * reason, fall back to `en`. (We ship both for all 3 prompts; the fallback is
 * a safety net.)
 */
export function loadGoalPrompt(
  name: GoalPromptName,
  locale: GoalPromptLocale,
): string {
  let entry = cache.get(name);
  if (!entry) {
    entry = {
      en: loadOne(name, "en"),
      zh: loadOne(name, "zh"),
    };
    cache.set(name, entry);
  }
  return locale === "zh" ? entry.zh : entry.en;
}

/**
 * Render a goal prompt by substituting `{{ varname }}` placeholders. Unknown
 * placeholders are left untouched (defensive — better the model sees a
 * literal `{{ foo }}` than for us to silently drop it).
 *
 * Special handling:
 * - `token_budget` null/undefined  → "unlimited"
 * - `remaining_tokens` null/undefined when no budget → "unlimited"
 * - `time_used_seconds` undefined → "0"
 */
export function renderGoalPrompt(
  name: GoalPromptName,
  locale: GoalPromptLocale,
  vars: GoalPromptVars,
): string {
  const template = loadGoalPrompt(name, locale);

  const tokenBudgetStr =
    vars.token_budget == null ? "unlimited" : String(vars.token_budget);
  const remainingTokensStr =
    vars.remaining_tokens == null ? "unlimited" : String(vars.remaining_tokens);
  const timeUsedSecondsStr =
    vars.time_used_seconds == null ? "0" : String(vars.time_used_seconds);

  return template
    .replaceAll("{{ objective }}", vars.objective)
    .replaceAll("{{ tokens_used }}", String(vars.tokens_used))
    .replaceAll("{{ token_budget }}", tokenBudgetStr)
    .replaceAll("{{ remaining_tokens }}", remainingTokensStr)
    .replaceAll("{{ time_used_seconds }}", timeUsedSecondsStr);
}

/** Test-only: clear the in-memory cache. */
export function _clearGoalPromptCacheForTest(): void {
  cache.clear();
}
