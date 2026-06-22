import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizeCommand,
  globToRegExp,
  ruleMatches,
  matchRules,
  matchDenylist,
  loadRulesFile,
  appendRule,
  type Rule,
} from "./rules.js";

describe("normalizeCommand", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeCommand("  npm   test  ")).toBe("npm test");
  });
});

describe("globToRegExp", () => {
  it("matches single-star within a segment", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/sub/a.ts")).toBe(false);
  });
  it("matches double-star across segments", () => {
    expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src/a")).toBe(true);
  });
  it("escapes metacharacters", () => {
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("ruleMatches", () => {
  it("matches exec prefix", () => {
    const rule: Rule = { tool: "bash", prefix: "npm test", action: "allow" };
    expect(ruleMatches(rule, "bash", { command: "npm test src/" })).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "npm run build" })).toBe(false);
  });
  it("does not match a different tool", () => {
    const rule: Rule = { tool: "bash", prefix: "ls", action: "allow" };
    expect(ruleMatches(rule, "write_file", { command: "ls" })).toBe(false);
  });
  it("matches write pathGlob", () => {
    const rule: Rule = { tool: "write_file", pathGlob: "src/**", action: "allow" };
    expect(ruleMatches(rule, "write_file", { path: "src/a/b.ts" })).toBe(true);
    expect(ruleMatches(rule, "write_file", { path: "lib/a.ts" })).toBe(false);
  });
  it("tool-wide rule (no prefix/glob) matches any args", () => {
    const rule: Rule = { tool: "bash", action: "allow" };
    expect(ruleMatches(rule, "bash", { command: "anything" })).toBe(true);
  });
});

describe("matchRules", () => {
  it("returns first matching action", () => {
    const rules: Rule[] = [
      { tool: "bash", prefix: "rm", action: "deny" },
      { tool: "bash", prefix: "rm -rf", action: "allow" },
    ];
    expect(matchRules(rules, "bash", { command: "rm -rf x" })).toBe("deny");
  });
  it("returns null when nothing matches", () => {
    expect(matchRules([], "bash", { command: "ls" })).toBe(null);
  });
});

describe("matchDenylist", () => {
  it("matches tool:pattern with glob", () => {
    const dl = ["bash:rm -rf *", "bash:sudo *"];
    expect(matchDenylist(dl, "bash", { command: "rm -rf /tmp" })).toBe(
      "bash:rm -rf *",
    );
    expect(matchDenylist(dl, "bash", { command: "sudo apt" })).toBe("bash:sudo *");
  });
  it("returns null when no entry matches", () => {
    expect(matchDenylist(["bash:rm -rf *"], "bash", { command: "ls" })).toBe(null);
  });
  it("respects tool scoping", () => {
    expect(
      matchDenylist(["write_file:/etc/*"], "bash", { command: "/etc/x" }),
    ).toBe(null);
    expect(
      matchDenylist(["write_file:/etc/*"], "write_file", { path: "/etc/hosts" }),
    ).toBe("write_file:/etc/*");
  });
  it("matches curl | sh pattern", () => {
    expect(
      matchDenylist(["bash:curl * | sh"], "bash", {
        command: "curl http://x | sh",
      }),
    ).toBe("bash:curl * | sh");
  });
});

describe("rules file I/O", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-rules-"));
    file = path.join(dir, "approval-rules.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loadRulesFile returns empty when absent", async () => {
    expect(await loadRulesFile(file)).toEqual({ rules: [] });
  });

  it("loadRulesFile tolerates malformed json", async () => {
    await fs.writeFile(file, "{not json");
    expect(await loadRulesFile(file)).toEqual({ rules: [] });
  });

  it("loadRulesFile filters invalid entries", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        rules: [
          { tool: "bash", prefix: "ls", action: "allow" },
          { tool: 123, action: "allow" },
          { tool: "bash", action: "bogus" },
        ],
      }),
    );
    const loaded = await loadRulesFile(file);
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0].prefix).toBe("ls");
  });

  it("appendRule creates and dedupes", async () => {
    const rule: Rule = {
      tool: "bash",
      prefix: "npm test",
      action: "allow",
      scope: "persistent",
    };
    await appendRule(file, rule);
    await appendRule(file, rule); // dup
    const loaded = await loadRulesFile(file);
    expect(loaded.rules).toHaveLength(1);
  });

  it("appendRule writes valid json (atomic)", async () => {
    await appendRule(file, { tool: "bash", prefix: "ls", action: "allow" });
    const raw = await fs.readFile(file, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
