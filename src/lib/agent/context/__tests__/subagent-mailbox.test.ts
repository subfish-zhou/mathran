/**
 * 12 sub-agent mailbox tests.
 *
 * Ported: 2026-06-10 (commit 12/sprint-3 of mathub-ai-codex-upgrade).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueSubagentNotification,
  drainSubagentNotifications,
  peekSubagentNotifications,
  _resetForTest,
  SUBAGENT_MAILBOX_QUEUE_CAP,
} from "../subagent-mailbox";

afterEach(() => _resetForTest());

describe("subagent mailbox", () => {
  it("enqueue + drain returns FIFO", () => {
    enqueueSubagentNotification("conv-1", {
      agentReference: "a",
      status: "completed",
    });
    enqueueSubagentNotification("conv-1", {
      agentReference: "b",
      status: "failed",
    });
    const out = drainSubagentNotifications("conv-1");
    expect(out.map((n) => n.agentReference)).toEqual(["a", "b"]);
  });

  it("drain returns [] when empty", () => {
    expect(drainSubagentNotifications("nobody")).toEqual([]);
  });

  it("drain clears the queue", () => {
    enqueueSubagentNotification("conv-1", {
      agentReference: "x",
      status: "completed",
    });
    drainSubagentNotifications("conv-1");
    expect(drainSubagentNotifications("conv-1")).toEqual([]);
    expect(peekSubagentNotifications("conv-1")).toEqual([]);
  });

  it("isolates conversations", () => {
    enqueueSubagentNotification("conv-A", {
      agentReference: "a-1",
      status: "completed",
    });
    enqueueSubagentNotification("conv-B", {
      agentReference: "b-1",
      status: "failed",
    });
    const a = drainSubagentNotifications("conv-A");
    const b = drainSubagentNotifications("conv-B");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.agentReference).toBe("a-1");
    expect(b[0]!.agentReference).toBe("b-1");
  });

  it("peek does NOT clear", () => {
    enqueueSubagentNotification("conv-1", {
      agentReference: "p",
      status: "completed",
    });
    expect(peekSubagentNotifications("conv-1")).toHaveLength(1);
    expect(peekSubagentNotifications("conv-1")).toHaveLength(1); // still there
    expect(drainSubagentNotifications("conv-1")).toHaveLength(1);
  });

  it("trims oldest when overflowing QUEUE_CAP", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const overflow = 5;
    for (let i = 0; i < SUBAGENT_MAILBOX_QUEUE_CAP + overflow; i++) {
      enqueueSubagentNotification("conv-1", {
        agentReference: `s-${i}`,
        status: "completed",
      });
    }
    const out = drainSubagentNotifications("conv-1");
    expect(out).toHaveLength(SUBAGENT_MAILBOX_QUEUE_CAP);
    // First `overflow` entries dropped; oldest kept = s-{overflow}.
    expect(out[0]!.agentReference).toBe(`s-${overflow}`);
    // Last kept = s-(CAP+overflow-1).
    expect(out[out.length - 1]!.agentReference).toBe(
      `s-${SUBAGENT_MAILBOX_QUEUE_CAP + overflow - 1}`,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops + warns on empty conversationId", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    enqueueSubagentNotification("", {
      agentReference: "x",
      status: "completed",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(peekSubagentNotifications("")).toEqual([]);
  });

  it("_resetForTest empties all queues", () => {
    enqueueSubagentNotification("a", { agentReference: "1", status: "completed" });
    enqueueSubagentNotification("b", { agentReference: "2", status: "completed" });
    _resetForTest();
    expect(peekSubagentNotifications("a")).toEqual([]);
    expect(peekSubagentNotifications("b")).toEqual([]);
  });
});
