import { describe, it, expect } from "vitest";
import { checkSubAgentTool, cancelSubAgentTool } from "./manage-sub-agent";
import { SessionManager } from "../session-manager";
import type { ToolContext } from "./types";

/**
 * Sub-agent hardening (#3 polling contract, #4 cascade cancel) — tool surface.
 *
 * These tools resolve the SessionManager SINGLETON, so we seed it directly.
 */

const ctx = (userId: string): ToolContext =>
  ({ userId, db: {} as never }) as ToolContext;

describe("check_sub_agent (#3 polling contract)", () => {
  it("description spells out the polling contract", () => {
    expect(checkSubAgentTool.description).toMatch(/POLLING CONTRACT/);
    expect(checkSubAgentTool.description.toLowerCase()).toMatch(/check_sub_agent/);
  });

  it("surfaces result for failed sessions too (not just completed)", async () => {
    const mgr = SessionManager.getInstance();
    const s = mgr.createSession(undefined, "user-x");
    mgr.updateSession(s.id, { status: "failed", result: "boom" });

    const res = await checkSubAgentTool.execute({ sessionId: s.id }, ctx("user-x"));
    expect(res.success).toBe(true);
    expect((res.data as { result?: string }).result).toBe("boom");
    expect((res.data as { status?: string }).status).toBe("failed");
  });

  it("rejects access from a different user", async () => {
    const mgr = SessionManager.getInstance();
    const s = mgr.createSession(undefined, "owner");
    const res = await checkSubAgentTool.execute({ sessionId: s.id }, ctx("intruder"));
    expect(res.success).toBe(false);
    expect(res.displayText).toMatch(/Not authorized/);
  });
});

describe("cancel_sub_agent (#4 cascade)", () => {
  it("description mentions cascade", () => {
    expect(cancelSubAgentTool.description.toLowerCase()).toMatch(/cascade/);
    const params = cancelSubAgentTool.parameters as {
      properties: Record<string, unknown>;
    };
    expect(params.properties.cascade).toBeDefined();
  });

  it("cascade=true cancels the whole sub-tree", async () => {
    const mgr = SessionManager.getInstance();
    const root = mgr.createSession("conv", "u");
    const child = mgr.createSession(root.id, "u");
    const gc = mgr.createSession(child.id, "u");

    const res = await cancelSubAgentTool.execute(
      { sessionId: root.id, cascade: true },
      ctx("u"),
    );
    expect(res.success).toBe(true);
    const ids = (res.data as { cancelledIds: string[] }).cancelledIds;
    expect(new Set(ids)).toEqual(new Set([root.id, child.id, gc.id]));
    expect(mgr.getSession(gc.id)?.status).toBe("cancelled");
  });

  it("non-cascade cancels only the target", async () => {
    const mgr = SessionManager.getInstance();
    const root = mgr.createSession("conv2", "u2");
    const child = mgr.createSession(root.id, "u2");

    const res = await cancelSubAgentTool.execute({ sessionId: root.id }, ctx("u2"));
    expect(res.success).toBe(true);
    expect(mgr.getSession(root.id)?.status).toBe("cancelled");
    expect(mgr.getSession(child.id)?.status).toBe("running");
  });
});
