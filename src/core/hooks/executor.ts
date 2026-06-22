/**
 * Hook execution sandbox.
 *
 * {@link executeHooks} runs a list of {@link LoadedHook}s serially (USER →
 * WORKSPACE → PROJECT — caller-supplied order) with:
 *
 *   - **Approval** — when an {@link ApprovalBroker} is supplied each hook is
 *     authorized as a `riskClass: exec` call (tool `hook`) so the policy matrix
 *     / denylist / learning rules apply. A denied hook does not run.
 *   - **Denylist veto** — the hook's *script contents* are additionally checked
 *     against the approval denylist (so a `pre-bash.sh` containing `rm -rf $1`
 *     is refused even though the file path itself is allow-listed).
 *   - **Timeout** — default 30 s; a timed-out hook is SIGTERM'd then SIGKILL'd
 *     and counts as a failure.
 *   - **Output cap** — stdout/stderr capped at 100 KB each (`truncated` flag).
 *   - **Env isolation** — a clean {@link buildHookEnv} environment (no secret
 *     leak from `process.env`).
 *   - **Interpreter dispatch** — `.js`→node, `.py`→python3, else `/bin/bash`,
 *     spawned as `<interp> <hookPath>` (argv array — never a concatenated
 *     shell string, so there is no command-injection surface).
 *
 * A non-zero exit (or timeout) BLOCKS the guarded operation only for
 * {@link isBlockingHookType} (the `pre-*` hooks); `post-*` / `on-*` failures
 * are surfaced as warnings but never block.
 *
 * {@link HookInvoker} wraps `executeHooks` with the per-session settings
 * (enabled / timeoutMs / async / allowed-whitelist / bypass), history
 * recording, and human-readable summary formatting that the tools + chat
 * session call into.
 */

import * as fs from "node:fs";
import { spawn } from "node:child_process";
import {
  isBlockingHookType,
  type HookType,
  type LoadedHook,
} from "./loader.js";
import {
  buildHookEnv,
  hookCwd,
  interpreterFor,
  type HookExecutionContext,
} from "./context.js";
import { HookHistory, outcomeTag, relativeAge } from "./history.js";
import type { ApprovalBroker } from "../chat/approval-broker.js";
import { matchDenylist } from "../approval/rules.js";
import type { DenylistEntry } from "../approval/rules.js";

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
export const HOOK_OUTPUT_CAP_BYTES = 100 * 1024;

export interface HookExecutionResult {
  hook: LoadedHook;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** True when a `pre-*` hook failed/timed-out → the operation is blocked. */
  blocked: boolean;
  /** True when stdout or stderr hit the 100 KB cap. */
  truncated: boolean;
  /** Set when the hook never ran (approval deny / denylist veto). */
  skipped?: boolean;
  skipReason?: string;
}

export interface ExecuteHooksOptions {
  timeoutMs?: number;
  /** When set, each hook is authorized as a `riskClass: exec` call. */
  approvalBroker?: ApprovalBroker;
  /** Denylist checked against each hook's *script contents*. */
  denylist?: DenylistEntry[];
  /** Parent env to forward whitelisted keys from (default `process.env`). */
  parentEnv?: NodeJS.ProcessEnv;
}

/** Cap a byte stream at `limit`; mark + drop once over. */
class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  append(chunk: Buffer): void {
    if (this.truncated) return;
    if (this.size + chunk.length > this.limit) {
      const room = Math.max(0, this.limit - this.size);
      if (room > 0) {
        this.chunks.push(chunk.subarray(0, room));
        this.size += room;
      }
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }
}

function readHookContents(hookPath: string): string {
  try {
    return fs.readFileSync(hookPath, "utf-8");
  } catch {
    return "";
  }
}

/** Run a single hook process; resolve with exit/timeout/output. */
function spawnHook(
  hook: LoadedHook,
  ctx: HookExecutionContext,
  timeoutMs: number,
  parentEnv: NodeJS.ProcessEnv,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}> {
  const interp = interpreterFor(hook.path);
  const stdout = new CappedBuffer(HOOK_OUTPUT_CAP_BYTES);
  const stderr = new CappedBuffer(HOOK_OUTPUT_CAP_BYTES);
  let timedOut = false;
  let exitCode = -1;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(interp.command, [...interp.args, hook.path], {
        cwd: hookCwd(ctx),
        env: buildHookEnv(ctx, parentEnv),
        detached: true,
      });
    } catch (err) {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: `failed to spawn hook: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
        truncated: false,
      });
      return;
    }
    const killGroup = (signal: NodeJS.Signals) => {
      // Kill the whole process group so a hook's own children (e.g. a `sleep`
      // spawned by a bash script) die too and release the stdio pipes.
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* best-effort */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 500).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (c: Buffer) => stdout.append(c));
    child.stderr?.on("data", (c: Buffer) => stderr.append(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr.append(Buffer.from(`\n[spawn error] ${err.message}`));
      resolve({
        exitCode: -1,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      exitCode = typeof code === "number" ? code : -1;
      resolve({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}

/**
 * Execute `hooks` serially against the shared `ctx`. Each hook's `ctx.hookType`
 * is overridden from the hook's own classified type so a single call may mix
 * layers of the same type.
 */
export async function executeHooks(
  hooks: LoadedHook[],
  ctx: HookExecutionContext,
  opts: ExecuteHooksOptions = {},
): Promise<HookExecutionResult[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const parentEnv = opts.parentEnv ?? process.env;
  const results: HookExecutionResult[] = [];

  for (const hook of hooks) {
    const hookCtx: HookExecutionContext = { ...ctx, hookType: hook.type };
    const blocks = isBlockingHookType(hook.type);

    // 1. Denylist veto on the hook's own script contents (security wins).
    //    Patterns are anchored globs, so we test each non-empty, non-comment
    //    line of the script rather than the whole blob.
    if (opts.denylist && opts.denylist.length > 0) {
      const contents = readHookContents(hook.path);
      let hit: DenylistEntry | null = null;
      for (const line of contents.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        hit = matchDenylist(opts.denylist, "bash", { command: trimmed });
        if (hit) break;
      }
      if (hit) {
        results.push({
          hook,
          exitCode: 126,
          stdout: "",
          stderr: `hook contents blocked by denylist rule: ${hit}`,
          durationMs: 0,
          timedOut: false,
          blocked: blocks,
          truncated: false,
          skipped: true,
          skipReason: `denylist: ${hit}`,
        });
        continue;
      }
    }

    // 2. Approval — authorize as a riskClass:exec call.
    if (opts.approvalBroker) {
      const interp = interpreterFor(hook.path);
      const auth = await opts.approvalBroker.authorize({
        tool: "hook",
        riskClass: "exec",
        args: {
          path: hook.path,
          command: `${interp.command} ${hook.path}`,
        },
        id: `hook:${hook.path}`,
      });
      if (auth.kind === "deny") {
        results.push({
          hook,
          exitCode: 126,
          stdout: "",
          stderr: `hook not approved: ${auth.reason}`,
          durationMs: 0,
          timedOut: false,
          blocked: blocks,
          truncated: false,
          skipped: true,
          skipReason: `approval: ${auth.reason}`,
        });
        continue;
      }
    }

    // 3. Execute.
    const started = Date.now();
    const run = await spawnHook(hook, hookCtx, timeoutMs, parentEnv);
    const durationMs = Date.now() - started;
    const failed = run.timedOut || run.exitCode !== 0;
    results.push({
      hook,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      durationMs,
      timedOut: run.timedOut,
      blocked: blocks && failed,
      truncated: run.truncated,
    });
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────
// HookInvoker — per-session orchestration the tools + chat session use.
// ──────────────────────────────────────────────────────────────────────

export interface HookSettings {
  /** Master switch (default true). */
  enabled?: boolean;
  timeoutMs?: number;
  /** When true, `post-*` / `on-*` hooks run fire-and-forget (default false). */
  async?: boolean;
  /** Whitelist of hook names/types — when present, only allow-listed run. */
  allowed?: string[];
  /** Operations whose filePath / command start with any of these skip hooks. */
  bypassPrefix?: string[];
}

export interface HookRunOutcome {
  /** Results of hooks that actually ran (or were skipped/denied). */
  ran: HookExecutionResult[];
  /** True when a blocking (`pre-*`) hook failed → caller must NOT proceed. */
  blocked: boolean;
  blockedReason?: string;
  /** Human/system-readable multi-line summary (undefined when nothing ran). */
  summary?: string;
}

export interface HookInvokerOptions {
  hooks: LoadedHook[];
  workspace: string;
  projectSlug?: string;
  settings?: HookSettings;
  approvalBroker?: ApprovalBroker;
  denylist?: DenylistEntry[];
  history?: HookHistory;
  parentEnv?: NodeJS.ProcessEnv;
}

/** Partial context a trigger site supplies (the rest comes from the invoker). */
export type HookTriggerContext = Pick<
  HookExecutionContext,
  "filePath" | "bashCommand" | "toolName" | "goalText"
>;

export class HookInvoker {
  private readonly hooks: LoadedHook[];
  private readonly workspace: string;
  private readonly projectSlug?: string;
  private readonly settings: HookSettings;
  private readonly approvalBroker?: ApprovalBroker;
  private readonly denylist?: DenylistEntry[];
  readonly history: HookHistory;
  private readonly parentEnv?: NodeJS.ProcessEnv;
  /** Hook names to skip exactly once on their next trigger (session-only). */
  private readonly bypassOnce = new Set<string>();

  constructor(opts: HookInvokerOptions) {
    this.hooks = opts.hooks;
    this.workspace = opts.workspace;
    this.projectSlug = opts.projectSlug;
    this.settings = opts.settings ?? {};
    this.approvalBroker = opts.approvalBroker;
    this.denylist = opts.denylist;
    this.history = opts.history ?? new HookHistory();
    this.parentEnv = opts.parentEnv;
  }

  /** Whether hooks are enabled at all (settings master switch). */
  get enabled(): boolean {
    return this.settings.enabled !== false;
  }

  /** All loaded hooks (read-only) — for `/hooks list`. */
  get allHooks(): readonly LoadedHook[] {
    return this.hooks;
  }

  /** Effective settings snapshot — for `/hooks list`. */
  get settingsSnapshot(): Required<Pick<HookSettings, "enabled" | "timeoutMs" | "async">> {
    return {
      enabled: this.enabled,
      timeoutMs: this.settings.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      async: this.settings.async === true,
    };
  }

  /** Mark a hook to be skipped on its next trigger (`/hooks bypass`). */
  bypassNext(name: string): void {
    this.bypassOnce.add(name);
  }

  /** Hooks of `type` that would run, after whitelist filtering (display order). */
  hooksForType(type: HookType): LoadedHook[] {
    const allowedConfigured = this.settings.allowed !== undefined;
    return this.hooks.filter(
      (h) => h.type === type && (!allowedConfigured || h.allowed),
    );
  }

  /**
   * Run all hooks of `type`, honoring enabled / whitelist / bypass / async.
   * Returns the aggregate outcome (blocked + summary). Never throws.
   */
  async run(type: HookType, trigger: HookTriggerContext = {}): Promise<HookRunOutcome> {
    if (!this.enabled) return { ran: [], blocked: false };

    // Coarse operation-prefix bypass (settings.bypassPrefix).
    const subject = trigger.filePath ?? trigger.bashCommand ?? "";
    if (
      subject &&
      (this.settings.bypassPrefix ?? []).some((p) => subject.startsWith(p))
    ) {
      return { ran: [], blocked: false };
    }

    let candidates = this.hooksForType(type);

    // Session-only one-shot bypass (consume the flag).
    candidates = candidates.filter((h) => {
      if (this.bypassOnce.has(h.name)) {
        this.bypassOnce.delete(h.name);
        return false;
      }
      return true;
    });

    if (candidates.length === 0) return { ran: [], blocked: false };

    const ctx: HookExecutionContext = {
      hookType: type,
      workspace: this.workspace,
      projectSlug: this.projectSlug,
      ...trigger,
    };

    const exec = (): Promise<HookExecutionResult[]> =>
      executeHooks(candidates, ctx, {
        timeoutMs: this.settings.timeoutMs,
        approvalBroker: this.approvalBroker,
        denylist: this.denylist,
        parentEnv: this.parentEnv,
      });

    // Async mode: post-*/on-* hooks run fire-and-forget (never block).
    if (this.settings.async === true && !isBlockingHookType(type)) {
      void exec()
        .then((results) => {
          for (const r of results) this.recordResult(r);
        })
        .catch(() => {});
      return { ran: [], blocked: false };
    }

    const results = await exec();
    for (const r of results) this.recordResult(r);

    const blockedResults = results.filter((r) => r.blocked);
    const blocked = blockedResults.length > 0;
    const blockedReason = blocked
      ? blockedResults
          .map((r) => `${r.hook.name} (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""})`)
          .join("; ")
      : undefined;

    return {
      ran: results,
      blocked,
      blockedReason,
      summary: formatHookSummary(results),
    };
  }

  private recordResult(r: HookExecutionResult): void {
    this.history.record({
      name: r.hook.name,
      type: r.hook.type,
      layer: r.hook.layer,
      exitCode: r.exitCode,
      blocked: r.blocked,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      truncated: r.truncated,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }
}

/** Format a single hook result as the `[hook: …]` block (B.3 layout). */
export function formatHookResult(r: HookExecutionResult): string {
  const rel = r.hook.path;
  const dur = (r.durationMs / 1000).toFixed(1);
  const head = r.timedOut
    ? `[hook: ${r.hook.type} (${rel})] TIMED OUT after ${dur}s`
    : `[hook: ${r.hook.type} (${rel})] exit=${r.exitCode} in ${dur}s`;
  const lines: string[] = [head];
  const body = r.stdout.trim();
  if (body) {
    const out = body.split("\n");
    lines.push(`stdout (${out.length} line${out.length === 1 ? "" : "s"}):`);
    for (const l of out.slice(0, 50)) lines.push(`  ${l}`);
    if (out.length > 50) lines.push(`  … (${out.length - 50} more)`);
  }
  const err = r.stderr.trim();
  if (err && r.exitCode !== 0) {
    const el = err.split("\n");
    lines.push(`stderr (${el.length} line${el.length === 1 ? "" : "s"}):`);
    for (const l of el.slice(0, 20)) lines.push(`  ${l}`);
  }
  if (r.truncated) lines.push("  [output truncated at 100KB]");
  return lines.join("\n");
}

/** Format all results into one system-message blob (undefined when empty). */
export function formatHookSummary(
  results: HookExecutionResult[],
): string | undefined {
  if (results.length === 0) return undefined;
  return results.map(formatHookResult).join("\n");
}

/**
 * Build the tool-error message returned when a blocking (`pre-*`) hook fails,
 * so the model/user understand what happened and how to bypass it (C.4).
 */
export function formatHookBlock(operation: string, outcome: HookRunOutcome): string {
  const names = outcome.ran
    .filter((r) => r.blocked)
    .map((r) => r.hook.name);
  const bypass = names.length > 0 ? names[0] : "<name>";
  const lines = [
    `⛔ ${operation} blocked by hook: ${outcome.blockedReason ?? "hook failed"}.`,
  ];
  if (outcome.summary) lines.push(outcome.summary);
  lines.push(
    `Use \`/hooks bypass ${bypass}\` to skip this hook on the next call.`,
  );
  return lines.join("\n");
}

export { outcomeTag, relativeAge };
