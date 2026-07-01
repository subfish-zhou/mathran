/**
 * Client-side patch applier for partial-edit render retry.
 *
 * Given the original assistant markdown, the list of RenderProblems
 * (with their spans), and the LLM's patches, splice each replacement
 * into place. Patches apply in REVERSE span order so earlier patches
 * don't shift the indices of later ones.
 *
 * The apply is atomic per-problem:
 *   - Patches referring to unknown errorIndex are dropped
 *   - Errors with no matching patch are left as-is (their broken text
 *     stays in v2 — the caller can decide whether to fall back to a
 *     full rewrite)
 *
 * Never throws; returns a result object with counts so the caller can
 * report "fixed 2/3 errors" in the UI.
 */

import type { RenderProblem } from "./render-validator";

export interface Patch {
  errorIndex: number;
  replacement: string;
}

export interface ApplyResult {
  /** The patched markdown. */
  patched: string;
  /** How many problems were successfully replaced. */
  applied: number;
  /** Indices (into the ORIGINAL problem list) that had no patch, so remain broken. */
  skippedIndices: number[];
}

/**
 * Apply patches by span-splicing. Preconditions:
 *   - Each problem's `matched` must equal `original.slice(span[0], span[1])`
 *     (the validator guarantees this — see render-validator.test.ts).
 *   - Patches with duplicate errorIndex: last one wins (LLMs occasionally
 *     emit duplicates; taking last is arbitrary but deterministic).
 */
export function applyPatches(
  original: string,
  problems: RenderProblem[],
  patches: Patch[],
): ApplyResult {
  if (!original || problems.length === 0) {
    return { patched: original, applied: 0, skippedIndices: [] };
  }

  // Build errorIndex -> patch map (last-wins).
  const patchMap = new Map<number, string>();
  for (const p of patches) {
    if (
      typeof p.errorIndex === "number" &&
      Number.isInteger(p.errorIndex) &&
      p.errorIndex >= 0 &&
      p.errorIndex < problems.length &&
      typeof p.replacement === "string"
    ) {
      patchMap.set(p.errorIndex, p.replacement);
    }
  }

  // Iterate problems in REVERSE span order — this way applying an
  // earlier patch doesn't invalidate the indices of later ones.
  const indexed = problems.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => b.p.span[0] - a.p.span[0]);

  let result = original;
  const skipped: number[] = [];
  let applied = 0;

  for (const { p, i } of indexed) {
    const replacement = patchMap.get(i);
    if (replacement === undefined) {
      skipped.push(i);
      continue;
    }
    const [start, end] = p.span;
    // Safety: verify the span still matches (in case caller mutated
    // `original` between validation and apply — shouldn't happen but
    // guard is cheap).
    if (result.slice(start, end) !== p.matched) {
      // Span drift — skip this patch to avoid corrupting unrelated text.
      skipped.push(i);
      continue;
    }
    result = result.slice(0, start) + replacement + result.slice(end);
    applied += 1;
  }

  // Re-sort skipped ascending so callers see them in stable original order.
  skipped.sort((a, b) => a - b);
  return { patched: result, applied, skippedIndices: skipped };
}
