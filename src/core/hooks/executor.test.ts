import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  executeHooks,
  HookInvoker,
  formatHookResult,
  DEFAULT_HOOK_TIMEOUT_MS,
} from "./executor.js";
import type { LoadedHook } from "./loader.js";
import { ApprovalBroker } from "../chat/approval-broker.js";
import type { HookExecutionContext } from "./context.js";

let tmp: string;
let ws: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-exec-"));
  ws = path.join(tmp, "ws");
  fs.mkdirSync(ws, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeHook(name: string, body: string): LoadedHook {
  const dir = path.join(ws, ".mathran", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  // derive type from prefix quickly for tests
  const base = name.replace(/\.(sh|bash|js|py)$/, "");
  const type = base.startsWith("pre-edit")
    ? "pre-edit"
    : base.startsWith("post-edit")
      ? "post-edit"
      : base.startsWith("pre-bash")
        ? "pre-bash"
        : base.startsWith("pre-commit")
          ? "pre-commit"
          : base.startsWith("post-tool")
            ? "post-tool"
            : base.startsWith("on-goal-complete")
              ? "on-goal-complete"
              : base.startsWith("pre-chat")
                ? "pre-chat"
                : "unknown";
  return { name: base, type: type as LoadedHook["type"], layer: "workspace", path: p, allowed: false };
}

const baseCtx = (): HookExecutionContext => ({ hookType: "post-edit", workspace: ws });

describe("executeHooks", () => {
  it("runs a hook, captures stdout, exit 0", async () => {
    const h = writeHook("post-edit.sh", "#!/bin/bash\necho hello\nexit 0\n");
    const [r] = await executeHooks([h], baseCtx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.blocked).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it("injects MATHRAN_* env vars", async () => {
    const h = writeHook("post-edit.sh", "#!/bin/bash\necho \"f=$MATHRAN_FILE_PATH t=$MATHRAN_HOOK_TYPE\"\n");
    const [r] = await executeHooks([h], { ...baseCtx(), filePath: "/ws/foo.ts" });
    expect(r.stdout).toContain("f=/ws/foo.ts");
    expect(r.stdout).toContain("t=post-edit");
  });

  it("does NOT leak parent secrets into the hook env", async () => {
    const h = writeHook("post-edit.sh", "#!/bin/bash\necho \"key=$SECRET_KEY\"\n");
    const [r] = await executeHooks([h], baseCtx(), {
      parentEnv: { PATH: process.env.PATH ?? "", SECRET_KEY: "leak" },
    });
    expect(r.stdout).toContain("key=");
    expect(r.stdout).not.toContain("leak");
  });

  it("blocks on a failing pre-* hook", async () => {
    const h = writeHook("pre-edit.sh", "#!/bin/bash\nexit 1\n");
    const [r] = await executeHooks([h], { ...baseCtx(), hookType: "pre-edit" });
    expect(r.exitCode).toBe(1);
    expect(r.blocked).toBe(true);
  });

  it("does NOT block on a failing post-* hook", async () => {
    const h = writeHook("post-edit.sh", "#!/bin/bash\nexit 1\n");
    const [r] = await executeHooks([h], baseCtx());
    expect(r.exitCode).toBe(1);
    expect(r.blocked).toBe(false);
  });

  it("times out a slow hook and blocks (pre-*)", async () => {
    const h = writeHook("pre-edit.sh", "#!/bin/bash\nsleep 5\n");
    const [r] = await executeHooks([h], { ...baseCtx(), hookType: "pre-edit" }, { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it("caps output at 100KB and marks truncated", async () => {
    const h = writeHook(
      "post-edit.sh",
      "#!/bin/bash\nhead -c 200000 /dev/zero | tr '\\0' 'a'\n",
    );
    const [r] = await executeHooks([h], baseCtx());
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(100 * 1024);
  });

  it("dispatches a node (.js) hook", async () => {
    const h = writeHook("post-edit.js", "console.log('from-node-' + process.env.MATHRAN_HOOK_TYPE)\n");
    const [r] = await executeHooks([h], baseCtx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("from-node-post-edit");
  });

  it("vetoes a hook whose contents hit the denylist", async () => {
    const h = writeHook("pre-bash.sh", "#!/bin/bash\nrm -rf /\n");
    const [r] = await executeHooks([h], { ...baseCtx(), hookType: "pre-bash" }, {
      denylist: ["bash:rm -rf *"],
    });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain("denylist");
    expect(r.blocked).toBe(true); // pre-* → blocks
  });

  it("denies via approval broker (no resolver, on-request)", async () => {
    const h = writeHook("pre-bash.sh", "#!/bin/bash\necho hi\n");
    const broker = new ApprovalBroker({ policy: "on-request", workspace: ws });
    const [r] = await executeHooks([h], { ...baseCtx(), hookType: "pre-bash" }, {
      approvalBroker: broker,
    });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain("approval");
    expect(r.blocked).toBe(true);
  });

  it("allows when policy is never", async () => {
    const h = writeHook("pre-bash.sh", "#!/bin/bash\necho ran\n");
    const broker = new ApprovalBroker({ policy: "never", workspace: ws });
    const [r] = await executeHooks([h], { ...baseCtx(), hookType: "pre-bash" }, {
      approvalBroker: broker,
    });
    expect(r.skipped).toBeUndefined();
    expect(r.stdout.trim()).toBe("ran");
  });

  it("runs multiple hooks serially in order", async () => {
    const a = writeHook("post-edit-a.sh", "#!/bin/bash\necho A\n");
    const b = writeHook("post-edit-b.sh", "#!/bin/bash\necho B\n");
    const results = await executeHooks([a, b], baseCtx());
    expect(results.map((r) => r.stdout.trim())).toEqual(["A", "B"]);
  });
});

describe("HookInvoker", () => {
  function inv(hooks: LoadedHook[], settings = {}, extra = {}) {
    return new HookInvoker({ hooks, workspace: ws, settings, ...extra });
  }

  it("returns not-blocked when disabled", async () => {
    const h = writeHook("pre-edit.sh", "#!/bin/bash\nexit 1\n");
    const out = await inv([h], { enabled: false }).run("pre-edit", { filePath: "/ws/x" });
    expect(out.blocked).toBe(false);
    expect(out.ran).toEqual([]);
  });

  it("blocks on failing pre-edit and records history", async () => {
    const h = writeHook("pre-edit.sh", "#!/bin/bash\necho nope >&2\nexit 2\n");
    const invoker = inv([h]);
    const out = await invoker.run("pre-edit", { filePath: "/ws/x" });
    expect(out.blocked).toBe(true);
    expect(out.blockedReason).toContain("pre-edit");
    expect(invoker.history.countToday("pre-edit")).toBe(1);
    expect(out.summary).toContain("exit=2");
  });

  it("runs post-edit and returns a summary without blocking", async () => {
    const h = writeHook("post-edit.sh", "#!/bin/bash\necho formatted\n");
    const out = await inv([h]).run("post-edit", { filePath: "/ws/x" });
    expect(out.blocked).toBe(false);
    expect(out.summary).toContain("formatted");
  });

  it("applies the allowed whitelist (strict when configured)", async () => {
    const a = writeHook("pre-bash-a.sh", "#!/bin/bash\nexit 1\n");
    a.allowed = false;
    const out = await inv([a], { allowed: ["pre-bash-b"] }).run("pre-bash", {
      bashCommand: "ls",
    });
    // a not in whitelist → not run → not blocked
    expect(out.ran).toEqual([]);
    expect(out.blocked).toBe(false);
  });

  it("runs all hooks when no whitelist configured (fail-open)", async () => {
    const a = writeHook("pre-bash-a.sh", "#!/bin/bash\necho A\n");
    const out = await inv([a]).run("pre-bash", { bashCommand: "ls" });
    expect(out.ran.length).toBe(1);
  });

  it("honors a one-shot bypass then resumes", async () => {
    const h = writeHook("pre-bash.sh", "#!/bin/bash\nexit 1\n");
    const invoker = inv([h]);
    invoker.bypassNext("pre-bash");
    const first = await invoker.run("pre-bash", { bashCommand: "ls" });
    expect(first.blocked).toBe(false);
    expect(first.ran).toEqual([]);
    const second = await invoker.run("pre-bash", { bashCommand: "ls" });
    expect(second.blocked).toBe(true);
  });

  it("honors settings.bypassPrefix on the operation subject", async () => {
    const h = writeHook("pre-bash.sh", "#!/bin/bash\nexit 1\n");
    const out = await inv([h], { bypassPrefix: ["git status"] }).run("pre-bash", {
      bashCommand: "git status",
    });
    expect(out.blocked).toBe(false);
    expect(out.ran).toEqual([]);
  });

  it("async mode fires post-* hooks without blocking", async () => {
    const h = writeHook("post-edit.sh", "#!/bin/bash\necho async\n");
    const invoker = inv([h], { async: true });
    const out = await invoker.run("post-edit", { filePath: "/ws/x" });
    expect(out.ran).toEqual([]);
    expect(out.blocked).toBe(false);
    // give the background run a moment, then check history.
    await new Promise((r) => setTimeout(r, 300));
    expect(invoker.history.countToday("post-edit")).toBe(1);
  });

  it("hooksForType filters by type + whitelist", () => {
    const a = writeHook("pre-edit.sh", "x");
    const b = writeHook("post-edit.sh", "x");
    const invoker = inv([a, b]);
    expect(invoker.hooksForType("pre-edit").map((h) => h.name)).toEqual(["pre-edit"]);
  });

  it("settingsSnapshot defaults timeout", () => {
    expect(inv([]).settingsSnapshot.timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
  });
});

describe("formatHookResult", () => {
  it("renders the [hook: …] block", () => {
    const h = writeHook("post-edit.sh", "x");
    const s = formatHookResult({
      hook: h,
      exitCode: 0,
      stdout: "line1\nline2",
      stderr: "",
      durationMs: 1200,
      timedOut: false,
      blocked: false,
      truncated: false,
    });
    expect(s).toContain("[hook: post-edit");
    expect(s).toContain("exit=0 in 1.2s");
    expect(s).toContain("stdout (2 lines):");
    expect(s).toContain("  line1");
  });
});
