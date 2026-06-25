import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalBroker } from "./approval-broker.js";
import { ApprovalHistory } from "../approval/history.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../approval/types.js";

function allowOnce(): ApprovalDecision {
  return { outcome: "allow_once" };
}

describe("ApprovalBroker.authorize — policy matrix", () => {
  it("never passes everything without a resolver", async () => {
    const broker = new ApprovalBroker({ policy: "never" });
    expect(await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "rm x" } })).toEqual({ kind: "allow" });
    expect(await broker.authorize({ tool: "write_file", riskClass: "write", args: { path: "a" } })).toEqual({ kind: "allow" });
  });

  it("read always passes", async () => {
    const broker = new ApprovalBroker({ policy: "on-request" });
    expect(await broker.authorize({ tool: "read_file", riskClass: "read", args: {} })).toEqual({ kind: "allow" });
  });

  it("on-request asks for exec and honors allow", async () => {
    const resolver = vi.fn(async () => allowOnce());
    const broker = new ApprovalBroker({ policy: "on-request", resolver, learning: false });
    const res = await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "ls" } });
    expect(res).toEqual({ kind: "allow" });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("on-request denies when user denies", async () => {
    const resolver = vi.fn(async (): Promise<ApprovalDecision> => ({ outcome: "deny", reason: "nope" }));
    const broker = new ApprovalBroker({ policy: "on-request", resolver, learning: false });
    const res = await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "ls" } });
    expect(res).toEqual({ kind: "deny", reason: "nope" });
  });

  it("fails safe to deny when ask but no resolver", async () => {
    const broker = new ApprovalBroker({ policy: "on-request" });
    const res = await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "ls" } });
    expect(res.kind).toBe("deny");
  });

  it("on-failure defers", async () => {
    const broker = new ApprovalBroker({ policy: "on-failure" });
    const res = await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "ls" } });
    expect(res).toEqual({ kind: "defer-on-failure" });
  });

  describe("untrusted", () => {
    it("passes a clean in-workspace write", async () => {
      const resolver = vi.fn(async () => allowOnce());
      const broker = new ApprovalBroker({ policy: "untrusted", workspace: "/ws", resolver });
      const res = await broker.authorize({ tool: "write_file", riskClass: "write", args: { path: "src/a.ts" } });
      expect(res).toEqual({ kind: "allow" });
      expect(resolver).not.toHaveBeenCalled();
    });

    it("asks when path escapes workspace", async () => {
      const resolver = vi.fn(async () => allowOnce());
      const broker = new ApprovalBroker({ policy: "untrusted", workspace: "/ws", resolver, learning: false });
      const res = await broker.authorize({ tool: "write_file", riskClass: "write", args: { path: "/etc/passwd" } });
      expect(res).toEqual({ kind: "allow" });
      expect(resolver).toHaveBeenCalledOnce();
    });

    it("asks when command is suspicious", async () => {
      const resolver = vi.fn(async () => allowOnce());
      const broker = new ApprovalBroker({ policy: "untrusted", workspace: "/ws", resolver, learning: false });
      await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "sudo rm" } });
      expect(resolver).toHaveBeenCalledOnce();
    });
  });
});

describe("ApprovalBroker — denylist + rules", () => {
  it("denylist vetoes even with allow rule", async () => {
    const broker = new ApprovalBroker({
      policy: "never",
      denylist: ["bash:rm -rf *"],
      inlineRules: [{ tool: "bash", action: "allow" }],
    });
    const res = await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "rm -rf /" } });
    expect(res.kind).toBe("deny");
  });

  it("inline allow rule skips the prompt", async () => {
    const resolver = vi.fn(async () => allowOnce());
    const broker = new ApprovalBroker({
      policy: "on-request",
      resolver,
      inlineRules: [{ tool: "bash", prefix: "ls", action: "allow" }],
      learning: false,
    });
    const res = await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "ls -la" } });
    expect(res).toEqual({ kind: "allow" });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("inline deny rule blocks", async () => {
    const broker = new ApprovalBroker({
      policy: "never",
      inlineRules: [{ tool: "bash", prefix: "curl", action: "deny" }],
    });
    const res = await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "curl x" } });
    expect(res.kind).toBe("deny");
  });
});

describe("ApprovalBroker — session rules", () => {
  it("allow_session auto-approves subsequent calls", async () => {
    const resolver = vi.fn(async (): Promise<ApprovalDecision> => ({ outcome: "allow_session" }));
    const broker = new ApprovalBroker({ policy: "on-request", resolver, learning: false });
    await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "ls" } });
    const res = await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "pwd" } });
    expect(res).toEqual({ kind: "allow" });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("allow_prefix auto-approves matching prefix only", async () => {
    const resolver = vi.fn(async (): Promise<ApprovalDecision> => ({ outcome: "allow_prefix", prefix: "npm test" }));
    const broker = new ApprovalBroker({ policy: "on-request", resolver, learning: false });
    await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "npm test src/" } });
    // matching prefix → no prompt
    const r1 = await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "npm test lib/" } });
    expect(r1).toEqual({ kind: "allow" });
    expect(resolver).toHaveBeenCalledOnce();
    // different command → prompts again
    await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "npm run build" } });
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

describe("ApprovalBroker.onFailure", () => {
  it("retry then abandon", async () => {
    const resolver = vi
      .fn(async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ outcome: "retry" }))
      .mockResolvedValueOnce({ outcome: "retry" })
      .mockResolvedValueOnce({ outcome: "abandon", reason: "give up" });
    const broker = new ApprovalBroker({ policy: "on-failure", resolver });
    const call = { tool: "bash", riskClass: "exec" as const, args: { command: "ls" } };
    expect(await broker.onFailure(call, "boom")).toEqual({ kind: "retry" });
    expect(await broker.onFailure(call, "boom")).toEqual({ kind: "abandon", reason: "give up" });
  });

  it("abandons when no resolver", async () => {
    const broker = new ApprovalBroker({ policy: "on-failure" });
    const res = await broker.onFailure({ tool: "bash", riskClass: "exec", args: {} }, "boom");
    expect(res.kind).toBe("abandon");
  });
});

describe("ApprovalBroker — learning mode", () => {
  let dir: string;
  let histFile: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-broker-"));
    histFile = path.join(dir, "history.jsonl");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("proposes a rule after threshold and persists on accept", async () => {
    const resolver = vi.fn(async () => allowOnce());
    const proposalResolver = vi.fn(async () => true);
    const ruleFile = path.join(dir, "approval-rules.json");
    const broker = new ApprovalBroker({
      policy: "on-request",
      resolver,
      proposalResolver,
      history: new ApprovalHistory(histFile, { proposeAfter: 3 }),
      proposeAfter: 3,
      persistentRuleFile: ruleFile,
    });
    for (let i = 0; i < 3; i++) {
      await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "npm test x" } });
    }
    expect(proposalResolver).toHaveBeenCalledOnce();
    const written = JSON.parse(await fs.readFile(ruleFile, "utf-8"));
    expect(written.rules[0]).toMatchObject({ tool: "bash", prefix: "npm test", action: "allow" });
  });

  it("does not persist when proposal declined", async () => {
    const resolver = vi.fn(async () => allowOnce());
    const proposalResolver = vi.fn(async () => false);
    const broker = new ApprovalBroker({
      policy: "on-request",
      resolver,
      proposalResolver,
      history: new ApprovalHistory(histFile, { proposeAfter: 2 }),
      proposeAfter: 2,
    });
    for (let i = 0; i < 2; i++) {
      await broker.authorize({ tool: "bash", riskClass: "exec", args: { command: "ls -l" } });
    }
    expect(proposalResolver).toHaveBeenCalledOnce();
    expect(broker.sessionRulesSnapshot).toHaveLength(0);
  });
});

describe("ApprovalBroker.preCheck / resolveDecision (yield-based host)", () => {
  it("preCheck denies via denylist without a resolver", async () => {
    const broker = new ApprovalBroker({
      policy: "never",
      denylist: ["bash:rm -rf *"],
    });
    const res = await broker.preCheck({
      tool: "bash",
      riskClass: "exec",
      args: { command: "rm -rf /" },
    });
    expect(res.kind).toBe("deny");
  });

  it("preCheck allows read regardless of policy", async () => {
    const broker = new ApprovalBroker({ policy: "on-request" });
    const res = await broker.preCheck({
      tool: "read_file",
      riskClass: "read",
      args: {},
    });
    expect(res).toEqual({ kind: "allow" });
  });

  it("preCheck returns ask + request for high-risk on-request", async () => {
    const broker = new ApprovalBroker({ policy: "on-request" });
    const res = await broker.preCheck({
      tool: "bash",
      riskClass: "exec",
      args: { command: "ls" },
      id: "call-1",
    });
    expect(res.kind).toBe("ask");
    if (res.kind === "ask") {
      expect(res.request.id).toBe("call-1");
      expect(res.request.tool).toBe("bash");
      expect(res.request.riskClass).toBe("exec");
    }
  });

  it("preCheck returns defer-on-failure for on-failure policy", async () => {
    const broker = new ApprovalBroker({ policy: "on-failure" });
    const res = await broker.preCheck({
      tool: "bash",
      riskClass: "exec",
      args: { command: "ls" },
    });
    expect(res).toEqual({ kind: "defer-on-failure" });
  });

  it("resolveDecision honors allow and deny + records side effects", async () => {
    const broker = new ApprovalBroker({ policy: "on-request", learning: false });
    const call = { tool: "bash", riskClass: "exec" as const, args: { command: "ls" } };
    expect(await broker.resolveDecision(call, { outcome: "allow_once" })).toEqual({
      kind: "allow",
    });
    expect(await broker.resolveDecision(call, { outcome: "deny", reason: "x" })).toEqual({
      kind: "deny",
      reason: "x",
    });
  });

  it("resolveDecision allow_session installs a session rule", async () => {
    const broker = new ApprovalBroker({ policy: "on-request", learning: false });
    const call = { tool: "bash", riskClass: "exec" as const, args: { command: "ls" } };
    await broker.resolveDecision(call, { outcome: "allow_session" });
    expect(broker.sessionRulesSnapshot.length).toBeGreaterThan(0);
    // Subsequent preCheck for the same prefix is auto-allowed.
    const res = await broker.preCheck(call);
    expect(res).toEqual({ kind: "allow" });
  });

  it("buildFailureRequest + applyFailureDecision map retry/abandon", async () => {
    const broker = new ApprovalBroker({ policy: "on-failure" });
    const req = broker.buildFailureRequest(
      { tool: "bash", riskClass: "exec", args: { command: "ls" } },
      "boom",
    );
    expect(req.trigger).toBe("on-failure");
    expect(req.rationale).toBe("boom");
    expect(broker.applyFailureDecision({ outcome: "retry" })).toEqual({ kind: "retry" });
    expect(
      broker.applyFailureDecision({ outcome: "abandon", reason: "stop" }),
    ).toEqual({ kind: "abandon", reason: "stop" });
  });

  describe("requiresDiffPreview (UX gap A)", () => {
    it("true when the matching allow rule sets requireDiffPreview", async () => {
      const broker = new ApprovalBroker({
        policy: "on-request",
        learning: false,
        inlineRules: [
          { tool: "write_file", pathGlob: "**", action: "allow", requireDiffPreview: true },
        ],
      });
      expect(
        await broker.requiresDiffPreview({ tool: "write_file", args: { path: "a.txt" } }),
      ).toBe(true);
    });

    it("false for a plain allow rule (backward compat)", async () => {
      const broker = new ApprovalBroker({
        policy: "on-request",
        learning: false,
        inlineRules: [{ tool: "write_file", pathGlob: "**", action: "allow" }],
      });
      expect(
        await broker.requiresDiffPreview({ tool: "write_file", args: { path: "a.txt" } }),
      ).toBe(false);
    });

    it("false when no rule matches", async () => {
      const broker = new ApprovalBroker({ policy: "on-request", learning: false });
      expect(
        await broker.requiresDiffPreview({ tool: "write_file", args: { path: "a.txt" } }),
      ).toBe(false);
    });

    it("false when a denylist entry vetoes the call", async () => {
      const broker = new ApprovalBroker({
        policy: "on-request",
        learning: false,
        denylist: ["write_file:/etc/*"],
        inlineRules: [
          { tool: "write_file", pathGlob: "**", action: "allow", requireDiffPreview: true },
        ],
      });
      expect(
        await broker.requiresDiffPreview({ tool: "write_file", args: { path: "/etc/passwd" } }),
      ).toBe(false);
    });
  });
});
