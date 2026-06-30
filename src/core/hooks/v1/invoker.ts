/**
 * Hooks v1 invoker — runs one or more matched hooks for a given event.
 *
 * Pipeline per hook:
 *
 *   1. Pick interpreter from the script extension (`.js` → node, `.py` →
 *      python3, anything else → `/bin/bash`).
 *   2. Spawn it with `execFile(interp, [...interp.args, scriptPath])` — argv
 *      array, never a shell string, so there is no command-injection surface.
 *   3. Write the JSON stdin payload, close stdin.
 *   4. Cap stdout/stderr (each) at 100 KB to avoid an unbounded hook.
 *   5. Timeout after `timeoutSec` (default 30 s) → SIGTERM then SIGKILL.
 *   6. Parse stdout JSON when present; map exit codes:
 *
 *        exit 0    → allow (stdout JSON may rewrite/inject context)
 *        exit 2    → block (stderr text becomes block reason)
 *        non-zero  → block ("hook exited with code N")
 *        timeout   → block ("hook timed out after Ns")
 *        spawn err → block (caller chooses how to react)
 *
 *      A `decision: "block"` in stdout JSON also blocks (per Claude Code
 *      contract).
 *
 * Aggregate result rules:
 *
 *   - `blocked = any hook blocked` (first block reason wins)
 *   - `updatedInput = last non-empty updated_input from a non-blocking hook`
 *   - `additionalContexts = every non-empty additionalContext, in order`
 *
 * The invoker never throws — every failure mode (incl. ENOENT on the script)
 * becomes a `blocked: true` HookV1RunResult so the call site can short-circuit
 * cleanly.
 */

import { execFile, type ChildProcess } from "node:child_process";
import * as path from "node:path";

import { matchAny } from "./matcher.js";
import {
  EMPTY_OUTCOME,
  type HookV1Entry,
  type HookV1Event,
  type HookV1Input,
  type HookV1Outcome,
  type HookV1Output,
  type HookV1RunResult,
} from "./schema.js";

export const DEFAULT_HOOK_V1_TIMEOUT_MS = 30_000;
export const HOOK_V1_OUTPUT_CAP_BYTES = 100 * 1024;

interface Interpreter {
  command: string;
  args: string[];
}
function interpreterFor(scriptPath: string): Interpreter {
  const ext = path.extname(scriptPath).toLowerCase();
  switch (ext) {
    case ".js":
    case ".mjs":
    case ".cjs":
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

/** Forwarded env keys — everything else in `process.env` (secrets) is dropped. */
const FORWARDED_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "TZ"] as const;

function buildEnv(
  cwd: string,
  parentEnv: NodeJS.ProcessEnv,
  event: HookV1Event,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of FORWARDED_ENV_KEYS) {
    const v = parentEnv[k];
    if (typeof v === "string") env[k] = v;
  }
  env.MATHRAN_HOOK_EVENT = event;
  env.MATHRAN_WORKSPACE = cwd;
  return env;
}

export interface InvokeHookV1Opts {
  /** Workspace root — used as cwd for the hook process. */
  cwd: string;
  /** Override default timeout (ms) for hooks without their own `timeoutSec`. */
  defaultTimeoutMs?: number;
  /** Parent process env (mostly for tests). */
  parentEnv?: NodeJS.ProcessEnv;
  /** Matcher inputs (tool name + Claude Code aliases). For non-tool events: []. */
  matcherInputs?: ReadonlyArray<string>;
}

/** Pick the entries that match this event + matcher inputs. */
function selectEntries(
  entries: ReadonlyArray<HookV1Entry>,
  event: HookV1Event,
  matcherInputs: ReadonlyArray<string>,
): HookV1Entry[] {
  return entries.filter(
    (e) => e.event === event && matchAny(e.matcher, matcherInputs),
  );
}

/** Cap a buffer at `limit` bytes; mark truncated once over. */
class CappedBuffer {
  private parts: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  append(b: Buffer | string): void {
    // 2026-06-30 — Node child_process streams default to Buffer chunks,
    // but `setEncoding('utf8')` (or some test harnesses) flip them to
    // strings. Normalize once at the entry so Buffer.concat() never sees
    // a string and crashes with `TypeError: list[0] must be Buffer`.
    const buf = typeof b === "string" ? Buffer.from(b, "utf-8") : b;
    if (this.truncated) return;
    if (this.size + buf.length > this.limit) {
      const room = Math.max(0, this.limit - this.size);
      if (room > 0) {
        this.parts.push(buf.subarray(0, room));
        this.size += room;
      }
      this.truncated = true;
      return;
    }
    this.parts.push(buf);
    this.size += buf.length;
  }
  toString(): string {
    return Buffer.concat(this.parts).toString("utf-8");
  }
}

/** Parse hook stdout. Returns `{ parsed }` or `{ error }`; empty → `{ parsed: undefined }`. */
function parseHookOutput(
  stdout: string,
): { parsed?: HookV1Output; error?: string } {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  // Tolerate non-JSON output: hooks may just `echo "lint OK"`. That's allowed.
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return {};
  }
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return { error: "hook stdout JSON must be an object" };
    }
    return { parsed: obj as HookV1Output };
  } catch (err: any) {
    return { error: `hook stdout JSON parse error: ${err?.message ?? err}` };
  }
}

/** Normalize a parsed output into block / updated_input / context fields. */
function interpretOutput(parsed: HookV1Output | undefined): {
  blocked: boolean;
  blockReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
} {
  if (!parsed) return { blocked: false };
  // Claude Code-style nested decision.
  const nested = parsed.hookSpecificOutput;
  if (nested?.permissionDecision === "deny") {
    return {
      blocked: true,
      blockReason:
        nested.permissionDecisionReason ?? "hook denied the tool call",
    };
  }
  if (parsed.decision === "block") {
    return { blocked: true, blockReason: parsed.reason ?? "hook blocked" };
  }
  const updatedInput =
    parsed.updated_input ??
    nested?.updatedInput ??
    undefined;
  const additionalContext =
    parsed.additionalContext ?? nested?.additionalContext ?? undefined;
  return {
    blocked: false,
    ...(updatedInput ? { updatedInput } : {}),
    ...(additionalContext ? { additionalContext } : {}),
  };
}

/** Run one hook subprocess; never throws. */
async function runOne(
  entry: HookV1Entry,
  input: HookV1Input,
  opts: { cwd: string; timeoutMs: number; parentEnv: NodeJS.ProcessEnv },
): Promise<HookV1RunResult> {
  const interp = interpreterFor(entry.command);
  const env = buildEnv(opts.cwd, opts.parentEnv, entry.event);
  const stdoutBuf = new CappedBuffer(HOOK_V1_OUTPUT_CAP_BYTES);
  const stderrBuf = new CappedBuffer(HOOK_V1_OUTPUT_CAP_BYTES);
  const started = Date.now();
  let timedOut = false;

  const exitInfo = await new Promise<{
    exitCode: number | null;
    spawnErr?: Error;
  }>((resolve) => {
    let child: ChildProcess;
    try {
      child = execFile(
        interp.command,
        [...interp.args, entry.command],
        {
          cwd: opts.cwd,
          env,
          // We collect stdout/stderr manually via streams (so we can cap).
          maxBuffer: HOOK_V1_OUTPUT_CAP_BYTES * 2,
          windowsHide: true,
        },
        // The callback isn't strictly needed (we listen to close ourselves)
        // but execFile will emit `error` on spawn failure which we capture
        // via the 'error' event below.
        () => {
          // intentional no-op — we handle resolution via the events below
        },
      );
    } catch (err: any) {
      resolve({ exitCode: null, spawnErr: err });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* best effort */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best effort */
        }
      }, 500).unref();
    }, opts.timeoutMs);
    timer.unref();
    child.stdout?.on("data", (c: Buffer | string) => stdoutBuf.append(c));
    child.stderr?.on("data", (c: Buffer | string) => stderrBuf.append(c));
    // 2026-06-30 — catch async EPIPE on stdin when the child gets SIGTERM
    // before we finish piping. Without this listener Node treats the
    // unhandled stream error as a process-level error and vitest flags it
    // as an "Unhandled Error" in the test report (functionally harmless).
    child.stdin?.on("error", () => {
      /* hook closed stdin or process died before we could pipe — ignore. */
    });
    // Write stdin payload then close — single line of JSON.
    try {
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    } catch (err: any) {
      // EPIPE etc. — ignored; the hook just sees an empty stdin.
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, spawnErr: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: typeof code === "number" ? code : null });
    });
  });

  const durationMs = Date.now() - started;
  const stdout = stdoutBuf.toString();
  const stderr = stderrBuf.toString();

  // Build the result. Branch on (timeout / spawn err / exit 0 / exit 2 / other).
  if (exitInfo.spawnErr) {
    return {
      entry,
      exitCode: -1,
      stdout,
      stderr:
        `failed to spawn hook: ${exitInfo.spawnErr.message ?? String(exitInfo.spawnErr)}` +
        (stderr ? `\n${stderr}` : ""),
      durationMs,
      timedOut: false,
      blocked: true,
      blockReason: `hook failed to spawn: ${exitInfo.spawnErr.message ?? String(exitInfo.spawnErr)}`,
    };
  }
  if (timedOut) {
    return {
      entry,
      exitCode: exitInfo.exitCode ?? -1,
      stdout,
      stderr,
      durationMs,
      timedOut: true,
      blocked: true,
      blockReason: `hook ${entry.command} timed out after ${(opts.timeoutMs / 1000).toFixed(1)}s`,
    };
  }

  const exitCode = exitInfo.exitCode ?? -1;

  // exit 2 → block (with stderr reason if any).
  if (exitCode === 2) {
    return {
      entry,
      exitCode,
      stdout,
      stderr,
      durationMs,
      timedOut: false,
      blocked: true,
      blockReason: stderr.trim() || `hook exited with code 2`,
    };
  }

  // Other non-zero → block.
  if (exitCode !== 0) {
    return {
      entry,
      exitCode,
      stdout,
      stderr,
      durationMs,
      timedOut: false,
      blocked: true,
      blockReason:
        stderr.trim() || `hook exited with code ${exitCode}`,
    };
  }

  // exit 0 → parse stdout JSON for optional decision / updated_input / context.
  const { parsed, error: parseError } = parseHookOutput(stdout);
  const interpreted = interpretOutput(parsed);
  return {
    entry,
    exitCode,
    stdout,
    stderr,
    durationMs,
    timedOut: false,
    ...(parsed ? { parsed } : {}),
    ...(parseError ? { parseError } : {}),
    blocked: interpreted.blocked,
    ...(interpreted.blockReason ? { blockReason: interpreted.blockReason } : {}),
    ...(interpreted.updatedInput ? { updatedInput: interpreted.updatedInput } : {}),
    ...(interpreted.additionalContext
      ? { additionalContext: interpreted.additionalContext }
      : {}),
  };
}

/**
 * Run every hook matching `event` + `matcherInputs`. Serial execution (so we
 * preserve "first block wins" + a stable order for `additionalContexts`).
 * Returns `EMPTY_OUTCOME` (frozen singleton) when no hooks match.
 */
export async function invokeHookV1(
  entries: ReadonlyArray<HookV1Entry>,
  event: HookV1Event,
  input: HookV1Input,
  opts: InvokeHookV1Opts,
): Promise<HookV1Outcome> {
  const matcherInputs = opts.matcherInputs ?? [];
  const matched = selectEntries(entries, event, matcherInputs);
  if (matched.length === 0) return EMPTY_OUTCOME;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_HOOK_V1_TIMEOUT_MS;
  const parentEnv = opts.parentEnv ?? process.env;
  const results: HookV1RunResult[] = [];
  let blockReason: string | undefined;
  let updatedInput: Record<string, unknown> | undefined;
  const additionalContexts: string[] = [];

  for (const entry of matched) {
    const timeoutMs =
      entry.timeoutSec !== undefined
        ? entry.timeoutSec * 1000
        : defaultTimeoutMs;
    const r = await runOne(entry, input, {
      cwd: opts.cwd,
      timeoutMs,
      parentEnv,
    });
    results.push(r);
    if (r.blocked && blockReason === undefined) {
      blockReason = r.blockReason ?? "hook blocked";
    }
    if (!r.blocked && r.updatedInput) {
      // Last non-empty wins.
      updatedInput = r.updatedInput;
    }
    if (r.additionalContext) {
      additionalContexts.push(r.additionalContext);
    }
  }

  const blocked = blockReason !== undefined;
  const outcome: HookV1Outcome = {
    results,
    blocked,
    additionalContexts,
  };
  if (blockReason !== undefined) outcome.blockReason = blockReason;
  // updated_input is only meaningful when nothing blocked.
  if (!blocked && updatedInput !== undefined) {
    outcome.updatedInput = updatedInput;
  }
  return outcome;
}
