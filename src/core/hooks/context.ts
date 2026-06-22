/**
 * Hook execution context + sandbox environment helpers.
 *
 * A {@link HookExecutionContext} carries everything a hook script needs to know
 * about *why* it is running. {@link buildHookEnv} turns that context into a
 * deliberately small, MATHRAN-prefixed environment that does NOT inherit the
 * parent process env wholesale — only a handful of standard variables (PATH,
 * HOME, USER, LANG, TZ) are forwarded so a hook can still find `node`,
 * `prettier`, etc., without leaking provider keys or other secrets from
 * `process.env`.
 *
 * {@link interpreterFor} picks the interpreter from the hook file extension:
 * `.js` → node, `.py` → python3, everything else (incl. `.sh`, `.bash`, and
 * extensionless files) → `/bin/bash`.
 */

import * as path from "node:path";
import type { HookType } from "./loader.js";

export interface HookExecutionContext {
  hookType: HookType;
  workspace: string;
  projectSlug?: string;

  /** pre-edit / post-edit — the file being written/edited. */
  filePath?: string;
  /** pre-bash / pre-commit — the shell command about to run. */
  bashCommand?: string;
  /** post-tool — the tool that just ran. */
  toolName?: string;
  /** on-goal-complete — the completed goal's text. */
  goalText?: string;
}

/**
 * Parent-env variables forwarded into the (otherwise clean) hook environment.
 * Everything else in `process.env` (API keys, tokens, …) is dropped.
 */
export const FORWARDED_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "TZ"] as const;

/**
 * Build the sandboxed environment for a hook process. Returns a fresh object
 * (never mutates `parentEnv`). Standard keys are forwarded; everything mathran
 * exposes is `MATHRAN_*`-prefixed and only set when present in `ctx`.
 */
export function buildHookEnv(
  ctx: HookExecutionContext,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    const v = parentEnv[key];
    if (typeof v === "string") env[key] = v;
  }
  env.MATHRAN_HOOK_TYPE = ctx.hookType;
  env.MATHRAN_WORKSPACE = ctx.workspace;
  if (ctx.projectSlug) env.MATHRAN_PROJECT_SLUG = ctx.projectSlug;
  if (ctx.filePath) env.MATHRAN_FILE_PATH = ctx.filePath;
  if (ctx.bashCommand) env.MATHRAN_BASH_COMMAND = ctx.bashCommand;
  if (ctx.toolName) env.MATHRAN_TOOL_NAME = ctx.toolName;
  if (ctx.goalText) env.MATHRAN_GOAL_TEXT = ctx.goalText;
  return env;
}

export interface HookInterpreter {
  /** Executable to spawn. */
  command: string;
  /** Leading args before the hook path (e.g. `["-c"]` is NOT used here). */
  args: string[];
}

/**
 * Pick the interpreter for a hook file by extension. The hook path itself is
 * appended by the caller, so e.g. a `.py` hook is spawned as
 * `python3 <path>` and a bash hook as `/bin/bash <path>`.
 */
export function interpreterFor(hookPath: string): HookInterpreter {
  const ext = path.extname(hookPath).toLowerCase();
  switch (ext) {
    case ".js":
      return { command: "node", args: [] };
    case ".py":
      return { command: "python3", args: [] };
    case ".sh":
    case ".bash":
    case "":
    default:
      return { command: "/bin/bash", args: [] };
  }
}

/**
 * Resolve the working directory for a hook. Project hooks run in
 * `<workspace>/projects/<slug>`; everything else runs at the workspace root.
 */
export function hookCwd(ctx: HookExecutionContext): string {
  if (ctx.projectSlug) {
    return path.join(ctx.workspace, "projects", ctx.projectSlug);
  }
  return ctx.workspace;
}
