/**
 * ContextManager — registry + render pipeline for ContextFragments.
 *
 * Single instance per process (default export `contextManager`). Tests reset
 * with _resetForTest(). Builtin fragments register themselves at module load
 * via context/boot.ts (which is imported by chat-handler / executor / goal-
 * run).
 *
 * Ported: 2026-06-10 (commit 11a/sprint-3 of mathub-ai-codex-upgrade).
 */

import type {
  ContextFragment,
  FragmentRenderInput,
} from "./fragment";

const SECTION_SEPARATOR = "\n\n";
// Rough char->token ratio for English+CJK mixed prose. Conservative on the
// safe side (so we under-spend, not over-spend the budget). Codex uses
// the actual tokenizer; we approximate to avoid pulling tiktoken into the
// runtime hot path.
const CHARS_PER_TOKEN = 4;

export interface RenderAuditEntry {
  id: string;
  priority: number;
  chars: number;
  skipped: boolean;
  skipReason?: string;
}

export interface RenderResult {
  text: string;
  audit: RenderAuditEntry[];
}

export class ContextManager {
  private fragments: Map<string, ContextFragment> = new Map();

  register(f: ContextFragment): void {
    if (!f.id || !f.id.trim()) {
      throw new Error("ContextFragment id must be non-empty");
    }
    this.fragments.set(f.id, f);
  }

  unregister(id: string): boolean {
    return this.fragments.delete(id);
  }

  has(id: string): boolean {
    return this.fragments.has(id);
  }

  /** Ordered by priority asc, then by registration order (insertion).
   *
   * [P2-3 doc] This ordering depends on three spec/runtime guarantees:
   *   1. `Map` iteration follows insertion order (ECMAScript spec).
   *   2. `Array.prototype.sort` is stable (ES2019+).
   *   3. `Map.set(existingKey, v)` updates the value but DOES NOT move the
   *      key to the tail of insertion order (also spec).
   * Together those mean equal-priority fragments stay in registration order
   * including across re-registrations. If you replace this with a different
   * container or sort, preserve all three properties or downstream snapshots
   * (parity-snapshot.test.ts) will flicker. */
  list(): ContextFragment[] {
    return Array.from(this.fragments.values()).sort(
      (a, b) => a.priority - b.priority,
    );
  }

  /** Filtered list view by scope (still priority-asc). */
  listByScope(scope: "persistent" | "turn-time"): ContextFragment[] {
    return this.list().filter((f) => f.scope === scope);
  }

  /**
   * Render only persistent fragments (the bootstrap system block).
   * Used by chat-handler at conversation start.
   */
  async renderPersistent(
    input: FragmentRenderInput,
    tokenBudget?: number,
  ): Promise<RenderResult> {
    return this.renderFiltered(input, tokenBudget, (f) => f.scope === "persistent");
  }

  /**
   * Render only turn-time fragments (executor / sub-agent loop hooks).
   */
  async renderTurnTime(
    input: FragmentRenderInput,
    tokenBudget?: number,
  ): Promise<RenderResult> {
    return this.renderFiltered(input, tokenBudget, (f) => f.scope === "turn-time");
  }

  /**
   * Render all registered fragments in priority order. Empty results
   * dropped. Optional tokenBudget skips fragments once cumulative chars
   * cross the budget (chars / CHARS_PER_TOKEN ≈ tokens).
   */
  async renderAll(
    input: FragmentRenderInput,
    tokenBudget?: number,
  ): Promise<RenderResult> {
    return this.renderFiltered(input, tokenBudget, () => true);
  }

  /**
   * [P1-4 fix] Render only the named fragments, in priority order. Use
   * when a call site wants exactly ONE (or a small set) of fragments and
   * does not want to rely on the implicit "other fragments see undefined
   * turnState fields and return ''" contract. Safer against future
   * fragments that share turnState field names.
   *
   * Unknown ids are silently skipped (logged once).
   */
  async renderById(
    ids: readonly string[],
    input: FragmentRenderInput,
    tokenBudget?: number,
  ): Promise<RenderResult> {
    const wanted = new Set(ids);
    // Warn (once per missing id) so wiring bugs surface in dev.
    for (const id of ids) {
      if (!this.fragments.has(id)) {
        console.warn(`[context-manager] renderById: unknown fragment id "${id}" (skipped)`);
      }
    }
    return this.renderFiltered(input, tokenBudget, (f) => wanted.has(f.id));
  }

  private async renderFiltered(
    input: FragmentRenderInput,
    tokenBudget: number | undefined,
    keep: (f: ContextFragment) => boolean,
  ): Promise<RenderResult> {
    const audit: RenderAuditEntry[] = [];
    const parts: string[] = [];
    const budgetChars =
      typeof tokenBudget === "number" && tokenBudget > 0
        ? tokenBudget * CHARS_PER_TOKEN
        : Infinity;
    let usedChars = 0;

    for (const fragment of this.list()) {
      if (!keep(fragment)) continue;
      // Defensive: a single fragment throwing should NOT take the whole
      // prompt down. Log + skip.
      let rendered = "";
      try {
        const out = await fragment.render(input);
        rendered = out ?? "";
      } catch (err) {
        console.warn(
          `[context-manager] fragment "${fragment.id}" render failed:`,
          err,
        );
        audit.push({
          id: fragment.id,
          priority: fragment.priority,
          chars: 0,
          skipped: true,
          skipReason: "render_error",
        });
        continue;
      }
      const trimmed = rendered.trim();
      if (!trimmed) {
        audit.push({
          id: fragment.id,
          priority: fragment.priority,
          chars: 0,
          skipped: true,
          skipReason: "empty",
        });
        continue;
      }
      if (usedChars + trimmed.length > budgetChars) {
        audit.push({
          id: fragment.id,
          priority: fragment.priority,
          chars: trimmed.length,
          skipped: true,
          skipReason: "over_budget",
        });
        continue;
      }
      parts.push(trimmed);
      usedChars += trimmed.length + SECTION_SEPARATOR.length;
      audit.push({
        id: fragment.id,
        priority: fragment.priority,
        chars: trimmed.length,
        skipped: false,
      });
    }

    return {
      text: parts.join(SECTION_SEPARATOR),
      audit,
    };
  }

  /** Test-only: drop all registrations (boot.ts re-registers on next import). */
  _resetForTest(): void {
    this.fragments.clear();
  }
}

// Process-wide singleton. Tests reset via contextManager._resetForTest().
export const contextManager = new ContextManager();
