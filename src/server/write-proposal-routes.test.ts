import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  WriteProposalRegistry,
  parseWriteProposalDecision,
  registerWriteProposalRoute,
} from "./write-proposal-routes.js";
import type { WriteProposal } from "../core/approval/diff-preview.js";

function proposal(toolCallId: string): WriteProposal {
  return {
    toolCallId,
    path: "a.txt",
    oldContent: "",
    newContent: "hi",
    diffText: "+hi",
    mode: "create",
  };
}

describe("parseWriteProposalDecision", () => {
  it("accepts a plain accept", () => {
    expect(parseWriteProposalDecision({ outcome: "accept" })).toEqual({
      outcome: "accept",
    });
  });
  it("accepts an accept with editedContent", () => {
    expect(
      parseWriteProposalDecision({ outcome: "accept", editedContent: "x" }),
    ).toEqual({ outcome: "accept", editedContent: "x" });
  });
  it("ignores editedContent on decline", () => {
    expect(
      parseWriteProposalDecision({ outcome: "decline", editedContent: "x" }),
    ).toEqual({ outcome: "decline" });
  });
  it("rejects an unknown outcome", () => {
    expect(parseWriteProposalDecision({ outcome: "nope" })).toBeNull();
    expect(parseWriteProposalDecision(null)).toBeNull();
    expect(parseWriteProposalDecision({})).toBeNull();
  });
});

describe("WriteProposalRegistry", () => {
  it("resolves a parked proposal via POST", async () => {
    const reg = new WriteProposalRegistry();
    const promise = reg.register("conv1", proposal("w1"));
    expect(reg.pending("conv1").map((p) => p.toolCallId)).toEqual(["w1"]);
    const ok = reg.resolve("conv1", "w1", { outcome: "accept" });
    expect(ok).toBe(true);
    await expect(promise).resolves.toEqual({ outcome: "accept" });
    expect(reg.pending("conv1")).toEqual([]);
  });

  it("returns false for an unknown id", () => {
    const reg = new WriteProposalRegistry();
    expect(reg.resolve("conv1", "ghost", { outcome: "accept" })).toBe(false);
  });

  it("rejectPending settles everything as decline", async () => {
    const reg = new WriteProposalRegistry();
    const p = reg.register("conv1", proposal("w1"));
    reg.rejectPending("conv1");
    await expect(p).resolves.toEqual({ outcome: "decline" });
    expect(reg.pending("conv1")).toEqual([]);
  });

  it("HTTP route resolves a parked proposal", async () => {
    const reg = new WriteProposalRegistry();
    const app = new Hono();
    registerWriteProposalRoute(app, "/api/chat", reg);
    const promise = reg.register("conv1", proposal("w1"));

    const res = await app.request("/api/chat/conv1/write-proposal/w1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "accept", editedContent: "edited" }),
    });
    expect(res.status).toBe(200);
    await expect(promise).resolves.toEqual({
      outcome: "accept",
      editedContent: "edited",
    });
  });

  it("HTTP route 404s an unknown id", async () => {
    const reg = new WriteProposalRegistry();
    const app = new Hono();
    registerWriteProposalRoute(app, "/api/chat", reg);
    const res = await app.request("/api/chat/conv1/write-proposal/ghost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "accept" }),
    });
    expect(res.status).toBe(404);
  });

  it("HTTP GET lists pending proposals", async () => {
    const reg = new WriteProposalRegistry();
    const app = new Hono();
    registerWriteProposalRoute(app, "/api/chat", reg);
    reg.register("conv1", proposal("w1"));
    const res = await app.request("/api/chat/conv1/write-proposal");
    const body = (await res.json()) as { pending: WriteProposal[] };
    expect(body.pending.map((p) => p.toolCallId)).toEqual(["w1"]);
  });
});
