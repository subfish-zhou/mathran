/**
 * Skill char budget + priority-based truncation.
 *
 * Codex insight (spec §4.1): if all enabled skills are dumped into the system
 * prompt, large skill libraries crowd out actual conversation context. The
 * fix is a 2%-of-context-window char budget; when exceeded, drop description
 * details by priority (mention count, then alpha), keeping name+path so the
 * model can still read SKILL.md on demand.
 *
 * Ported from codex `core-skills/src/manager.rs` + `render.rs`.
 *
 * Ported: 2026-06-10 (commit 6a/6 of mathub-ai-codex-upgrade).
 */

/** Char-to-token estimate (rule-of-thumb: ~4 chars per token for English). */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/** 2% of the context-window char budget is the codex default. */
const SKILL_CONTEXT_PERCENT = 0.02;

/** Floor — even tiny context windows give skills at least this many chars. */
const SKILL_BUDGET_FLOOR_CHARS = 8000;

/**
 * Compute the per-skill-block char budget given a context window size in
 * tokens. Returns `max(SKILL_BUDGET_FLOOR_CHARS, contextWindowTokens * 4 * 2%)`.
 *
 * Examples:
 * - 128k context  → max(8000, 128000 * 4 * 0.02) = 10240
 * - 32k context   → max(8000, 32000 * 4 * 0.02)  = 8000 (floor)
 * - 200k context  → max(8000, 200000 * 4 * 0.02) = 16000
 */
export function computeSkillCharBudget(contextWindowTokens: number): number {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return SKILL_BUDGET_FLOOR_CHARS;
  }
  const fromWindow = Math.floor(
    contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * SKILL_CONTEXT_PERCENT,
  );
  return Math.max(SKILL_BUDGET_FLOOR_CHARS, fromWindow);
}

/**
 * Minimum metadata required for budget decisions. Real skill rows carry more
 * (body, references, …) but truncation only needs identifier + description +
 * path + mention count.
 */
export interface SkillMetaForBudget {
  slug: string;
  name: string;
  description: string;
  path: string;
  mentionCount?: number;
}

export interface TruncationResult {
  /** Skills to actually render, in render order. */
  kept: RenderedSkillMeta[];
  /** True iff any skill description was shortened or dropped. */
  truncated: boolean;
  /** Char count of the final rendered list (incl. format overhead). */
  finalChars: number;
}

/** Render-ready skill metadata: kept may have description == "" if truncated. */
export interface RenderedSkillMeta {
  slug: string;
  name: string;
  description: string;
  path: string;
  /** True when this skill's description was dropped to fit budget. */
  descriptionDropped: boolean;
}

/**
 * Per-skill char overhead in the rendered prompt (markers, dashes, separators).
 * Used as a budgeting estimate, not byte-exact.
 */
const PER_SKILL_OVERHEAD_CHARS = 20;

/**
 * Truncate a list of skills to fit `budget` chars, using:
 * 1. Sort by mention_count DESC, then name ASC (stable tiebreak).
 * 2. Try to fit all with full description first.
 * 3. If still over budget, drop descriptions one-by-one from the *least-used*
 *    end until under budget, keeping name + path.
 * 4. If even name+path-only is over budget, truncate the tail entirely
 *    (least-used skills dropped from the list).
 *
 * Codex parity: this matches `core-skills/src/manager.rs::truncate_skills`
 * (priority-by-hotness, description-first-drop, hard-cap fallback).
 */
export function truncateSkillsToBudget(
  skills: SkillMetaForBudget[],
  budget: number,
): TruncationResult {
  // Stable sort: hottest first; alpha tiebreak.
  const sorted = [...skills].sort((a, b) => {
    const mA = a.mentionCount ?? 0;
    const mB = b.mentionCount ?? 0;
    if (mA !== mB) return mB - mA;
    return a.name.localeCompare(b.name);
  });

  const fullChars = (s: SkillMetaForBudget) =>
    s.name.length +
    s.description.length +
    s.path.length +
    PER_SKILL_OVERHEAD_CHARS;
  const minChars = (s: SkillMetaForBudget) =>
    s.name.length + s.path.length + PER_SKILL_OVERHEAD_CHARS;

  // Phase 1: all full descriptions fit?
  const totalFull = sorted.reduce((sum, s) => sum + fullChars(s), 0);
  if (totalFull <= budget) {
    return {
      kept: sorted.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
        path: s.path,
        descriptionDropped: false,
      })),
      truncated: false,
      finalChars: totalFull,
    };
  }

  // Phase 2: drop descriptions starting from least-used end until under budget.
  // We mark which indices keep descriptions vs. minimized.
  const minimal: boolean[] = sorted.map(() => false);
  let runningChars = totalFull;
  for (let i = sorted.length - 1; i >= 0 && runningChars > budget; i--) {
    const s = sorted[i]!;
    runningChars = runningChars - fullChars(s) + minChars(s);
    minimal[i] = true;
  }

  if (runningChars <= budget) {
    return {
      kept: sorted.map((s, i) => ({
        slug: s.slug,
        name: s.name,
        description: minimal[i] ? "" : s.description,
        path: s.path,
        descriptionDropped: !!minimal[i],
      })),
      truncated: true,
      finalChars: runningChars,
    };
  }

  // Phase 3: even all-minimized is over budget. Drop the tail (least-used)
  // until under budget; guarantee at least one skill kept.
  let droppedTail = 0;
  while (runningChars > budget && droppedTail < sorted.length - 1) {
    const idx = sorted.length - 1 - droppedTail;
    runningChars -= minChars(sorted[idx]!);
    droppedTail += 1;
  }

  const survivors = sorted.slice(0, sorted.length - droppedTail);
  return {
    kept: survivors.map((s, i) => ({
      slug: s.slug,
      name: s.name,
      description: minimal[i] ? "" : s.description,
      path: s.path,
      descriptionDropped: !!minimal[i],
    })),
    truncated: true,
    finalChars: runningChars,
  };
}

/**
 * Codex truncation warning, en + zh. Append to the skills block when
 * `truncated=true` so the model knows it can still ask for the full body via
 * loadSkillReference.
 */
export const SKILL_TRUNCATION_WARNING_EN =
  "Skill descriptions have been truncated to fit the 2% context budget. " +
  "All skills are still visible by name and path, but some descriptions were " +
  "shortened or dropped. Disabling unused skills / plugins lets more skills " +
  "render in full.";

export const SKILL_TRUNCATION_WARNING_ZH =
  "已截断 skill 描述以符合 2% 上下文预算。所有 skill 仍能按名称和路径看到，" +
  "但部分描述被缩短或省略。禁用未使用的 skill / plugin 可让更多 skill 完整展示。";
