/**
 * Built-in git chat tools (Part B2).
 *
 * 5 tools wrapping common git read/inspect commands plus a guarded commit:
 *   - git_status  — `git status --short` → JSON
 *   - git_diff    — `git diff [--staged] [path] [range]`
 *   - git_log     — `git log -n N [--oneline] [--since=…]`
 *   - git_branch  — `git branch -a` / `--show-current`
 *   - git_commit  — `git commit -m <msg> [--allow-empty]` (riskClass: write,
 *                   gated by builder-time `allowCommit`)
 *
 * Safety contract
 * ---------------
 * All shell-out goes through `execFile("git", [...args])`, NOT `exec` or
 * `bash -c`. That gives us shell-injection safety FOR FREE:
 *   - `;`, backtick, `$()`, `&&`, `|` etc. land in argv as literal bytes
 *   - git treats them as filenames / commit messages, never shell tokens
 *
 * cwd is the workspace root (builder-time `workspace` or `ctx.workspace`,
 * falling back to `process.cwd()`). We do NOT support arbitrary cwd: the
 * tool is workspace-scoped on purpose.
 *
 * `git_commit` is wired behind `allowCommit` (default false). When the
 * flag is off, the tool is simply not registered, so the model cannot
 * commit even with approval. When on, it carries `riskClass: "write"`
 * so the existing approval broker still gates it.
 *
 * Intentional non-features:
 *   - No `git push` / `git pull` / `git rebase` / branch creation /
 *     stash / cherry-pick. The chat surface stays inspect-heavy with
 *     just one writable verb (commit). Anything else can still go
 *     through the bash tool (with its own approval).
 *   - No `--no-verify` flag plumbed: commit hooks must run.
 *   - Output is byte-capped at 64 KiB per tool to keep the model's
 *     context budget sane on large repos.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolSpec, ToolExecuteContext } from "../session.js";

const execFileP = promisify(execFile);

export interface GitToolsOptions {
  /** Workspace root used as cwd. Falls back to ctx.workspace then process.cwd(). */
  workspace?: string;
  /** When true, register `git_commit`. Default false. */
  allowCommit?: boolean;
  /** Per-call timeout in ms. Default 15s. */
  timeoutMs?: number;
  /** Max stdout/stderr bytes captured. Default 64 KiB. */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

/** Resolve cwd from options + tool ctx + cwd, in that order. */
function resolveCwd(
  opts: GitToolsOptions,
  ctx: ToolExecuteContext | undefined,
): string {
  return opts.workspace ?? ctx?.workspace ?? process.cwd();
}

/**
 * Run `git ARGS` with a strict timeout + output cap. Returns the trimmed
 * stdout on success; otherwise an `ok: false` envelope with stderr.
 *
 * Exported so tests can intercept the exec path via vi.spyOn / mocks
 * without having to spin up a real repo. The promisified `execFile` is
 * captured at module load; tests that mock `node:child_process` work
 * because `import` resolves the mocked symbol BEFORE this module captures
 * `execFile` (Vitest's auto-mock pattern).
 */
async function runGit(
  args: string[],
  cwd: string,
  opts: GitToolsOptions,
): Promise<{ ok: boolean; content: string }> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      timeout,
      maxBuffer,
      // Force English output so parsers (e.g. status --short) are stable
      // across locales. Inherits PATH/HOME so user git config still applies.
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    return { ok: true, content: stdout };
  } catch (err: any) {
    const stderr = typeof err?.stderr === "string" ? err.stderr : "";
    const stdout = typeof err?.stdout === "string" ? err.stdout : "";
    const msg = stderr || err?.message || String(err);
    const body = stdout ? `${msg}\n--- stdout ---\n${stdout}` : msg;
    return { ok: false, content: `git ${args.join(" ")} failed: ${body}` };
  }
}

/* ───────────────────────── git_status ───────────────────────── */

export function createGitStatusTool(opts: GitToolsOptions = {}): ToolSpec {
  return {
    name: "git_status",
    riskClass: "read",
    readOnly: true,
    description:
      "Run `git status --short` in the workspace root and return the porcelain " +
      "output as a JSON array of `{ status, path }` objects. `status` is the " +
      "2-char porcelain code (e.g. ' M', '??', 'A ', 'MM'); `path` is the " +
      "repo-relative file path. Empty array means a clean tree.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const cwd = resolveCwd(opts, ctx);
      const result = await runGit(["status", "--short"], cwd, opts);
      if (!result.ok) return result;
      const entries: Array<{ status: string; path: string }> = [];
      for (const line of result.content.split("\n")) {
        if (!line) continue;
        // porcelain --short layout: XY <space> PATH
        // X = index status, Y = worktree status. Take cols 0..1 as status.
        const status = line.slice(0, 2);
        // Path starts after the space at col 2; rename arrow ` -> ` may appear.
        const path = line.slice(3);
        entries.push({ status, path });
      }
      return { ok: true, content: JSON.stringify(entries) };
    },
  };
}

/* ───────────────────────── git_diff ───────────────────────── */

export function createGitDiffTool(opts: GitToolsOptions = {}): ToolSpec {
  return {
    name: "git_diff",
    riskClass: "read",
    readOnly: true,
    description:
      "Run `git diff [--staged] [path] [range]` in the workspace root. " +
      "By default shows unstaged worktree changes. Pass `staged: true` for " +
      "the index. Pass `path` to limit to a single file (relative or absolute). " +
      "Pass `range` for arbitrary git revision selectors (e.g. 'HEAD~3..HEAD', " +
      "'main...feat/x'). Output is capped; for huge diffs slice with `path`.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Limit diff to a single path." },
        staged: { type: "boolean", description: "Diff the index instead of worktree." },
        range: { type: "string", description: "Arbitrary git revision range." },
      },
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const cwd = resolveCwd(opts, ctx);
      const argv: string[] = ["diff"];
      if (args.staged === true) argv.push("--staged");
      if (typeof args.range === "string" && args.range.trim().length > 0) {
        argv.push(args.range.trim());
      }
      if (typeof args.path === "string" && args.path.trim().length > 0) {
        argv.push("--", args.path.trim());
      }
      return runGit(argv, cwd, opts);
    },
  };
}

/* ───────────────────────── git_log ───────────────────────── */

export function createGitLogTool(opts: GitToolsOptions = {}): ToolSpec {
  return {
    name: "git_log",
    riskClass: "read",
    readOnly: true,
    description:
      "Run `git log -n N [--oneline] [--since=…]` in the workspace root. " +
      "Defaults: oneline=true, limit=20. Pass `since` for time filters " +
      "(e.g. '1.week.ago', '2026-06-01'). Limit is capped at 500 to keep " +
      "output bounded.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max commits returned (default 20, max 500)." },
        oneline: { type: "boolean", description: "Use --oneline format (default true)." },
        since: { type: "string", description: "Time filter passed to --since." },
      },
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const cwd = resolveCwd(opts, ctx);
      let limit = 20;
      if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
        limit = Math.max(1, Math.min(500, Math.floor(args.limit)));
      }
      const oneline = args.oneline !== false; // default true
      const argv: string[] = ["log", "-n", String(limit)];
      if (oneline) argv.push("--oneline");
      if (typeof args.since === "string" && args.since.trim().length > 0) {
        // execFile keeps this as a single argv entry, so an injected
        // `--since=$(rm -rf /)` becomes a literal --since string git fails
        // to parse, never a shell expansion.
        argv.push(`--since=${args.since.trim()}`);
      }
      return runGit(argv, cwd, opts);
    },
  };
}

/* ───────────────────────── git_branch ───────────────────────── */

export function createGitBranchTool(opts: GitToolsOptions = {}): ToolSpec {
  return {
    name: "git_branch",
    riskClass: "read",
    readOnly: true,
    description:
      "Inspect git branches in the workspace root. With no args (or " +
      "`list: true`) runs `git branch -a`. With `show: true` runs " +
      "`git branch --show-current`. The two flags are mutually exclusive; " +
      "`show` wins if both are set.",
    parameters: {
      type: "object",
      properties: {
        list: { type: "boolean", description: "List local + remote branches (default)." },
        show: { type: "boolean", description: "Print only the current branch name." },
      },
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const cwd = resolveCwd(opts, ctx);
      const argv: string[] =
        args.show === true ? ["branch", "--show-current"] : ["branch", "-a"];
      return runGit(argv, cwd, opts);
    },
  };
}

/* ───────────────────────── git_commit ───────────────────────── */

export function createGitCommitTool(opts: GitToolsOptions = {}): ToolSpec {
  return {
    name: "git_commit",
    riskClass: "write",
    readOnly: false,
    description:
      "Run `git commit -m <message> [--allow-empty]` in the workspace root. " +
      "Commits the currently staged index — does NOT stage files (use bash " +
      "for that). Hooks run normally. `--no-verify` is intentionally NOT " +
      "supported. This tool is gated by the host's allowCommit flag and the " +
      "approval broker (riskClass: write).",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message body." },
        allowEmpty: { type: "boolean", description: "Pass --allow-empty." },
      },
      required: ["message"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const cwd = resolveCwd(opts, ctx);
      const message =
        typeof args.message === "string" ? args.message : "";
      if (!message || message.trim().length === 0) {
        return { ok: false, content: "error: git_commit requires non-empty 'message'" };
      }
      const argv: string[] = ["commit", "-m", message];
      if (args.allowEmpty === true) argv.push("--allow-empty");
      return runGit(argv, cwd, opts);
    },
  };
}

/**
 * Build the full git-tools tool list per builder options.
 *
 * Returns 4 tools by default (`git_status`, `git_diff`, `git_log`,
 * `git_branch`); appends `git_commit` only when `allowCommit: true`.
 * This is what `ChatSession.buildBuiltinTools` calls.
 */
export function createGitTools(opts: GitToolsOptions = {}): ToolSpec[] {
  const tools: ToolSpec[] = [
    createGitStatusTool(opts),
    createGitDiffTool(opts),
    createGitLogTool(opts),
    createGitBranchTool(opts),
  ];
  if (opts.allowCommit) tools.push(createGitCommitTool(opts));
  return tools;
}
