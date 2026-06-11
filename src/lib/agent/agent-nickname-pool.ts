/**
 * Nickname pool — module-level singleton. Hands out a unique English nickname
 * per spawned sub-agent and gives it back on terminal. When the pool wraps,
 * suffix with roman numerals (Frieren II, Frieren III, …).
 *
 * Inspired by codex `agent/registry.rs::AgentNamePool`. Mathub version is
 * intentionally tiny: no async, no DB, no eviction policy other than wrap.
 *
 * Ported: 2026-06-10 (commit 4/6 of mathub-ai-codex-upgrade).
 */

import { AGENT_NAMES } from "./agent-names";

const ROMAN_NUMERALS = [
  "",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XII",
  "XIII",
  "XIV",
  "XV",
  "XVI",
  "XVII",
  "XVIII",
  "XIX",
  "XX",
  "XXI",
  "XXII",
  "XXIII",
  "XXIV",
  "XXV",
  "XXVI",
  "XXVII",
  "XXVIII",
  "XXIX",
  "XXX",
  "XXXI",
  "XXXII",
  "XXXIII",
  "XXXIV",
  "XXXV",
  "XXXVI",
  "XXXVII",
  "XXXVIII",
  "XXXIX",
  "XL",
  "XLI",
  "XLII",
  "XLIII",
  "XLIV",
  "XLV",
  "XLVI",
  "XLVII",
  "XLVIII",
  "XLIX",
  "L",
];

/**
 * Build a "Name [suffix]" string. Lap=0 → bare base; lap≥1 → "Base II", …
 * (capped at lap=50; beyond that we just append the numeric lap to avoid an
 * overflow of the table).
 */
export function romanize(base: string, lap: number): string {
  if (lap <= 0) return base;
  const suffix = lap < ROMAN_NUMERALS.length ? ROMAN_NUMERALS[lap] : `+${lap}`;
  return suffix ? `${base} ${suffix}` : base;
}

interface PoolState {
  /** Currently-held nicknames; release() removes; assign() never duplicates. */
  inUse: Set<string>;
  /** How many full passes through AGENT_NAMES have completed so far. */
  lap: number;
  /** Next index into AGENT_NAMES to try on the current lap. */
  cursor: number;
}

const state: PoolState = {
  inUse: new Set(),
  lap: 0,
  cursor: 0,
};

/**
 * Assign a unique nickname. Walks AGENT_NAMES from cursor; skips names
 * currently in use. If an entire lap fails to find a free slot (every name
 * at the current lap suffix is held), bump the lap and try again with the
 * next roman-numeral suffix.
 */
export function assign(): string {
  const total = AGENT_NAMES.length;
  if (total === 0) {
    // Defensive: should never happen — names table is non-empty by design.
    const fallback = `agent-${Math.floor(Math.random() * 100000)}`;
    state.inUse.add(fallback);
    return fallback;
  }

  // Try up to a generous number of lap bumps to avoid infinite loops in any
  // pathological case. Each bump tries a fresh suffix on a full lap.
  for (let attempt = 0; attempt < 100; attempt++) {
    for (let step = 0; step < total; step++) {
      const idx = (state.cursor + step) % total;
      const candidate = romanize(AGENT_NAMES[idx]!, state.lap);
      if (!state.inUse.has(candidate)) {
        state.inUse.add(candidate);
        // Advance cursor to the slot AFTER the one we used (within the
        // current lap). Do NOT bump lap on simple wrap-around — lap only
        // bumps when the entire lap is held.
        state.cursor = (state.cursor + step + 1) % total;
        return candidate;
      }
    }
    // The entire lap at this suffix is held. Bump to the next suffix and
    // restart the search from cursor 0.
    state.lap += 1;
    state.cursor = 0;
  }

  // Pathological: > 100 laps of total slots all simultaneously held.
  const fallback = `agent-${state.inUse.size}-${Date.now() % 100000}`;
  state.inUse.add(fallback);
  return fallback;
}

/** Release a nickname back to the pool. Safe to call multiple times. */
export function release(nickname: string): void {
  state.inUse.delete(nickname);
}

/** Test-only: clear the pool. */
export function _resetForTest(): void {
  state.inUse.clear();
  state.lap = 0;
  state.cursor = 0;
}

/** Read-only snapshot for diagnostics / debug tools. */
export function snapshot(): { inUse: string[]; lap: number; cursor: number } {
  return {
    inUse: Array.from(state.inUse),
    lap: state.lap,
    cursor: state.cursor,
  };
}
