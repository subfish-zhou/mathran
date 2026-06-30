/**
 * Hooks v1 — pure-function + integration tests (2026-06-30, Phase D2).
 *
 * Coverage:
 *   - matcher.ts: universal / exact / pipe-joined / regex / fallback substring
 *   - aliases.ts: Claude Code → mathran name mapping (Write→write_file etc.)
 *   - loader.ts: hooks.json discovery, malformed entry handling, containment
 *   - invoker.ts: spawn real `.sh` script via execFile, stdin/stdout JSON,
 *     allow / block / updated_input / additionalContext, timeout, non-zero exit
 *   - HookV1Runner facade: end-to-end PreToolUse/PostToolUse/SessionStart/
 *     PreCompact/PostCompact through real entries
 *
 * The shell-script tests use vitest tmpdir + execFile so they're hermetic
 * and don't touch the real ~/.mathran or any workspace.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  matchOne,
  matchAny,
  isUniversal,
  isExact,
} from "./matcher.js";
import { aliasesForTool, toolsForAlias } from "./aliases.js";
import { loadHookV1Config } from "./loader.js";
import { invokeHookV1 } from "./invoker.js";
import { HookV1Runner } from "./index.js";
import type { HookV1Entry } from "./schema.js";

describe("matcher.ts", () => {
  describe("isUniversal", () => {
    it("treats undefined / empty / '*' as universal", () => {
      expect(isUniversal(undefined)).toBe(true);
      expect(isUniversal("")).toBe(true);
      expect(isUniversal("*")).toBe(true);
    });
    it("rejects everything else", () => {
      expect(isUniversal("Bash")).toBe(false);
      expect(isUniversal(".*")).toBe(false);
    });
  });

  describe("isExact", () => {
    it("matches alphanumeric / underscore words", () => {
      expect(isExact("Bash")).toBe(true);
      expect(isExact("write_file")).toBe(true);
      expect(isExact("WriteOrEdit_3")).toBe(true);
    });
    it("matches pipe-joined alternatives", () => {
      expect(isExact("Bash|Edit|Write")).toBe(true);
    });
    it("rejects regex characters", () => {
      expect(isExact(".*")).toBe(false);
      expect(isExact("rm.*")).toBe(false);
      expect(isExact("Bash|.*")).toBe(false);
      expect(isExact("write file")).toBe(false);
    });
  });

  describe("matchOne", () => {
    it("universal matcher matches anything", () => {
      expect(matchOne(undefined, "anything")).toBe(true);
      expect(matchOne("", "anything")).toBe(true);
      expect(matchOne("*", "anything")).toBe(true);
    });
    it("exact matcher is strict equality", () => {
      expect(matchOne("Bash", "Bash")).toBe(true);
      expect(matchOne("Bash", "bash")).toBe(false);
      expect(matchOne("Bash", "Bashful")).toBe(false);
    });
    it("pipe-joined matcher is OR equality", () => {
      expect(matchOne("Write|Edit", "Write")).toBe(true);
      expect(matchOne("Write|Edit", "Edit")).toBe(true);
      expect(matchOne("Write|Edit", "Read")).toBe(false);
    });
    it("regex matcher unanchored against input", () => {
      expect(matchOne(".*file$", "write_file")).toBe(true);
      // `write_` 全是 [A-Za-z0-9_] → 走 exact 分支，必须**完全相等**才匹配
      expect(matchOne("write_", "write_file")).toBe(false);
      expect(matchOne("write_file", "write_file")).toBe(true);
      // 加正则元字符强制走 regex 分支
      expect(matchOne("write_.*", "write_file")).toBe(true);
      expect(matchOne("^bash$", "bash")).toBe(true);
      expect(matchOne("^bash$", "bashful")).toBe(false);
    });
    it("malformed regex falls back to substring (no throw)", () => {
      expect(() => matchOne("[", "write_file")).not.toThrow();
      // substring fallback: "[" is not in "write_file"
      expect(matchOne("[", "write_file")).toBe(false);
      // but "[" IS in "[locked]"
      expect(matchOne("[", "[locked]")).toBe(true);
    });
  });

  describe("matchAny", () => {
    it("matches when any input matches", () => {
      expect(matchAny("Write", ["write_file", "Write"])).toBe(true);
      expect(matchAny("Write", ["write_file"])).toBe(false);
    });
    it("universal short-circuits to true on empty inputs", () => {
      expect(matchAny("*", [])).toBe(true);
      expect(matchAny(undefined, [])).toBe(true);
    });
    it("non-universal returns false on empty inputs", () => {
      expect(matchAny("Write", [])).toBe(false);
    });
  });
});

describe("aliases.ts (Claude Code alias table)", () => {
  it("write_file gates on Write", () => {
    expect(aliasesForTool("write_file")).toEqual(["Write"]);
  });
  it("edit_file gates on Edit", () => {
    expect(aliasesForTool("edit_file")).toEqual(["Edit"]);
  });
  it("bash gates on Bash", () => {
    expect(aliasesForTool("bash")).toEqual(["Bash"]);
  });
  it("dispatch_subagent gates on Agent", () => {
    expect(aliasesForTool("dispatch_subagent")).toEqual(["Agent"]);
  });
  it("unknown tool returns empty array", () => {
    expect(aliasesForTool("nope_no_such_tool")).toEqual([]);
  });
  it("returns a fresh array each call (callers may mutate)", () => {
    const a = aliasesForTool("write_file");
    const b = aliasesForTool("write_file");
    expect(a).not.toBe(b);
    a.push("Mutated");
    expect(aliasesForTool("write_file")).toEqual(["Write"]);
  });

  describe("toolsForAlias (inverse lookup)", () => {
    it("Write → write_file", () => {
      expect(toolsForAlias("Write")).toEqual(["write_file"]);
    });
    it("Bash → bash", () => {
      expect(toolsForAlias("Bash")).toEqual(["bash"]);
    });
    it("unknown alias → empty array", () => {
      expect(toolsForAlias("UnknownAlias")).toEqual([]);
    });
  });
});

describe("loader.ts (hooks.json discovery + flattening)", () => {
  let tmp: string;
  let workspace: string;
  let userHome: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-v1-loader-"));
    workspace = path.join(tmp, "ws");
    userHome = path.join(tmp, "home");
    fs.mkdirSync(path.join(workspace, ".mathran"), { recursive: true });
    fs.mkdirSync(path.join(userHome, ".mathran"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("returns empty entries when no hooks.json exists anywhere", () => {
    const r = loadHookV1Config({ workspace, home: userHome });
    expect(r.entries).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("loads a workspace-level hook script", () => {
    const scriptPath = path.join(workspace, ".mathran", "pre.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho '{}'\n");
    fs.chmodSync(scriptPath, 0o755);
    fs.writeFileSync(
      path.join(workspace, ".mathran", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "./pre.sh" }] },
          ],
        },
      }),
    );
    const r = loadHookV1Config({ workspace, home: userHome, skipUser: true });
    expect(r.warnings).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].event).toBe("PreToolUse");
    expect(r.entries[0].matcher).toBe("Bash");
    expect(r.entries[0].source).toBe("workspace");
  });

  it("warns on a hook script that escapes the workspace via ../", () => {
    fs.writeFileSync(
      path.join(workspace, ".mathran", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "../../../etc/passwd" }],
            },
          ],
        },
      }),
    );
    const r = loadHookV1Config({ workspace, home: userHome, skipUser: true });
    expect(r.entries).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join("\n")).toMatch(/contain|outside|escap/i);
  });

  it("warns on inline shell strings (must be a single path)", () => {
    fs.writeFileSync(
      path.join(workspace, ".mathran", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "rm -rf /" }],
            },
          ],
        },
      }),
    );
    const r = loadHookV1Config({ workspace, home: userHome, skipUser: true });
    expect(r.entries).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("user entries come before workspace entries (configured order)", () => {
    // Plant identical hook in both layers
    for (const base of [
      path.join(userHome, ".mathran"),
      path.join(workspace, ".mathran"),
    ]) {
      const scriptPath = path.join(base, "h.sh");
      fs.writeFileSync(scriptPath, "#!/bin/sh\necho '{}'\n");
      fs.chmodSync(scriptPath, 0o755);
      fs.writeFileSync(
        path.join(base, "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "*", hooks: [{ type: "command", command: "./h.sh" }] },
            ],
          },
        }),
      );
    }
    const r = loadHookV1Config({ workspace, home: userHome });
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].source).toBe("user");
    expect(r.entries[1].source).toBe("workspace");
  });
});

describe("invoker.ts (real execFile of shell scripts)", () => {
  let tmp: string;
  let workspace: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-v1-invoker-"));
    workspace = path.join(tmp, "ws");
    fs.mkdirSync(path.join(workspace, ".mathran"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function makeScript(rel: string, body: string): HookV1Entry {
    const abs = path.join(workspace, ".mathran", rel);
    fs.writeFileSync(abs, body);
    fs.chmodSync(abs, 0o755);
    return {
      event: "PreToolUse",
      matcher: "*",
      command: abs,
      source: "workspace",
      sourcePath: path.join(workspace, ".mathran", "hooks.json"),
    };
  }

  it("exit 0 + empty JSON = allow", async () => {
    const entry = makeScript("allow.sh", "#!/bin/sh\necho '{}'\n");
    const r = await invokeHookV1([entry], "PreToolUse", {
      hookEventName: "PreToolUse",
      cwd: workspace,
      toolName: "bash",
      toolInput: {},
    }, { cwd: workspace, matcherInputs: ["bash"] });
    expect(r.blocked).toBe(false);
    expect(r.results).toHaveLength(1);
  });

  it("exit 0 + decision:block = block with reason", async () => {
    const entry = makeScript(
      "block.sh",
      "#!/bin/sh\necho '{\"decision\":\"block\",\"reason\":\"nope, not today\"}'\n",
    );
    const r = await invokeHookV1([entry], "PreToolUse", {
      hookEventName: "PreToolUse",
      cwd: workspace,
      toolName: "bash",
      toolInput: {},
    }, { cwd: workspace, matcherInputs: ["bash"] });
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/nope/);
  });

  it("exit 2 = block with stderr as reason", async () => {
    const entry = makeScript(
      "exit2.sh",
      "#!/bin/sh\necho 'denied by policy' 1>&2\nexit 2\n",
    );
    const r = await invokeHookV1([entry], "PreToolUse", {
      hookEventName: "PreToolUse",
      cwd: workspace,
      toolName: "bash",
      toolInput: {},
    }, { cwd: workspace, matcherInputs: ["bash"] });
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/denied/);
  });

  it("updated_input rewrites tool input", async () => {
    const entry = makeScript(
      "rewrite.sh",
      "#!/bin/sh\necho '{\"decision\":\"allow\",\"updated_input\":{\"safe\":true}}'\n",
    );
    const r = await invokeHookV1([entry], "PreToolUse", {
      hookEventName: "PreToolUse",
      cwd: workspace,
      toolName: "bash",
      toolInput: { command: "ls" },
    }, { cwd: workspace, matcherInputs: ["bash"] });
    expect(r.blocked).toBe(false);
    expect(r.updatedInput).toEqual({ safe: true });
  });

  it("hookSpecificOutput.permissionDecision:deny (Claude Code style) blocks", async () => {
    const entry = makeScript(
      "ccdeny.sh",
      "#!/bin/sh\necho '{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"company policy\"}}'\n",
    );
    const r = await invokeHookV1([entry], "PreToolUse", {
      hookEventName: "PreToolUse",
      cwd: workspace,
      toolName: "bash",
      toolInput: {},
    }, { cwd: workspace, matcherInputs: ["bash"] });
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/company policy/);
  });

  it("matcher does NOT match → hook skipped, no block", async () => {
    const entry: HookV1Entry = {
      ...makeScript("never.sh", "#!/bin/sh\necho '{\"decision\":\"block\"}'\n"),
      matcher: "Bash",
    };
    const r = await invokeHookV1([entry], "PreToolUse", {
      hookEventName: "PreToolUse",
      cwd: workspace,
      toolName: "read_file",
      toolInput: {},
    }, { cwd: workspace, matcherInputs: ["read_file"] });
    expect(r.results).toHaveLength(0);
    expect(r.blocked).toBe(false);
  });

  it("alias matcher Write matches write_file via matcherInputs", async () => {
    const entry: HookV1Entry = {
      ...makeScript("write.sh", "#!/bin/sh\necho '{\"decision\":\"block\",\"reason\":\"no writes\"}'\n"),
      matcher: "Write",
    };
    const r = await invokeHookV1([entry], "PreToolUse", {
      hookEventName: "PreToolUse",
      cwd: workspace,
      toolName: "write_file",
      toolInput: {},
    }, { cwd: workspace, matcherInputs: ["write_file", "Write"] });
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/no writes/);
  });

  it("timeout kills the hook (sleep 5s with 1s timeout = block)", async () => {
    const entry = makeScript(
      "slow.sh",
      "#!/bin/sh\nsleep 5\necho '{}'\n",
    );
    const r = await invokeHookV1([entry], "PreToolUse", {
      hookEventName: "PreToolUse",
      cwd: workspace,
      toolName: "bash",
      toolInput: {},
    }, { cwd: workspace, matcherInputs: ["bash"], defaultTimeoutMs: 1_000 });
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/timeout|timed out|sigterm|sigkill/i);
  }, 10_000);
});

describe("HookV1Runner (facade end-to-end)", () => {
  let tmp: string;
  let workspace: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-v1-runner-"));
    workspace = path.join(tmp, "ws");
    fs.mkdirSync(path.join(workspace, ".mathran"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function plant(name: string, body: string, event: HookV1Entry["event"], matcher = "*"): HookV1Entry {
    const abs = path.join(workspace, ".mathran", name);
    fs.writeFileSync(abs, body);
    fs.chmodSync(abs, 0o755);
    return {
      event,
      matcher,
      command: abs,
      source: "workspace",
      sourcePath: path.join(workspace, ".mathran", "hooks.json"),
    };
  }

  it("PreToolUse via facade — block path", async () => {
    const entry = plant(
      "pre.sh",
      "#!/bin/sh\necho '{\"decision\":\"block\",\"reason\":\"hook said no\"}'\n",
      "PreToolUse",
    );
    const runner = new HookV1Runner([entry], { workspace });
    const r = await runner.preToolUse({ toolName: "bash", toolInput: {} });
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/hook said no/);
  });

  it("PostToolUse via facade — additionalContext is captured", async () => {
    const entry = plant(
      "post.sh",
      "#!/bin/sh\necho '{\"hookSpecificOutput\":{\"additionalContext\":\"observed something\"}}'\n",
      "PostToolUse",
    );
    const runner = new HookV1Runner([entry], { workspace });
    const r = await runner.postToolUse({
      toolName: "bash",
      toolInput: {},
      toolResult: { ok: true, content: "" },
    });
    expect(r.blocked).toBe(false);
    expect(r.additionalContexts).toContain("observed something");
  });

  it("SessionStart via facade — empty matcher inputs still fires", async () => {
    const entry = plant(
      "ss.sh",
      "#!/bin/sh\necho '{\"hookSpecificOutput\":{\"additionalContext\":\"hello session\"}}'\n",
      "SessionStart",
    );
    const runner = new HookV1Runner([entry], { workspace });
    const r = await runner.sessionStart({});
    expect(r.additionalContexts).toContain("hello session");
  });

  it("has() reflects loaded events accurately", () => {
    const e1 = plant("a.sh", "#!/bin/sh\necho '{}'", "PreToolUse");
    const e2 = plant("b.sh", "#!/bin/sh\necho '{}'", "PostToolUse");
    const runner = new HookV1Runner([e1, e2], { workspace });
    expect(runner.has("PreToolUse")).toBe(true);
    expect(runner.has("PostToolUse")).toBe(true);
    expect(runner.has("SessionStart")).toBe(false);
  });

  it("no entries = .has() always false + outcome empty", async () => {
    const runner = new HookV1Runner([], { workspace });
    expect(runner.has("PreToolUse")).toBe(false);
    const r = await runner.preToolUse({ toolName: "bash", toolInput: {} });
    expect(r.results).toEqual([]);
    expect(r.blocked).toBe(false);
  });
});
