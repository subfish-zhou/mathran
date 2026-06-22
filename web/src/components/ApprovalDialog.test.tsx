import { describe, it, expect } from "vitest";
import {
  buildApprovalOptions,
  suggestPrefix,
  riskLabel,
  type ApprovalRequest,
} from "../lib/approval-client.ts";

function req(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "r1",
    tool: "bash",
    riskClass: "exec",
    trigger: "policy",
    preview: "bash: ls",
    args: { command: "ls" },
    ...over,
  };
}

describe("suggestPrefix", () => {
  it("returns the first two tokens of an exec command", () => {
    expect(suggestPrefix(req({ args: { command: "npm test src/" } }))).toBe("npm test");
  });

  it("returns the single token for a one-word command", () => {
    expect(suggestPrefix(req({ args: { command: "ls" } }))).toBe("ls");
  });

  it("returns undefined for non-exec risk", () => {
    expect(
      suggestPrefix(req({ riskClass: "write", args: { path: "a.txt" } })),
    ).toBeUndefined();
  });

  it("returns undefined when there is no command string", () => {
    expect(suggestPrefix(req({ args: {} }))).toBeUndefined();
    expect(suggestPrefix(req({ args: { command: "   " } }))).toBeUndefined();
  });
});

describe("buildApprovalOptions", () => {
  it("offers allow/deny + a prefix option for an exec policy prompt", () => {
    const opts = buildApprovalOptions(req({ args: { command: "npm test" } }));
    expect(opts.map((o) => o.outcome)).toEqual([
      "allow_once",
      "allow_session",
      "allow_prefix",
      "deny",
    ]);
    const prefixOpt = opts.find((o) => o.outcome === "allow_prefix");
    expect(prefixOpt?.prefix).toBe("npm test");
    expect(prefixOpt?.label).toContain("npm test");
  });

  it("omits allow_prefix for a write prompt (no command)", () => {
    const opts = buildApprovalOptions(
      req({ tool: "write_file", riskClass: "write", args: { path: "a.txt" } }),
    );
    expect(opts.map((o) => o.outcome)).toEqual([
      "allow_once",
      "allow_session",
      "deny",
    ]);
  });

  it("offers retry/abandon for an on-failure prompt", () => {
    const opts = buildApprovalOptions(req({ trigger: "on-failure" }));
    expect(opts.map((o) => o.outcome)).toEqual(["retry", "abandon"]);
    expect(opts.find((o) => o.outcome === "abandon")?.tone).toBe("danger");
  });

  it("marks allow_once primary and deny danger", () => {
    const opts = buildApprovalOptions(req());
    expect(opts.find((o) => o.outcome === "allow_once")?.tone).toBe("primary");
    expect(opts.find((o) => o.outcome === "deny")?.tone).toBe("danger");
  });
});

describe("riskLabel", () => {
  it("maps every risk class to a label", () => {
    expect(riskLabel("read")).toBe("read");
    expect(riskLabel("write")).toBe("write");
    expect(riskLabel("exec")).toBe("execute");
    expect(riskLabel("net")).toBe("network");
  });
});
