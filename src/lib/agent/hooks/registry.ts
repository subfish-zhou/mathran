/**
 * Hook registry. In-memory module-level singleton; 8 typed buckets (one per
 * hook category). Registration is O(1); sorted snapshots are computed on
 * read so callers get a stable priority-ordered list.
 *
 * Inspired by codex-rs/core/src/hook_runtime.rs (HEAD 2026-06-10), but kept
 * intentionally minimal: no OTel, no analytics, no sub-agent context plumbing
 * — those live in the runtime / adapters above.
 *
 * Ported: 2026-06-10 (commit 2/6 of mathub-ai-codex-upgrade).
 */

import type {
  PreToolUseHook,
  PostToolUseHook,
  PreCompactHook,
  PostCompactHook,
  SessionStartHook,
  UserPromptSubmitHook,
  SubagentLifecycleHook,
  StopHook,
} from "./types";

interface RegistryState {
  preToolUse: PreToolUseHook[];
  postToolUse: PostToolUseHook[];
  preCompact: PreCompactHook[];
  postCompact: PostCompactHook[];
  sessionStart: SessionStartHook[];
  userPromptSubmit: UserPromptSubmitHook[];
  subagentLifecycle: SubagentLifecycleHook[];
  stop: StopHook[];
}

const state: RegistryState = {
  preToolUse: [],
  postToolUse: [],
  preCompact: [],
  postCompact: [],
  sessionStart: [],
  userPromptSubmit: [],
  subagentLifecycle: [],
  stop: [],
};

// ─── Register ────────────────────────────────────────────────────────

export function registerPreToolUse(h: PreToolUseHook): void {
  state.preToolUse.push(h);
}
export function registerPostToolUse(h: PostToolUseHook): void {
  state.postToolUse.push(h);
}
export function registerPreCompact(h: PreCompactHook): void {
  state.preCompact.push(h);
}
export function registerPostCompact(h: PostCompactHook): void {
  state.postCompact.push(h);
}
export function registerSessionStart(h: SessionStartHook): void {
  state.sessionStart.push(h);
}
export function registerUserPromptSubmit(h: UserPromptSubmitHook): void {
  state.userPromptSubmit.push(h);
}
export function registerSubagentLifecycle(h: SubagentLifecycleHook): void {
  state.subagentLifecycle.push(h);
}
export function registerStop(h: StopHook): void {
  state.stop.push(h);
}

// ─── Get (sorted snapshot) ───────────────────────────────────────────

function sortByPriority<T extends { priority: number; name: string }>(
  hooks: readonly T[],
): T[] {
  // lower priority runs first; stable secondary key = name for determinism.
  return [...hooks].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
}

export function getPreToolUseHooks(): PreToolUseHook[] {
  return sortByPriority(state.preToolUse);
}
export function getPostToolUseHooks(): PostToolUseHook[] {
  return sortByPriority(state.postToolUse);
}
export function getPreCompactHooks(): PreCompactHook[] {
  return sortByPriority(state.preCompact);
}
export function getPostCompactHooks(): PostCompactHook[] {
  return sortByPriority(state.postCompact);
}
export function getSessionStartHooks(): SessionStartHook[] {
  return sortByPriority(state.sessionStart);
}
export function getUserPromptSubmitHooks(): UserPromptSubmitHook[] {
  return sortByPriority(state.userPromptSubmit);
}
export function getSubagentLifecycleHooks(): SubagentLifecycleHook[] {
  return sortByPriority(state.subagentLifecycle);
}
export function getStopHooks(): StopHook[] {
  return sortByPriority(state.stop);
}

// ─── Test helpers ────────────────────────────────────────────────────

/** Reset the entire registry. ONLY call from test setup; not exported via index. */
export function resetForTest(): void {
  state.preToolUse.length = 0;
  state.postToolUse.length = 0;
  state.preCompact.length = 0;
  state.postCompact.length = 0;
  state.sessionStart.length = 0;
  state.userPromptSubmit.length = 0;
  state.subagentLifecycle.length = 0;
  state.stop.length = 0;
}
