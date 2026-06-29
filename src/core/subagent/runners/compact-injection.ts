/**
 * Compaction injection — TODO-2 §5.1 / C2.
 *
 * Translates codex's `insert_initial_context_before_last_real_user_or_summary`
 * algorithm (codex-rs/core/src/compact.rs:465-510) into TypeScript, plus a
 * mathran-specific extension to `isRealUser`: codex already filters out
 * compaction summaries (which are stored as user-role items) via
 * `is_summary_message`; mathran additionally filters out daemon synthetic
 * user messages (prefix "[daemon: ...") because the goal daemon injects
 * those when running unattended — they don't carry real user intent and
 * shouldn't anchor the summary insertion point.
 *
 * No external behavior changes ship in this commit — these helpers are
 * exported for the LocalCompactionStrategy (C5) and tests (C2 unit tests).
 */

import type { LLMMessage } from "../../providers/llm.js";
import type {
  CompactionPhase,
  SummaryInjectionPolicy,
} from "./compact-types.js";

/**
 * Prefix marking a daemon-injected synthetic user message. Mathran's goal
 * daemon (src/core/goal/daemon.ts) emits `[daemon: continue]` and similar
 * sentinels when a goal advances without a real user prompt. These are
 * NOT user intent and must be treated like compaction summaries for the
 * purposes of "where do we insert the next summary".
 */
export const DAEMON_USER_PREFIX = "[daemon:";

/**
 * Prefix the compactRunner already uses for its summary items. Kept in
 * sync with `COMPACT_SUMMARY_PREFIX` exported from compact.ts. Hardcoded
 * here as a string literal to avoid an import cycle (compact.ts will
 * import from this file in C5).
 *
 * 2026-06-29 — upgraded to codex-parity handoff framing. The legacy
 * prefix is kept in `LEGACY_COMPACT_SUMMARY_PREFIXES` so the detector
 * still recognises summaries persisted before this change (otherwise
 * those rounds would be re-summarised on every subsequent compaction).
 */
export const COMPACT_SUMMARY_PREFIX =
  "<Previous conversation summary — another language model started this " +
  "task; use it to continue without duplicating work>\n\n";

/**
 * Legacy summary prefixes recognised by the `is_summary_message` detector
 * for back-compat with conversations that contain summary items written
 * by older compact runners. New summaries always use the latest
 * `COMPACT_SUMMARY_PREFIX` value above.
 */
const LEGACY_COMPACT_SUMMARY_PREFIXES: readonly string[] = [
  "<Previous conversation summary>\n\n",
];

/**
 * Predicate: is this message a *real* user message — i.e. not a compaction
 * summary item, and not a daemon synthetic continuation?
 *
 * Mirrors codex `is_summary_message` (compact.rs:451-453), extended with
 * a check for `[daemon: ...]` synthetic users. The order of checks
 * matters: an `assistant` or `tool` message can never be a "real user"
 * even if its content happens to start with one of the prefixes.
 */
export function isRealUser(msg: LLMMessage): boolean {
  if (msg.role !== "user") return false;
  const c = typeof msg.content === "string" ? msg.content : "";
  if (c.startsWith(COMPACT_SUMMARY_PREFIX)) return false;
  // back-compat: recognise pre-2026-06-29 summary prefixes so re-compaction
  // doesn't re-summarise old summary blocks.
  for (const legacy of LEGACY_COMPACT_SUMMARY_PREFIXES) {
    if (c.startsWith(legacy)) return false;
  }
  if (c.startsWith(DAEMON_USER_PREFIX)) return false;
  return true;
}

/**
 * Map a compaction phase to its proper summary injection policy.
 *
 *   pre_turn / standalone → do_not_inject
 *     The next send() will append a fresh user message at the end of
 *     history; putting the summary at the front (after the system block)
 *     gives the model a clean "context summary, then current request"
 *     shape.
 *
 *   mid_turn → before_last_user_message
 *     The model is partway through a turn. Models trained on codex-style
 *     mid-turn compaction expect the summary to appear just above the
 *     latest real user request, not in some arbitrary position. Putting
 *     the summary at the front (as do_not_inject would) confuses them.
 *
 *   post_turn → do_not_inject (not implemented this round, sane default)
 */
export function injectionPolicyForPhase(phase: CompactionPhase): SummaryInjectionPolicy {
  switch (phase) {
    case "mid_turn":
      return "before_last_user_message";
    case "pre_turn":
    case "post_turn":
    case "standalone":
      return "do_not_inject";
    default: {
      // Exhaustiveness check — TS will catch missing cases.
      const _exhaustive: never = phase;
      void _exhaustive;
      return "do_not_inject";
    }
  }
}

/** Arguments for rebuildHistory — the post-compaction history assembly step. */
export interface RebuildHistoryArgs {
  /** Leading run of role="system" messages, kept verbatim. */
  systemBlock: LLMMessage[];
  /** The retained "recent N rounds" tail, kept verbatim. */
  tail: LLMMessage[];
  /** The raw summary text produced by the strategy (without the prefix). */
  summary: string;
  /** Where to splice the summary item into the result. */
  policy: SummaryInjectionPolicy;
}

/**
 * Reassemble the post-compaction history.
 *
 * For `do_not_inject` (pre/standalone phases):
 *   → [systemBlock..., summaryItem, tail...]
 *   Simple front placement; the summary is the first non-system item
 *   the model sees.
 *
 * For `before_last_user_message` (mid_turn phase):
 *   → Apply codex's `insert_initial_context_before_last_real_user_or_summary`
 *     (compact.rs:465-510):
 *
 *     1. Walk `tail` from the back, looking for the last *real* user
 *        message (via isRealUser).
 *     2. If found, splice summaryItem at that index → just above the
 *        last real user.
 *     3. Fall back to the last *any* user-role message (which may be a
 *        synthetic daemon user or a previous compaction summary). This
 *        preserves codex's semantic of "summary should anchor near the
 *        latest user-side turn".
 *     4. Fall back to appending summaryItem at the end of tail (no
 *        user/summary present at all — extremely rare).
 *
 *   Note: `is_summary_message` in codex is the equivalent of our
 *   `isRealUser → false because prefix matches` branch. Codex also
 *   considers "compaction items" (a separate ResponseItem variant); we
 *   don't have that distinction in our LLMMessage shape, so we collapse
 *   it into the user-or-summary fallback.
 *
 * NEVER drops the systemBlock — always returned at the front intact.
 */
export function rebuildHistory(args: RebuildHistoryArgs): LLMMessage[] {
  const { systemBlock, tail, summary, policy } = args;
  const summaryItem: LLMMessage = {
    role: "system",
    content: COMPACT_SUMMARY_PREFIX + summary,
  };

  if (policy === "do_not_inject") {
    return [...systemBlock.map(cloneMsg), summaryItem, ...tail.map(cloneMsg)];
  }

  // before_last_user_message: find insertion index INSIDE tail.
  let lastRealUserIdx: number | null = null;
  let lastAnyUserIdx: number | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    if (m.role !== "user") continue;
    if (lastAnyUserIdx === null) lastAnyUserIdx = i;
    if (isRealUser(m)) {
      lastRealUserIdx = i;
      break;
    }
  }

  const insertIdx = lastRealUserIdx ?? lastAnyUserIdx;
  if (insertIdx === null) {
    // No user-role item at all in tail — append summary at the end so
    // the model still sees it. This is the codex "no users or
    // compaction items → append" path.
    return [
      ...systemBlock.map(cloneMsg),
      ...tail.map(cloneMsg),
      summaryItem,
    ];
  }

  return [
    ...systemBlock.map(cloneMsg),
    ...tail.slice(0, insertIdx).map(cloneMsg),
    summaryItem,
    ...tail.slice(insertIdx).map(cloneMsg),
  ];
}

/** Shallow clone of LLMMessage; matches the cloning compactRunner already does. */
function cloneMsg(m: LLMMessage): LLMMessage {
  return { ...m };
}
