/**
 * Unit tests for the serve-mode approval HTTP plumbing
 * (`src/server/approval-routes.ts`): the {@link ApprovalRegistry} promise park,
 * the POST decision route, the GET pending-recovery route, and the decision
 * body parser.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  ApprovalRegistry,
  parseApprovalDecision,
  registerApprovalRoute,
} from "./approval-routes.js";
import type { ApprovalRequest } from "../core/approval/types.js";

function makeRequest(id: string, tool = "bash"): ApprovalRequest {
  return {
    id,
    tool,
    riskClass: "exec",
    trigger: "policy",
    preview: `${tool}: ls`,
    args: { command: "ls" },
  };
}

describe("ApprovalRegistry", () => {
  it("parks a promise that resolves on resolve()", async () => {
    const reg = new ApprovalRegistry();
    const p = reg.register("c1", makeRequest("r1"));
    expect(reg.pending("c1")).toHaveLength(1);

    const ok = reg.resolve("c1", "r1", { outcome: "allow_once" });
    expect(ok).toBe(true);
    await expect(p).resolves.toEqual({ outcome: "allow_once" });
    // bucket cleaned up once empty.
    expect(reg.pending("c1")).toHaveLength(0);
  });

  it("resolve() returns false for an unknown id", () => {
    const reg = new ApprovalRegistry();
    reg.register("c1", makeRequest("r1"));
    expect(reg.resolve("c1", "nope", { outcome: "deny" })).toBe(false);
    expect(reg.resolve("other", "r1", { outcome: "deny" })).toBe(false);
  });

  it("pending() lists every in-flight request for a conversation", () => {
    const reg = new ApprovalRegistry();
    reg.register("c1", makeRequest("r1", "bash"));
    reg.register("c1", makeRequest("r2", "write_file"));
    const pending = reg.pending("c1");
    expect(pending.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    expect(reg.pending("absent")).toEqual([]);
  });

  it("rejectPending() settles all parked prompts as deny", async () => {
    const reg = new ApprovalRegistry();
    const a = reg.register("c1", makeRequest("r1"));
    const b = reg.register("c1", makeRequest("r2"));
    reg.rejectPending("c1", "stream closed");
    await expect(a).resolves.toEqual({ outcome: "deny", reason: "stream closed" });
    await expect(b).resolves.toEqual({ outcome: "deny", reason: "stream closed" });
    expect(reg.pending("c1")).toHaveLength(0);
  });

  it("rejectPending() is a no-op for an unknown conversation", () => {
    const reg = new ApprovalRegistry();
    expect(() => reg.rejectPending("ghost")).not.toThrow();
  });
});

describe("parseApprovalDecision", () => {
  it("accepts every valid outcome", () => {
    for (const outcome of [
      "allow_once",
      "allow_session",
      "allow_prefix",
      "deny",
      "retry",
      "abandon",
    ]) {
      expect(parseApprovalDecision({ outcome })).toEqual({ outcome });
    }
  });

  it("carries prefix and reason through", () => {
    expect(
      parseApprovalDecision({ outcome: "allow_prefix", prefix: "npm test", reason: "safe" }),
    ).toEqual({ outcome: "allow_prefix", prefix: "npm test", reason: "safe" });
  });

  it("rejects missing / invalid / non-object bodies", () => {
    expect(parseApprovalDecision(null)).toBeNull();
    expect(parseApprovalDecision("deny")).toBeNull();
    expect(parseApprovalDecision({})).toBeNull();
    expect(parseApprovalDecision({ outcome: "nuke" })).toBeNull();
    expect(parseApprovalDecision({ outcome: 42 })).toBeNull();
  });

  it("ignores non-string prefix / reason", () => {
    expect(parseApprovalDecision({ outcome: "deny", prefix: 1, reason: {} })).toEqual({
      outcome: "deny",
    });
  });
});

describe("registerApprovalRoute", () => {
  function appWith(reg: ApprovalRegistry): Hono {
    const app = new Hono();
    registerApprovalRoute(app, "/api/chat", reg);
    return app;
  }

  it("POST resolves the parked prompt and returns the decision", async () => {
    const reg = new ApprovalRegistry();
    const app = appWith(reg);
    const parked = reg.register("c1", makeRequest("r1"));

    const res = await app.request("/api/chat/c1/approval/r1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "allow_session" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, id: "r1", decision: { outcome: "allow_session" } });
    await expect(parked).resolves.toEqual({ outcome: "allow_session" });
  });

  it("POST 404s when no prompt with that id is pending", async () => {
    const reg = new ApprovalRegistry();
    const app = appWith(reg);
    const res = await app.request("/api/chat/c1/approval/missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "deny" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST 400s on an invalid decision body", async () => {
    const reg = new ApprovalRegistry();
    const app = appWith(reg);
    reg.register("c1", makeRequest("r1"));
    const res = await app.request("/api/chat/c1/approval/r1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST 400s on malformed JSON", async () => {
    const reg = new ApprovalRegistry();
    const app = appWith(reg);
    reg.register("c1", makeRequest("r1"));
    const res = await app.request("/api/chat/c1/approval/r1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("GET lists pending prompts for recovery", async () => {
    const reg = new ApprovalRegistry();
    const app = appWith(reg);
    reg.register("c1", makeRequest("r1"));
    const res = await app.request("/api/chat/c1/approval");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pending).toHaveLength(1);
    expect(json.pending[0].id).toBe("r1");
  });
});
