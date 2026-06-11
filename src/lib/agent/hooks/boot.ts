/**
 * Hook boot — registers all builtin hooks once at process start. Idempotent.
 *
 * Commit 4/6: subagent-telemetry-hook registered. SubagentStart / SubagentStop
 * call sites land in commit 4b (session-manager wiring).
 *
 * Call from the chat-handler / executor entry points; safe to call from many
 * call sites — guarded by the `booted` flag.
 *
 * Ported: 2026-06-10 (commit 4/6 of mathub-ai-codex-upgrade).
 */

import { registerSubagentLifecycle } from "./registry";
import { subagentTelemetryHook } from "./builtin/subagent-telemetry-hook";
import { ensureMentionFlushSinkBooted } from "../skills/mention-counter-db-sink";

let booted = false;

export function registerBuiltinHooks(): void {
  if (booted) return;
  booted = true;
  registerSubagentLifecycle(subagentTelemetryHook);
  // [commit-6c] Skill mention counter → DB flush sink. Skipped in
  // NODE_ENV=test by the sink itself so unit tests stay self-contained.
  ensureMentionFlushSinkBooted();
  // commit 5 will append goal-related hooks here.
}

/** Test-only: reset boot flag so a fresh registration set can be installed. */
export function _resetBuiltinHookBootForTest(): void {
  booted = false;
}

// Module-load auto-boot: first import wires the builtins so callers do not
// have to remember to invoke registerBuiltinHooks(). Tests that need a clean
// slate call _resetBuiltinHookBootForTest() + reset the registry separately.
registerBuiltinHooks();
