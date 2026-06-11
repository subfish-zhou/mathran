/**
 * DB-backed flush sink for the skill mention-counter (commit 6c).
 *
 * On every flush, writes (mention_count = mention_count + deltaCount,
 * last_used_at = lastUsedAt) to assistant_skills for each slug in the
 * batch. Best-effort: errors are swallowed (caller in mention-counter.ts
 * already treats flush as best-effort and preserves deltas on rejection).
 *
 * Registered at boot via ensureMentionFlushSinkBooted() so the boot module
 * stays decoupled from the DB import in tests.
 *
 * Ported: 2026-06-10 (commit 6c/6 of mathub-ai-codex-upgrade).
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { assistantSkills } from "@/server/db/schema";
import { setMentionFlushSink, type MentionFlushSink } from "./mention-counter";

let booted = false;

const dbFlushSink: MentionFlushSink = {
  async flush(updates) {
    if (updates.length === 0) return;
    const db = getDb();
    // Per-row UPDATE rather than batch SQL: the table is small (skill
    // count rarely > a few hundred) and per-row gives us natural
    // partial-progress on the rare row-level failure. Use SQL increment
    // so concurrent writes are race-safe.
    for (const { slug, deltaCount, lastUsedAt } of updates) {
      try {
        await db
          .update(assistantSkills)
          .set({
            mentionCount: sql`${assistantSkills.mentionCount} + ${deltaCount}`,
            lastUsedAt,
          })
          .where(eq(assistantSkills.slug, slug));
      } catch (err) {
        // Per-row swallow: a missing slug (skill was deleted) shouldn't
        // poison the whole batch.
        console.warn(
          `[mention-counter-db-sink] flush failed for slug=${slug}:`,
          err,
        );
      }
    }
  },
};

/**
 * Idempotent boot. Call once at process start; safe to call multiple times.
 * Skips the wiring entirely in test mode (NODE_ENV==='test') so unit tests
 * that test mention-counter in isolation don't accidentally hit the DB.
 */
export function ensureMentionFlushSinkBooted(): void {
  if (booted) return;
  if (process.env.NODE_ENV === "test") return;
  setMentionFlushSink(dbFlushSink);
  booted = true;
}

/** Test-only: reset the booted flag (does NOT clear the registered sink). */
export function _resetMentionFlushSinkBootedForTest(): void {
  booted = false;
}
