/**
 * subagent-telemetry-hook — observe-only SubagentLifecycle hook. Writes a
 * structured JSON line to stdout for each sub-agent start/stop event. This
 * is a placeholder for future OTel / DataDog wiring; today it just gives us
 * a grep-friendly trail in mathub.log.
 *
 * Ported: 2026-06-10 (commit 4/6 of mathub-ai-codex-upgrade).
 */

import type { SubagentLifecycleHook } from "../types";
import { log } from "@/lib/observability/logger";

export const subagentTelemetryHook: SubagentLifecycleHook = {
  name: "subagent-telemetry",
  priority: 200, // late: let other hooks (auth, throttle) run first.

  async runStart(ev) {
    try {
      // [audit/G3] Was a manual `console.log(JSON.stringify(...))` which
      // bypassed the central logger (no env-based silencing in tests, no
      // common shape). The structured logger emits one JSON line per event
      // and is silent under NODE_ENV=test unless OBS_LOG_FORCE=1.
      log.info("subagent.start", {
        ts: ev.emittedAtMs,
        conversationId: ev.conversationId,
        childSessionId: ev.childSessionId,
        parentSessionId: ev.parentSessionId,
        agentName: ev.agentName,
        agentRole: ev.agentRole,
        depth: ev.depth,
      });
    } catch {
      // best-effort, never throw.
    }
    return { kind: "ack" };
  },

  async runStop(ev) {
    try {
      log.info("subagent.stop", {
        ts: ev.emittedAtMs,
        conversationId: ev.conversationId,
        childSessionId: ev.childSessionId,
        status: ev.status,
        durationMs: ev.durationMs,
        totalTokens: ev.totalTokens,
        resultPreviewLen: ev.resultPreview?.length ?? 0,
      });
    } catch {
      // best-effort, never throw.
    }
    return { kind: "ack" };
  },
};
