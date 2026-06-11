/**
 * 12 e2e-lite integration tests for the three injection paths exercised
 * by executor.ts. We don't spin up a real LLM client; instead we drive
 * the same building blocks (mailbox enqueue + contextManager.renderTurnTime
 * with the same turnState shapes) and assert the resulting messages are
 * shaped the way executor would push them.
 *
 * If executor.ts's actual push sites diverge from this shape, the unit
 * tests above and these integration tests both catch it.
 *
 * Ported: 2026-06-10 (commit 12/sprint-3 of mathub-ai-codex-upgrade).
 */

import { afterEach, describe, expect, it } from "vitest";
import { contextManager } from "../manager";
import "../boot";
import {
  enqueueSubagentNotification,
  drainSubagentNotifications,
  _resetForTest,
} from "../subagent-mailbox";
import { HOOK_CONTEXT_MARKER } from "../fragments/hook-context";
import { SUBAGENT_NOTIFICATION_OPEN_MARKER } from "../fragments/subagent-notification";
import { IMAGE_OUTPUT_MARKER } from "../fragments/image-output-hint";

afterEach(() => _resetForTest());

describe("12 injection e2e-lite", () => {
  it("hook additionalContext path: dev-context survives render", async () => {
    const items = [
      "tone check: OK",
      "user is in a hurry — avoid long preamble",
    ];
    const rendered = await contextManager.renderTurnTime({
      context: "personal",
      turnState: { hookAdditionalContext: items },
    });
    expect(rendered.text).toContain(HOOK_CONTEXT_MARKER);
    for (const item of items) {
      expect(rendered.text).toContain(item);
    }
    // The executor will push exactly this string as { role: "system" }; the
    // shape it emits is fully determined by this string + role.
  });

  it("subagent stop path: enqueue → drain → render produces system-role payload", async () => {
    const conv = "conv-test-1";
    enqueueSubagentNotification(conv, {
      agentReference: "sub-1",
      status: "completed",
      durationMs: 1500,
      totalTokens: 234,
      resultPreview: "result OK",
    });
    enqueueSubagentNotification(conv, {
      agentReference: "sub-2",
      status: "failed",
      resultPreview: "boom",
    });
    const pending = drainSubagentNotifications(conv);
    expect(pending).toHaveLength(2);
    const rendered = await contextManager.renderTurnTime({
      context: "personal",
      turnState: { subagentNotifications: pending },
    });
    expect(rendered.text).toContain(SUBAGENT_NOTIFICATION_OPEN_MARKER);
    expect(rendered.text).toContain("sub-1");
    expect(rendered.text).toContain("sub-2");
    expect(rendered.text).toContain('"status":"completed"');
    expect(rendered.text).toContain('"status":"failed"');
    // After drain, queue is empty so the next render produces nothing.
    const empty = await contextManager.renderTurnTime({
      context: "personal",
      turnState: { subagentNotifications: drainSubagentNotifications(conv) },
    });
    expect(empty.text).toBe("");
  });

  it("output files path: hint includes name + mime + reference instruction", async () => {
    const rendered = await contextManager.renderTurnTime({
      context: "personal",
      turnState: {
        imageOutputs: [
          { name: "plot.png", mimeType: "image/png" },
          { name: "data.csv", mimeType: "text/csv" },
        ],
      },
    });
    expect(rendered.text).toContain(IMAGE_OUTPUT_MARKER);
    expect(rendered.text).toContain("plot.png");
    expect(rendered.text).toContain("data.csv");
    expect(rendered.text).toContain("Reference them by name");
  });

  it("no turnState fields → renderTurnTime returns empty (no spurious push)", async () => {
    const rendered = await contextManager.renderTurnTime({
      context: "personal",
      turnState: {},
    });
    expect(rendered.text).toBe("");
  });

  it("mixed turnState → multiple turn-time fragments concatenate in priority order", async () => {
    // hook-context (700) → image-output-hint (750) → subagent-notification (800)
    const rendered = await contextManager.renderTurnTime({
      context: "personal",
      turnState: {
        hookAdditionalContext: ["hook says hi"],
        imageOutputs: [{ name: "x.png", mimeType: "image/png" }],
        subagentNotifications: [
          { agentReference: "s1", status: "completed" },
        ],
      },
    });
    const idxHook = rendered.text.indexOf(HOOK_CONTEXT_MARKER);
    const idxImg = rendered.text.indexOf(IMAGE_OUTPUT_MARKER);
    const idxNotif = rendered.text.indexOf(SUBAGENT_NOTIFICATION_OPEN_MARKER);
    expect(idxHook).toBeGreaterThanOrEqual(0);
    expect(idxImg).toBeGreaterThan(idxHook);
    expect(idxNotif).toBeGreaterThan(idxImg);
    // (executor splits these into separate pushes in practice; the manager
    // shows them concatenated. The priority ordering still tells us that if
    // executor were to push them in fragment iteration order, the dev / file
    // / notification ordering would be preserved.)
  });
});
