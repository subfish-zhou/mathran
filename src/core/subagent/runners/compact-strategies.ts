/**
 * Compaction strategies dispatcher — TODO-2 §5.2 / C3.
 *
 * Multi-strategy registry pattern, mirroring codex's strategy selection
 * (codex-rs/core/src/compact.rs `should_use_remote_compact_task` +
 * compact_remote.rs / compact_remote_v2.rs as alternate runtimes).
 *
 * Mathran ships ONE built-in strategy (`local`) — but the dispatcher
 * exists so future plugins (remote summarizer, hierarchical summary,
 * etc.) can register without modifying core.
 *
 * Strategy registration:
 *   - registerCompactionStrategy(s) prepends to the list, so later
 *     registrations take precedence (plugin overrides built-in).
 *   - ensureBuiltInsRegistered() is idempotent; called lazily from
 *     ChatSession.compactV2 entry on first compact.
 *   - _resetStrategiesForTest() clears for unit tests.
 *
 * No actual strategy implementation in this file — C5 lands the real
 * LocalCompactionStrategy class inside compact.ts and re-exports it.
 * For now we accept any object satisfying the interface, and the
 * pickStrategy throws when no strategy is registered yet — this
 * forces callers + tests to be explicit about registration order.
 */

import type {
  CompactionRequest,
  CompactionOutcome,
} from "./compact-types.js";

/**
 * Pluggable compaction strategy. A strategy advertises which requests
 * it supports (via `supports()`) and runs them (via `run()`).
 *
 * Contract:
 *   - run() MUST never mutate req.messages (treat as read-only).
 *   - run() MUST observe req.signal at every retry boundary AND, if
 *     the LLMProvider supports it, forward signal to the LLM call.
 *   - run() MUST return ok=true ONLY when it has a valid newMessages
 *     to swap in. Any failure / cancellation / skip returns ok=false
 *     with the matching status; the caller (ChatSession.compactV2)
 *     will refuse to swap when ok=false.
 *   - run() MUST always populate telemetry, even on failure.
 */
export interface CompactionStrategyImpl {
  /** Human-readable strategy name. Surfaces in telemetry.strategy. */
  readonly name: string;
  /** Quick filter: does this strategy handle this request? */
  supports(req: CompactionRequest): boolean;
  /** Run the strategy. See contract above. */
  run(req: CompactionRequest): Promise<CompactionOutcome>;
}

/**
 * Registry of available strategies. Order matters: pickStrategy returns
 * the first one whose supports() returns true, so later-registered
 * strategies (typically plugins) take precedence by unshift-ing.
 */
const _strategies: CompactionStrategyImpl[] = [];

/**
 * Register a strategy. Newer registrations override older ones for the
 * same kind of request — plugins go in last, built-ins go in first.
 */
export function registerCompactionStrategy(s: CompactionStrategyImpl): void {
  _strategies.unshift(s);
}

/**
 * Resolve the strategy for a request. Throws if no strategy is registered
 * yet (caller forgot to bootstrap) or if all registered strategies
 * declined this request.
 */
export function pickStrategy(req: CompactionRequest): CompactionStrategyImpl {
  for (const s of _strategies) if (s.supports(req)) return s;
  throw new Error(
    `[compaction] no strategy supports reason=${req.reason} phase=${req.phase}`,
  );
}

/** Read-only view of currently registered strategy names. Useful for diagnostics. */
export function registeredStrategyNames(): string[] {
  return _strategies.map((s) => s.name);
}

/**
 * Built-in registration. ChatSession.compactV2 calls this once at the
 * top of every compactV2 invocation (idempotent). The actual
 * LocalCompactionStrategy class is constructed lazily — at the point
 * the import would otherwise cause a circular dependency between
 * compact.ts (which imports this module) and compact-strategies.ts.
 *
 * Pass a factory rather than letting this module import compact.ts:
 * the caller (ChatSession.compactV2 in C6) imports LocalCompactionStrategy
 * itself and passes the constructed instance.
 */
let _builtInsRegistered = false;
export function ensureBuiltInsRegistered(localStrategyFactory: () => CompactionStrategyImpl): void {
  if (_builtInsRegistered) return;
  registerCompactionStrategy(localStrategyFactory());
  _builtInsRegistered = true;
}

/** Test-only: clear the registry and reset built-ins flag. */
export function _resetStrategiesForTest(): void {
  _strategies.length = 0;
  _builtInsRegistered = false;
}
