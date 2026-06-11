/**
 * Skill mention counter — in-memory hot counter, debounced batched flush.
 *
 * Ported from codex `core-skills/src/mention_counts.rs`. This commit (6a) ships
 * the in-memory side only; commit 6b will wire the debounced DB flush.
 *
 * Design:
 * - Singleton: one counter per process. We do NOT shard by user/project —
 *   skill hotness is a global signal (a popular skill is popular for everyone).
 * - recordMention is fire-and-forget; no async, no DB. The hot path adds 1
 *   to a Map and bumps lastUsedAt.
 * - Reads (getCount / snapshot) are sync; matcher.ts can use them inline.
 * - 5-min batched flush is set up but a no-op until commit 6b plugs in a
 *   real DB writer (set via setMentionFlushSink).
 *
 * Ported: 2026-06-10 (commit 6a/6 of mathub-ai-codex-upgrade).
 */

export interface MentionFlushSink {
  /**
   * Persist accumulated counts to durable storage. Called every flushIntervalMs
   * with the delta since last flush (zero entries skipped). Return rejected
   * promises silently — flush is best-effort.
   */
  flush(updates: Array<{ slug: string; deltaCount: number; lastUsedAt: Date }>): Promise<void>;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

interface CounterEntry {
  /** Running total since process start (or last successful flush). */
  total: number;
  /** Delta accumulated since last flush — reset to 0 on successful flush. */
  pendingDelta: number;
  /** Last mention timestamp (used for ORDER BY recency tiebreak). */
  lastUsedAt: Date;
}

interface CounterState {
  counts: Map<string, CounterEntry>;
  sink: MentionFlushSink | null;
  flushTimer: NodeJS.Timeout | null;
  flushIntervalMs: number;
}

const state: CounterState = {
  counts: new Map(),
  sink: null,
  flushTimer: null,
  flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
};

/**
 * Record one mention of `slug`. Synchronous, allocation-light. The hot path
 * (matcher / executor) calls this on every user-message hit.
 */
export function recordMention(slug: string): void {
  if (!slug) return;
  const now = new Date();
  const entry = state.counts.get(slug);
  if (entry) {
    entry.total += 1;
    entry.pendingDelta += 1;
    entry.lastUsedAt = now;
  } else {
    state.counts.set(slug, {
      total: 1,
      pendingDelta: 1,
      lastUsedAt: now,
    });
  }
}

/** Current in-memory total (since process start; ignores DB persisted value). */
export function getCount(slug: string): number {
  return state.counts.get(slug)?.total ?? 0;
}

/** Last-used timestamp (undefined if never mentioned this process). */
export function getLastUsedAt(slug: string): Date | undefined {
  return state.counts.get(slug)?.lastUsedAt;
}

/** Snapshot of all counters — for debug / admin / matcher batch reads. */
export function snapshotMentionCounts(): Array<{
  slug: string;
  count: number;
  lastUsedAt: Date;
}> {
  const out: Array<{ slug: string; count: number; lastUsedAt: Date }> = [];
  for (const [slug, entry] of state.counts) {
    out.push({ slug, count: entry.total, lastUsedAt: entry.lastUsedAt });
  }
  // Hot first, alpha tiebreak.
  out.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.slug.localeCompare(b.slug);
  });
  return out;
}

/**
 * Plug in a DB-backed flush sink. Commit 6b will call this once at boot. The
 * sink replaces any existing one; the flush timer is (re)started.
 */
export function setMentionFlushSink(
  sink: MentionFlushSink | null,
  opts: { flushIntervalMs?: number } = {},
): void {
  state.sink = sink;
  if (opts.flushIntervalMs && opts.flushIntervalMs > 0) {
    state.flushIntervalMs = opts.flushIntervalMs;
  }
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  if (sink) {
    state.flushTimer = setInterval(() => {
      void flushPendingMentions();
    }, state.flushIntervalMs);
    // Don't keep the event loop alive just for this — Node's unref pattern.
    state.flushTimer.unref?.();
  }
}

/**
 * Drain pendingDelta into the sink. Resets deltas to 0 only after the sink's
 * promise settles successfully; on rejection, the deltas remain so the next
 * flush picks them up (additive — not lost).
 */
export async function flushPendingMentions(): Promise<void> {
  const sink = state.sink;
  if (!sink) return;
  const updates: Array<{ slug: string; deltaCount: number; lastUsedAt: Date }> = [];
  for (const [slug, entry] of state.counts) {
    if (entry.pendingDelta > 0) {
      updates.push({
        slug,
        deltaCount: entry.pendingDelta,
        lastUsedAt: entry.lastUsedAt,
      });
    }
  }
  if (updates.length === 0) return;
  try {
    await sink.flush(updates);
    // Success — clear the deltas we just persisted.
    for (const u of updates) {
      const entry = state.counts.get(u.slug);
      if (entry) {
        entry.pendingDelta = Math.max(0, entry.pendingDelta - u.deltaCount);
      }
    }
  } catch {
    // Best-effort: keep deltas so next flush retries.
  }
}

/** Test-only: clear all in-memory state and cancel the flush timer. */
export function _resetMentionCounterForTest(): void {
  state.counts.clear();
  state.sink = null;
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  state.flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
}
