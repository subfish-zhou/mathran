/**
 * Part B2 commit 6 — git-tools tests.
 *
 * Strategy: mock `node:child_process.execFile` so we can assert on the
 * exact argv git is invoked with, without spinning up a real repo. This
 * verifies:
 *   - command construction is correct (`git status --short`,
 *     `git diff --staged`, `git log -n N`, `git branch -a`, etc.)
 *   - injection payloads (`;`, backtick, `$()`, `&&`) land in argv as
 *     LITERAL bytes (the whole point of execFile), so they're never
 *     interpreted by a shell.
 *   - allowCommit gates whether git_commit is registered at all.
 *   - empty / missing required args are rejected client-side.
 *
 * We don't try to fake git's stdout/stderr semantics here — that's a
 * separate integration test. The unit-level contract under test is:
 *   "given args X, did we call execFile('git', [...expectedArgv], ...)?"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock BEFORE importing git-tools so its `import { execFile } from "node:child_process"`
// resolves to the mock. Vitest hoists vi.mock() calls automatically.
const execFileMock = vi.fn();
// stdoutQueue lets a test prime the next call's stdout payload.
const stdoutQueue: string[] = [];
vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], opts: any, cb: any) => {
    execFileMock(cmd, args, opts);
    const stdout = stdoutQueue.length > 0 ? stdoutQueue.shift()! : "";
    // Promisified execFile invokes cb(err, { stdout, stderr }).
    cb(null, { stdout, stderr: "" });
  },
}));

// Import AFTER the mock so promisify(execFile) captures the mocked symbol.
import {
  createGitBranchTool,
  createGitCommitTool,
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool,
  createGitTools,
} from "./git-tools.js";

beforeEach(() => {
  execFileMock.mockClear();
  stdoutQueue.length = 0;
});

describe("git-tools — argv construction", () => {
  it("git_status runs `git status --short` in the workspace cwd", async () => {
    const tool = createGitStatusTool({ workspace: "/tmp/repo" });
    await tool.execute({});
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe("git");
    expect(argv).toEqual(["status", "--short"]);
    expect(opts.cwd).toBe("/tmp/repo");
  });

  it("git_diff with no args runs `git diff`", async () => {
    const tool = createGitDiffTool({ workspace: "/r" });
    await tool.execute({});
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["diff"]);
  });

  it("git_diff with staged=true runs `git diff --staged`", async () => {
    const tool = createGitDiffTool({ workspace: "/r" });
    await tool.execute({ staged: true });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["diff", "--staged"]);
  });

  it("git_diff with path adds `-- <path>` separator", async () => {
    const tool = createGitDiffTool({ workspace: "/r" });
    await tool.execute({ path: "src/foo.ts" });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["diff", "--", "src/foo.ts"]);
  });

  it("git_diff with range + path includes range before --", async () => {
    const tool = createGitDiffTool({ workspace: "/r" });
    await tool.execute({ range: "HEAD~3..HEAD", path: "src/bar.ts" });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["diff", "HEAD~3..HEAD", "--", "src/bar.ts"]);
  });

  it("git_log defaults to `git log -n 20 --oneline`", async () => {
    const tool = createGitLogTool({ workspace: "/r" });
    await tool.execute({});
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["log", "-n", "20", "--oneline"]);
  });

  it("git_log respects limit + since", async () => {
    const tool = createGitLogTool({ workspace: "/r" });
    await tool.execute({ limit: 5, since: "1.week.ago" });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["log", "-n", "5", "--oneline", "--since=1.week.ago"]);
  });

  it("git_log caps limit at 500", async () => {
    const tool = createGitLogTool({ workspace: "/r" });
    await tool.execute({ limit: 99999 });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["log", "-n", "500", "--oneline"]);
  });

  it("git_log with oneline=false omits --oneline", async () => {
    const tool = createGitLogTool({ workspace: "/r" });
    await tool.execute({ oneline: false });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["log", "-n", "20"]);
  });

  it("git_branch defaults to `git branch -a`", async () => {
    const tool = createGitBranchTool({ workspace: "/r" });
    await tool.execute({});
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["branch", "-a"]);
  });

  it("git_branch with show=true uses --show-current", async () => {
    const tool = createGitBranchTool({ workspace: "/r" });
    await tool.execute({ show: true });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["branch", "--show-current"]);
  });

  it("git_commit runs `git commit -m <msg>`", async () => {
    const tool = createGitCommitTool({ workspace: "/r" });
    await tool.execute({ message: "fix: boom" });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["commit", "-m", "fix: boom"]);
  });

  it("git_commit with allowEmpty=true appends --allow-empty", async () => {
    const tool = createGitCommitTool({ workspace: "/r" });
    await tool.execute({ message: "trigger ci", allowEmpty: true });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["commit", "-m", "trigger ci", "--allow-empty"]);
  });
});

describe("git-tools — argv safety (shell injection)", () => {
  it("git_diff path containing ';rm -rf /' lands as a LITERAL argv entry", async () => {
    const tool = createGitDiffTool({ workspace: "/r" });
    await tool.execute({ path: "innocent.ts; rm -rf /" });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["diff", "--", "innocent.ts; rm -rf /"]);
    // The shell-meta payload IS in argv but as a single string entry —
    // execFile passes it directly to git's argv[] without shell parsing.
    // Anything dangerous would have required shell:true or exec(string).
  });

  it("git_diff range with backtick / $() / && is LITERAL", async () => {
    const tool = createGitDiffTool({ workspace: "/r" });
    const evil = "HEAD~1..HEAD`whoami` $(echo pwn) && id";
    await tool.execute({ range: evil });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["diff", evil]);
    // git will refuse to parse this as a revision range and fail — but
    // critically, no subshell will run. That's the safety contract.
  });

  it("git_log since containing $() is LITERAL", async () => {
    const tool = createGitLogTool({ workspace: "/r" });
    await tool.execute({ since: "$(rm -rf ~)" });
    const [, argv] = execFileMock.mock.calls[0];
    // The argv contains the literal --since=$(rm -rf ~) — git will reject
    // it as an invalid date, NOT execute a subshell.
    expect(argv).toEqual(["log", "-n", "20", "--oneline", "--since=$(rm -rf ~)"]);
  });

  it("git_commit message with newlines + shell-meta is LITERAL", async () => {
    const tool = createGitCommitTool({ workspace: "/r" });
    const msg = 'multi\nline\nsubject\n\nbody with `cmd` and $(other) && pipe |';
    await tool.execute({ message: msg });
    const [, argv] = execFileMock.mock.calls[0];
    expect(argv).toEqual(["commit", "-m", msg]);
  });

  it("the spawn function is NEVER called with shell:true", async () => {
    const tool = createGitStatusTool({ workspace: "/r" });
    await tool.execute({});
    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.shell).toBeUndefined();
  });
});

describe("git-tools — input validation", () => {
  it("git_commit rejects missing message with ok: false", async () => {
    const tool = createGitCommitTool({ workspace: "/r" });
    const r = await tool.execute({});
    expect(r.ok).toBe(false);
    expect(r.content).toContain("non-empty 'message'");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("git_commit rejects empty / whitespace-only message", async () => {
    const tool = createGitCommitTool({ workspace: "/r" });
    const r1 = await tool.execute({ message: "" });
    expect(r1.ok).toBe(false);
    const r2 = await tool.execute({ message: "   \n\t  " });
    expect(r2.ok).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("git_log limit floor is 1 (rejects 0 / negative)", async () => {
    const tool = createGitLogTool({ workspace: "/r" });
    await tool.execute({ limit: 0 });
    const [, argv0] = execFileMock.mock.calls[0];
    expect(argv0).toEqual(["log", "-n", "1", "--oneline"]);
    execFileMock.mockClear();
    await tool.execute({ limit: -5 });
    const [, argvNeg] = execFileMock.mock.calls[0];
    expect(argvNeg).toEqual(["log", "-n", "1", "--oneline"]);
  });
});

describe("git-tools — allowCommit gating + tool list assembly", () => {
  it("createGitTools() returns 4 tools when allowCommit is false (default)", () => {
    const tools = createGitTools({ workspace: "/r" });
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["git_status", "git_diff", "git_log", "git_branch"]);
    expect(names).not.toContain("git_commit");
  });

  it("createGitTools({ allowCommit: true }) returns 5 tools including git_commit", () => {
    const tools = createGitTools({ workspace: "/r", allowCommit: true });
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("git_commit");
  });

  it("all read tools are readOnly: true; commit is readOnly: false", () => {
    const tools = createGitTools({ workspace: "/r", allowCommit: true });
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("git_status")?.readOnly).toBe(true);
    expect(byName.get("git_diff")?.readOnly).toBe(true);
    expect(byName.get("git_log")?.readOnly).toBe(true);
    expect(byName.get("git_branch")?.readOnly).toBe(true);
    expect(byName.get("git_commit")?.readOnly).toBe(false);
  });

  it("commit tool carries riskClass 'write'; reads carry 'read'", () => {
    const tools = createGitTools({ workspace: "/r", allowCommit: true });
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("git_status")?.riskClass).toBe("read");
    expect(byName.get("git_commit")?.riskClass).toBe("write");
  });
});

describe("git-tools — output parsing", () => {
  it("git_status: empty porcelain stdout → JSON empty array", async () => {
    const tool = createGitStatusTool({ workspace: "/r" });
    const r = await tool.execute({});
    expect(r.ok).toBe(true);
    expect(r.content).toBe("[]");
  });

  it("git_status: porcelain stdout → JSON [{status,path}] entries", async () => {
    stdoutQueue.push(
      " M src/foo.ts\n?? bar.txt\nA  baz.ts\nMM src/multi.ts\n",
    );
    const tool = createGitStatusTool({ workspace: "/r" });
    const r = await tool.execute({});
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed).toEqual([
      { status: " M", path: "src/foo.ts" },
      { status: "??", path: "bar.txt" },
      { status: "A ", path: "baz.ts" },
      { status: "MM", path: "src/multi.ts" },
    ]);
  });

  it("opts include LC_ALL=C / LANG=C for stable porcelain output", async () => {
    const tool = createGitStatusTool({ workspace: "/r" });
    await tool.execute({});
    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.env.LC_ALL).toBe("C");
    expect(opts.env.LANG).toBe("C");
  });
});
