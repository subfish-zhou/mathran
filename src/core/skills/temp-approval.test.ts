import { describe, it, expect } from "vitest";

import { ApprovalBroker } from "../chat/approval-broker.js";
import type { LoadedSkill } from "./loader.js";
import {
  parseAllowedTool,
  skillToolRules,
  registerSkillToolRules,
} from "./temp-approval.js";

function skill(allowedTools?: string[]): LoadedSkill {
  return {
    name: "s",
    layer: "user",
    path: "/fake/s/SKILL.md",
    manifest: { name: "s", ...(allowedTools ? { allowedTools } : {}) } as LoadedSkill["manifest"],
    body: "",
  };
}

describe("parseAllowedTool", () => {
  it("parses a bare tool name", () => {
    expect(parseAllowedTool("bash")).toEqual({
      tool: "bash",
      action: "allow",
      scope: "session",
    });
  });

  it("parses tool:prefix", () => {
    expect(parseAllowedTool("bash:lake build")).toEqual({
      tool: "bash",
      prefix: "lake build",
      action: "allow",
      scope: "session",
    });
  });

  it("treats an empty prefix as a whole-tool rule", () => {
    expect(parseAllowedTool("bash:")).toEqual({
      tool: "bash",
      action: "allow",
      scope: "session",
    });
  });

  it("returns null for empty / malformed entries", () => {
    expect(parseAllowedTool("")).toBeNull();
    expect(parseAllowedTool("   ")).toBeNull();
    expect(parseAllowedTool(":prefix")).toBeNull();
  });
});

describe("skillToolRules", () => {
  it("maps every entry and skips bad ones", () => {
    const rules = skillToolRules(skill(["bash:lake", "", "read_file"]));
    expect(rules).toEqual([
      { tool: "bash", prefix: "lake", action: "allow", scope: "session" },
      { tool: "read_file", action: "allow", scope: "session" },
    ]);
  });

  it("returns [] when no allowedTools", () => {
    expect(skillToolRules(skill())).toEqual([]);
  });
});

describe("registerSkillToolRules", () => {
  it("no-op when broker is undefined", () => {
    expect(registerSkillToolRules(undefined, skill(["bash"]))).toEqual([]);
  });

  it("registers session rules on the broker", () => {
    const broker = new ApprovalBroker({ policy: "on-request" });
    registerSkillToolRules(broker, skill(["bash:lake", "read_file"]));
    expect(broker.sessionRulesSnapshot).toEqual([
      { tool: "bash", prefix: "lake", action: "allow", scope: "session" },
      { tool: "read_file", action: "allow", scope: "session" },
    ]);
  });

  it("a registered allow makes the tool authorize without a prompt", async () => {
    // 'on-request' normally asks for every exec; with no resolver an 'ask'
    // would auto-deny. A skill allow rule short-circuits to allow.
    const broker = new ApprovalBroker({ policy: "on-request" });
    registerSkillToolRules(broker, skill(["bash:echo"]));
    const res = await broker.authorize({
      tool: "bash",
      riskClass: "exec",
      args: { command: "echo hi" },
    });
    expect(res.kind).toBe("allow");
  });

  it("denylist still wins over a skill allow", async () => {
    const broker = new ApprovalBroker({
      policy: "on-request",
      denylist: ["bash:rm -rf *"],
    });
    registerSkillToolRules(broker, skill(["bash"]));
    const res = await broker.authorize({
      tool: "bash",
      riskClass: "exec",
      args: { command: "rm -rf /" },
    });
    expect(res.kind).toBe("deny");
  });

  it("a tool the skill did NOT list is unaffected", async () => {
    const broker = new ApprovalBroker({ policy: "on-request" });
    registerSkillToolRules(broker, skill(["read_file"]));
    const res = await broker.authorize({
      tool: "bash",
      riskClass: "exec",
      args: { command: "echo hi" },
    });
    // No resolver + on-request ⇒ ask fails safe to deny.
    expect(res.kind).toBe("deny");
  });
});
