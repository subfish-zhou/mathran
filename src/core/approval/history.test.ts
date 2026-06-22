import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  derivePrefix,
  appendHistory,
  loadHistory,
  evaluateProposal,
  ApprovalHistory,
  type HistoryEvent,
} from "./history.js";

describe("derivePrefix", () => {
  it("takes first two tokens of a command", () => {
    expect(derivePrefix("bash", { command: "npm test src/core" })).toBe(
      "npm test",
    );
  });
  it("uses path for write tools", () => {
    expect(derivePrefix("write_file", { path: "src/a.ts" })).toBe("src/a.ts");
  });
  it("falls back to tool name", () => {
    expect(derivePrefix("bash", {})).toBe("bash");
  });
});

describe("evaluateProposal", () => {
  const mk = (
    outcome: "allow" | "deny",
    ts = 0,
    tool = "bash",
    prefix = "npm test",
  ): HistoryEvent => ({ ts, type: "decision", tool, prefix, outcome });

  it("proposes after N consecutive allows", () => {
    const events = Array.from({ length: 5 }, (_, i) => mk("allow", i));
    expect(
      evaluateProposal(events, "bash", "npm test", { proposeAfter: 5, now: 100 }),
    ).toBe(5);
  });

  it("does not propose below threshold", () => {
    const events = Array.from({ length: 4 }, (_, i) => mk("allow", i));
    expect(
      evaluateProposal(events, "bash", "npm test", { proposeAfter: 5, now: 100 }),
    ).toBe(null);
  });

  it("deny resets the streak", () => {
    const events = [
      mk("allow", 0),
      mk("allow", 1),
      mk("deny", 2),
      mk("allow", 3),
      mk("allow", 4),
    ];
    expect(
      evaluateProposal(events, "bash", "npm test", { proposeAfter: 3, now: 100 }),
    ).toBe(null);
  });

  it("respects cooldown after a proposal", () => {
    const events: HistoryEvent[] = [
      ...Array.from({ length: 5 }, (_, i) => mk("allow", i)),
      { ts: 50, type: "proposal", tool: "bash", prefix: "npm test" },
    ];
    // now within cooldown of the proposal at ts=50
    expect(
      evaluateProposal(events, "bash", "npm test", {
        proposeAfter: 5,
        cooldownMs: 1000,
        now: 100,
      }),
    ).toBe(null);
    // now well past cooldown
    expect(
      evaluateProposal(events, "bash", "npm test", {
        proposeAfter: 5,
        cooldownMs: 1000,
        now: 5000,
      }),
    ).toBe(5);
  });

  it("scopes streak by tool+prefix", () => {
    const events = [
      mk("allow", 0, "bash", "npm test"),
      mk("allow", 1, "bash", "ls"),
      mk("allow", 2, "bash", "npm test"),
    ];
    expect(
      evaluateProposal(events, "bash", "npm test", { proposeAfter: 2, now: 100 }),
    ).toBe(2);
  });
});

describe("history file I/O", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-hist-"));
    file = path.join(dir, "approval-history.jsonl");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loadHistory returns empty when absent", async () => {
    expect(await loadHistory(file)).toEqual([]);
  });

  it("append + load round-trips", async () => {
    await appendHistory(file, {
      ts: 1,
      type: "decision",
      tool: "bash",
      prefix: "ls",
      outcome: "allow",
    });
    const loaded = await loadHistory(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].outcome).toBe("allow");
  });

  it("skips malformed trailing lines", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        ts: 1,
        type: "decision",
        tool: "bash",
        prefix: "ls",
        outcome: "allow",
      }) + "\n{truncated",
    );
    expect(await loadHistory(file)).toHaveLength(1);
  });

  it("ApprovalHistory proposes after threshold", async () => {
    const h = new ApprovalHistory(file, { proposeAfter: 3 });
    let streak: number | null = null;
    for (let i = 0; i < 3; i++) {
      streak = await h.recordDecision("bash", "npm test", "allow", i);
    }
    expect(streak).toBe(3);
  });

  it("ApprovalHistory deny returns null", async () => {
    const h = new ApprovalHistory(file, { proposeAfter: 1 });
    const streak = await h.recordDecision("bash", "ls", "deny", 0);
    expect(streak).toBe(null);
  });

  it("ApprovalHistory recordProposal silences next proposal (cooldown)", async () => {
    const h = new ApprovalHistory(file, { proposeAfter: 2, cooldownMs: 10_000 });
    await h.recordDecision("bash", "ls", "allow", 0);
    await h.recordProposal("bash", "ls", 1);
    const streak = await h.recordDecision("bash", "ls", "allow", 2);
    expect(streak).toBe(null);
  });
});
