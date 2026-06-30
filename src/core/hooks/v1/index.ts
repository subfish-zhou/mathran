/**
 * Hooks v1 — public surface.
 *
 * Top-level facade: build a {@link HookV1Runner} once per session (carrying the
 * loaded `hooks.json` entries + workspace), then call `.preToolUse(...)` /
 * `.postToolUse(...)` / `.sessionStart(...)` / `.preCompact(...)` /
 * `.postCompact(...)` at the matching trigger sites.
 *
 * Wired into `ChatSession` via a tiny extension on the existing legacy
 * `HookInvoker` so the session.ts patch is just `this.hookInvoker?.v1?.…`
 * — no new constructor arg.
 *
 * @example
 *   const { entries, warnings } = loadHookV1Config({ workspace });
 *   const runner = new HookV1Runner(entries, { workspace, sessionId });
 *   const pre = await runner.preToolUse({ toolName: "bash", toolInput: { … } });
 *   if (pre.blocked) return { ok: false, content: pre.blockReason };
 */

import { runPreToolUse, type PreToolUseRequest } from "./events/pre-tool-use.js";
import { runPostToolUse, type PostToolUseRequest } from "./events/post-tool-use.js";
import { runSessionStart, type SessionStartRequest } from "./events/session-start.js";
import {
  runPreCompact,
  runPostCompact,
  type PreCompactRequest,
  type PostCompactRequest,
} from "./events/compact.js";
import type { HookV1Entry, HookV1Event, HookV1Outcome } from "./schema.js";

export interface HookV1RunnerOptions {
  workspace: string;
  sessionId?: string;
  /** Override the default 30 s timeout (ms). */
  defaultTimeoutMs?: number;
}

/**
 * Per-session runner. Holds the loaded entries + workspace; each `.xxx()`
 * method short-circuits when no entry matches its event (so the cost of an
 * unconfigured runner is one array filter).
 */
export class HookV1Runner {
  private readonly entries: ReadonlyArray<HookV1Entry>;
  private readonly workspace: string;
  private readonly sessionId?: string;
  private readonly defaultTimeoutMs?: number;

  constructor(
    entries: ReadonlyArray<HookV1Entry>,
    opts: HookV1RunnerOptions,
  ) {
    this.entries = entries;
    this.workspace = opts.workspace;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
    if (opts.defaultTimeoutMs !== undefined) {
      this.defaultTimeoutMs = opts.defaultTimeoutMs;
    }
  }

  /** True when at least one configured entry targets `event` (no matcher check). */
  has(event: HookV1Event): boolean {
    return this.entries.some((e) => e.event === event);
  }

  /** All entries (read-only) — for `/hooks list` rendering. */
  get all(): ReadonlyArray<HookV1Entry> {
    return this.entries;
  }

  /** Number of configured entries (across all events). */
  get size(): number {
    return this.entries.length;
  }

  async preToolUse(
    req: Omit<PreToolUseRequest, "workspace" | "sessionId" | "defaultTimeoutMs">,
  ): Promise<HookV1Outcome> {
    if (!this.has("PreToolUse")) return EMPTY;
    return runPreToolUse(this.entries, {
      workspace: this.workspace,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.defaultTimeoutMs }
        : {}),
      ...req,
    });
  }

  async postToolUse(
    req: Omit<PostToolUseRequest, "workspace" | "sessionId" | "defaultTimeoutMs">,
  ): Promise<HookV1Outcome> {
    if (!this.has("PostToolUse")) return EMPTY;
    return runPostToolUse(this.entries, {
      workspace: this.workspace,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.defaultTimeoutMs }
        : {}),
      ...req,
    });
  }

  async sessionStart(
    req: Omit<SessionStartRequest, "workspace" | "sessionId" | "defaultTimeoutMs"> = {},
  ): Promise<HookV1Outcome> {
    if (!this.has("SessionStart")) return EMPTY;
    return runSessionStart(this.entries, {
      workspace: this.workspace,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.defaultTimeoutMs }
        : {}),
      ...req,
    });
  }

  async preCompact(
    req: Omit<PreCompactRequest, "workspace" | "sessionId" | "defaultTimeoutMs"> = {},
  ): Promise<HookV1Outcome> {
    if (!this.has("PreCompact")) return EMPTY;
    return runPreCompact(this.entries, {
      workspace: this.workspace,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.defaultTimeoutMs }
        : {}),
      ...req,
    });
  }

  async postCompact(
    req: Omit<PostCompactRequest, "workspace" | "sessionId" | "defaultTimeoutMs"> = {},
  ): Promise<HookV1Outcome> {
    if (!this.has("PostCompact")) return EMPTY;
    return runPostCompact(this.entries, {
      workspace: this.workspace,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.defaultTimeoutMs }
        : {}),
      ...req,
    });
  }
}

const EMPTY: HookV1Outcome = Object.freeze({
  results: [],
  blocked: false,
  additionalContexts: [],
});

export { loadHookV1Config } from "./loader.js";
export { aliasesForTool, toolsForAlias, aliasTable } from "./aliases.js";
export {
  invokeHookV1,
  DEFAULT_HOOK_V1_TIMEOUT_MS,
  HOOK_V1_OUTPUT_CAP_BYTES,
} from "./invoker.js";
export { matchAny, matchOne, isUniversal, isExact } from "./matcher.js";
export type {
  HookV1Entry,
  HookV1Event,
  HookV1Input,
  HookV1Output,
  HookV1Outcome,
  HookV1RunResult,
  PreToolUseInput,
  PostToolUseInput,
  SessionStartInput,
  PreCompactInput,
  PostCompactInput,
} from "./schema.js";
export { HOOK_V1_EVENTS } from "./schema.js";
