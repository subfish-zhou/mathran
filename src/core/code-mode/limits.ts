/**
 * Code mode v1 — runtime budget helpers.
 *
 * Two limits, both enforced by QuickJS itself rather than the host:
 *
 *   - **Memory** — `runtime.setMemoryLimit(bytes)` clamps the entire VM heap.
 *     When QuickJS hits it, the next allocation throws an "out of memory"
 *     error inside the VM, which propagates up to `evalCodeAsync` as a
 *     rejected promise. We translate that into `{ ok: false, oom: true }`.
 *
 *   - **CPU / wall-clock** — `runtime.setInterruptHandler(fn)` is called
 *     every ~1k bytecode instructions. We return `true` once the deadline
 *     is past, and QuickJS aborts the current execution. The cost is one
 *     `Date.now()` per call; cheap enough at this frequency.
 *
 * Defaults:
 *   - 256 MiB memory
 *   - 60 000 ms (60 s) wall-clock — calibrated so a script can run dozens of
 *     fast tool calls (read_file / glob / grep are sub-ms in the host) and
 *     still finish, but a busy loop can't tie up the LLM loop forever.
 *
 * These are intentionally generous compared to typical sandbox defaults
 * (5s/64MiB) because the WHOLE POINT of code mode is to do work that would
 * otherwise be 60 LLM round-trips. If you find yourself bumping these, that's
 * the design working.
 */

export const DEFAULT_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_STACK_BYTES = 1 * 1024 * 1024;

/**
 * Build a QuickJS interrupt handler that fires when wall-clock exceeds the
 * deadline. We capture `deadline` in closure rather than reading a shared
 * mutable — keeps the hot path branch-free aside from `Date.now()`.
 *
 * Returns the function plus a `getInterrupted()` probe — after `evalCodeAsync`
 * resolves/rejects, host code calls this to distinguish "user threw" from
 * "we tripped the interrupt".
 */
export function makeDeadlineInterruptHandler(timeoutMs: number): {
  handler: () => boolean;
  getInterrupted: () => boolean;
  start: () => void;
} {
  let deadline = Number.POSITIVE_INFINITY;
  let interrupted = false;
  return {
    start() {
      deadline = Date.now() + timeoutMs;
      interrupted = false;
    },
    handler() {
      if (Date.now() > deadline) {
        interrupted = true;
        return true;
      }
      return false;
    },
    getInterrupted() {
      return interrupted;
    },
  };
}

/**
 * Heuristic detector for QuickJS OOM. QuickJS surfaces it as a thrown error
 * whose message contains "out of memory" (varies a little across builds, so
 * we sniff case-insensitively). Used to set `meta.oom = true` so the LLM
 * sees an actionable reason rather than a generic crash.
 */
export function isOomError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
  return msg.includes("out of memory") || msg.includes("memory limit");
}

/**
 * Heuristic detector for QuickJS interrupt-aborted runs. QuickJS throws
 * "interrupted" when our handler returns true; we also tolerate variants
 * for forward compatibility with quickjs-ng.
 */
export function isInterruptedError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
  return msg.includes("interrupted") || msg.includes("execution aborted");
}
