import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HookHistory,
  relativeAge,
  outcomeTag,
  type HookExecutionRecord,
} from "./history.js";

function rec(
  over: Partial<HookExecutionRecord> & { stdout?: string; stderr?: string } = {},
) {
  return {
    name: "post-edit",
    type: "post-edit" as const,
    layer: "workspace" as const,
    exitCode: 0,
    blocked: false,
    timedOut: false,
    durationMs: 10,
    truncated: false,
    ...over,
  };
}

describe("HookHistory", () => {
  it("records and returns all by name", () => {
    const h = new HookHistory({ now: () => 1000 });
    h.record(rec());
    h.record(rec({ name: "pre-bash", type: "pre-bash" }));
    expect(h.all().length).toBe(2);
    expect(h.all("post-edit").length).toBe(1);
    expect(h.names()).toEqual(["post-edit", "pre-bash"]);
  });

  it("recent returns newest first, capped", () => {
    let t = 0;
    const h = new HookHistory({ now: () => (t += 1000) });
    for (let i = 0; i < 7; i++) h.record(rec({ exitCode: i }));
    const r = h.recent("post-edit", 5);
    expect(r.length).toBe(5);
    expect(r[0].exitCode).toBe(6);
    expect(r[4].exitCode).toBe(2);
  });

  it("last returns the most recent record", () => {
    let t = 0;
    const h = new HookHistory({ now: () => (t += 1000) });
    h.record(rec({ exitCode: 1 }));
    h.record(rec({ exitCode: 2 }));
    expect(h.last("post-edit")?.exitCode).toBe(2);
    expect(h.last("nope")).toBeUndefined();
  });

  it("countToday only counts records since local midnight", () => {
    const noonToday = new Date();
    noonToday.setHours(12, 0, 0, 0);
    const yesterday = noonToday.getTime() - 24 * 3600 * 1000;
    const h = new HookHistory({ now: () => noonToday.getTime() });
    h.record(rec({ at: yesterday }));
    h.record(rec({ at: noonToday.getTime() }));
    h.record(rec({ at: noonToday.getTime() }));
    expect(h.countToday("post-edit")).toBe(2);
  });

  it("evicts oldest beyond maxInMemory", () => {
    const h = new HookHistory({ maxInMemory: 3, now: () => 1 });
    for (let i = 0; i < 5; i++) h.record(rec({ exitCode: i }));
    const all = h.all();
    expect(all.length).toBe(3);
    expect(all[0].exitCode).toBe(2);
  });

  it("appends to a JSONL file when configured", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-hist-"));
    try {
      const file = path.join(tmp, "nested", "hooks.jsonl");
      const h = new HookHistory({ jsonlPath: file, now: () => 42 });
      h.record(rec({ stdout: "hello" }));
      const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.name).toBe("post-edit");
      expect(parsed.at).toBe(42);
      expect(parsed.stdoutPreview).toBe("hello");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("caps stdout/stderr previews", () => {
    const h = new HookHistory({ now: () => 1 });
    const full = h.record(rec({ stdout: "x".repeat(5000) }));
    expect(full.stdoutPreview!.length).toBeLessThan(2100);
    expect(full.stdoutPreview!.endsWith("…")).toBe(true);
  });
});

describe("relativeAge", () => {
  it("formats ms/s/min/h/d", () => {
    expect(relativeAge(900, 1000)).toBe("100ms ago");
    expect(relativeAge(0, 1200)).toBe("1.2s ago");
    expect(relativeAge(0, 5 * 60_000)).toBe("5min ago");
    expect(relativeAge(0, 3 * 3600_000)).toBe("3h ago");
    expect(relativeAge(0, 2 * 86_400_000)).toBe("2d ago");
  });
});

describe("outcomeTag", () => {
  it("classifies outcomes", () => {
    expect(outcomeTag(rec() as HookExecutionRecord)).toBe("ok");
    expect(outcomeTag(rec({ blocked: true }) as HookExecutionRecord)).toBe("blocked");
    expect(outcomeTag(rec({ exitCode: 1 }) as HookExecutionRecord)).toBe("failed");
    expect(outcomeTag(rec({ timedOut: true }) as HookExecutionRecord)).toBe("failed");
  });
});
