/**
 * ChatSession — Mathran's lightweight conversational kernel.
 *
 * Shared by the CLI REPL/`-p` one-shot path and (soon) the `serve` chat panel:
 * both consume the same `AsyncIterable<ChatEvent>` from `send()`.
 *
 * This is deliberately NOT the full agent loop (`src/lib/agent/executor.ts`),
 * which depends on the `_stubs/` platform bindings and throws at runtime. The
 * kernel only does:
 *   messages history  +  LLMProvider.stream  +  a small, injectable tool set.
 *
 * Tool dispatch uses OpenAI-style function-calling (the `tool-call` chunks the
 * LLM adapters already emit). When a turn finishes with tool calls, each tool
 * is executed, its result is fed back as a `tool` message, and the LLM is
 * called again — until it produces a turn with no tool calls.
 */

import { randomUUID } from "node:crypto";
import type {
  LLMProvider,
  LLMMessage,
  LLMRequest,
  LLMStreamChunk,
} from "../providers/llm.js";
import { capToolOutput } from "./tool-output-cap.js";
import {
  compactRunner,
  type CompactRunnerInput,
  type CompactedArtifact,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_KEEP_RECENT_ROUNDS,
} from "../subagent/runners/compact.js";
import { readSummarizeRunner } from "../subagent/runners/read-summarize.js";
import { searchRunner } from "../subagent/runners/search.js";
import { SubagentRegistry } from "../subagent/registry.js";
import { SubagentScheduler } from "../subagent/scheduler.js";
import { readArtifact } from "../subagent/artifact.js";
import {
  loadMathranMemorySync,
  formatMathranMemory,
  loadLayeredMathranMemorySync,
  formatLayeredMathranMemory,
} from "../memory/index.js";
import {
  formatSkillsForPrompt,
  type LoadedSkill,
} from "../skills/loader.js";
import { createBashTool } from "./tools/bash.js";
import { createReadFileTool } from "./tools/read-file.js";
import { createWriteFileTool } from "./tools/write-file.js";
import { createEditFileTool } from "./tools/edit-file.js";
import { createDispatchSubagentTool } from "./tools/dispatch-subagent.js";
import {
  AskUserPending,
  ASK_USER_PENDING_PLACEHOLDER,
  createAskUserTool,
  isAskUserPending,
  type AskUserResolver,
} from "./tools/ask-user.js";
import { createProposeGoalTool } from "./tools/propose-goal.js";
import { createProposePlanTool } from "./tools/propose-plan.js";
import { ApprovalBroker } from "./approval-broker.js";
import type { HookInvoker } from "../hooks/executor.js";
import type { RiskClass, ApprovalRequest, ApprovalDecision, ApprovalResolver } from "../approval/types.js";
import * as path from "node:path";

/**
 * Per-invocation context the kernel threads into a tool's `execute()`.
 *
 * `scope` lets tools resolve project/effort-relative paths (T1-D / BUG #7
 * fix): lean_check can `cd` into an effort's `files/` directory, wiki tools
 * can read pages in the current project, etc. When the host doesn't know its
 * scope (CLI one-shots, isolated test harnesses), this is `undefined` and
 * tools must default to a non-project sandbox.
 */
export interface ToolExecuteContext {
  /** Workspace root (absolute). */
  workspace?: string;
  /** Chat scope this invocation belongs to. */
  scope?: {
    kind: "global" | "project" | "effort";
    projectSlug?: string;
    effortSlug?: string;
  };
  /** v0.5 §7 — record that a path has been read this session. */
  recordRead?: (path: string) => void;
  /** v0.5 §7 — query whether a path has been read this session. */
  hasRead?: (path: string) => boolean;
  /** v0.16 §11 — provider-emitted tool-call id for this invocation, set
   *  by the session per call. The `ask_user` tool forwards it to its
   *  resolver so a serve host can build an `AskUserPending` carrying a
   *  stable placeholder key the resume endpoint can patch back into
   *  history. Optional because callers outside the session loop (tests,
   *  direct `.execute()` probes) may not set it. */
  toolCallId?: string;
  /**
   * Hooks runner threaded in by the session so tools can fire `pre-edit` /
   * `post-edit` / `pre-bash` / `pre-commit` hooks around their work. Absent
   * when no hooks are configured (or in isolated test harnesses), in which
   * case tools must behave exactly as before.
   */
  hooks?: HookInvoker;
}

/** A tool the model can invoke. Parameters are a JSON-schema object. */
export interface ToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  /**
   * Coarse risk bucket driving the approval policy (Approval Policy 矩阵).
   * Optional for backward-compat: a tool without a `riskClass` is treated as
   * `read` by the approval broker (the most permissive bucket) so legacy /
   * third-party tools never accidentally gate. Builtin tools all set it.
   */
  riskClass?: RiskClass;
  /**
   * Execute the tool. `args` is the parsed JSON arguments object (or `{}` if
   * the model emitted no/invalid JSON). `ctx` carries optional workspace/scope
   * hints — tools should treat it as advisory and fall back to safe defaults
   * when it's not set. Returns the textual result that is fed back to the
   * model plus an `ok` flag for callers/loggers.
   */
  execute(args: Record<string, unknown>, ctx?: ToolExecuteContext): Promise<{ ok: boolean; content: string }>;
}

/**
 * Events streamed out of `send()`. Mirrors `LLMStreamChunk` and extends it with
 * `tool-result` so both the CLI and an HTTP transport can render the full turn.
 */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; args: string }
  | { type: "tool-result"; id: string; name: string; ok: boolean; content: string }
  | {
      /** Approval Policy 矩阵 — emitted just before the host prompts the user
       *  to approve a high-risk tool call. Lets the SPA render its
       *  `ApprovalDialog` (serve) / observers log the request. CLI hosts use
       *  their readline resolver and may ignore this event. */
      type: "approval_request";
      request: ApprovalRequest;
    }
  | {
      /** Approval Policy 矩阵 — emitted after a tool call's approval is
       *  resolved (allowed / denied / deferred), carrying the decision so the
       *  SPA can dismiss its modal and observers can audit the outcome. */
      type: "approval_resolved";
      id: string;
      decision: ApprovalDecision;
    }
  | {
      /** v0.16 §11 — the model called `ask_user`; the host (serve) will
       *  persist a pending annotation and end the stream so the user can
       *  reply via `POST /answer-ask`. CLI / goal hosts never see this
       *  event because their resolvers return synchronously. */
      type: "ask_user";
      id: string;
      name: string;
      question: string;
    }
  | {
      /** v0.17 mathub parity W7 — emitted by the *goal* runner (NOT the
       *  chat session) at the top of every goal round so the SPA can
       *  render the `Step N/MAX · ⏱ Xs` status strip. `maxRounds` is
       *  optional: plain chat (single-round semantics) never emits this
       *  event; goal runs with no `roundsMax` budget emit `round` without
       *  a cap. W9 (Live Steering) extends ChatEvent further with
       *  `steer-received` — this case stays additive and unaffected. */
      type: "round-start";
      round: number;
      maxRounds?: number;
    }
  | {
      /** v0.17 mathub parity W9 — emitted by `runRounds` whenever a
       *  `SendOpts.steerProbe` returns a non-empty string at a round
       *  boundary. The runner injects the steer text as a synthetic
       *  `[Steer from user: …]` user message into history BEFORE the
       *  next LLM request, then yields this event so the SPA can
       *  dismiss its "queued" toast + render a "📣 Steered" badge on
       *  the next round bubble. The injected user message also lands
       *  in the persisted conversation jsonl as a normal user turn so
       *  reloads see what the user actually steered with. */
      type: "steer-received";
      text: string;
    }
  | {
      type: "done";
      finishReason: Extract<LLMStreamChunk, { type: "done" }>["finishReason"];
    };

export interface ChatSessionOptions {
  llm: LLMProvider;
  model?: string;
  tools?: ToolSpec[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Safety cap on tool-call round-trips per `send()`. Default 8. */
  maxToolRounds?: number;
  /**
   * Per-session context threaded into every `tool.execute()` call. The host
   * (the `serve` route or CLI) supplies this so tools resolve relative paths
   * inside the right project/effort directory (T1-D / BUG #7 fix).
   */
  toolContext?: ToolExecuteContext;
  /**
   * Stable identifier for this session, used to namespace spilled tool-output
   * dumps under `<workspace>/.mathran/tool-output/<sessionId>/`. Defaults to a
   * generated UUID when omitted.
   */
  sessionId?: string;
  /**
   * Tool-result hard cap (v0.2 §2). When set, every tool result is passed
   * through `capToolOutput()` before being pushed into history: the inline
   * portion is truncated to `maxInlineBytes` (default 4096) and, when a
   * `workspace` is given, the full output is spilled to disk. When this option
   * is *undefined*, tool results are stored verbatim (backward-compatible).
   */
  toolOutputCap?: { maxInlineBytes?: number; workspace?: string | null };
  /**
   * Auto-compact (v0.2 §5). When `enabled: true`, every `send()` call checks
   * the token count of `this.messages` against `contextWindow * thresholdPct`
   * and runs `compact()` first if we'd overflow. Requires the wrapped
   * LLMProvider to implement `countTokens`; falls back to a silent no-op
   * when the provider can't count tokens. Defaults: thresholdPct=0.75,
   * keepRecentRounds=5, contextWindow=200000.
   */
  autoCompact?: {
    enabled?: boolean;
    thresholdPct?: number;
    keepRecentRounds?: number;
    contextWindow?: number;
  };
  /**
   * Workspace root for subagent artifacts (v0.2 §5). Required for `compact()`
   * to write the compacted-history artifact. When omitted, `compact()` falls
   * back to a per-session temp dir.
   */
  workspace?: string;
  /**
   * Optional injected subagent scheduler. Tests pass a custom one; production
   * code lets ChatSession build its own (with the compact runner registered)
   * lazily on first compact.
   */
  subagentScheduler?: SubagentScheduler;
  /**
  /**
   * Opt-in built-in tools the LLM can call (v0.2 §8 onward). Each switch is
   * default-off; enabling one injects a {@link ToolSpec} into the per-turn
   * tool list. Built-in tools require `subagentScheduler` to be wired
   * (production code) or the lazy scheduler from `getOrBuildScheduler`
   * (tests) — when the requirement is unmet, the tool is silently dropped to
   * keep this purely additive.
   *
   *   - `search` — dispatches the `search` subagent runner (Task 8).
   *   - `read_file_summary` — dispatches the `read_summarize` runner (Task 9).
   *   - `bash` (v0.4 §1) — `bash -lc` shell, workspace-scoped, capped output.
   *   - `read_file` (v0.4 §1) — raw bytes with `cat -n` line numbers.
   *   - `write_file` (v0.4 §1) — create / overwrite UTF-8 file.
   *   - `edit_file` (v0.4 §1) — unique-string replace (or `replace_all`).
   *   - `dispatch_subagent` (v0.5 wire-up Gap #4 + #5) — generic dispatch
   *     into the subagent scheduler (compact/search/read_summarize/research/
   *     lean_explore), optional subprocess runtime. Requires
   *     `opts.scheduler` to be wired; otherwise the tool is silently skipped
   *     with a console warning (purely additive — no crash).
   */
  builtinTools?: {
    search?: boolean;
    read_file_summary?: boolean;
    bash?: boolean;
    read_file?: boolean;
    write_file?: boolean;
    edit_file?: boolean;
    dispatch_subagent?: boolean;
    /**
     * v0.16 §11 — host-specific `ask_user` resolver. Pass the readline
     * resolver from CLI, the `throw new AskUserPending` resolver from
     * serve, the canned-reply resolver from goal mode. Omit (or set
     * `undefined`) to disable the tool. Unlike the boolean flags above,
     * this is an object because the resolver differs per host.
     */
    ask_user?: { resolver: AskUserResolver };
    /**
     * v0.17 follow-up — chat-mode goal proposal. Same resolver shape as
     * `ask_user` (the tool piggybacks ask_user's serve UI). When provided,
     * the LLM gets a `propose_goal` tool that, upon model invocation, asks
     * the user to confirm max-rounds + token budget and then creates a
     * Goal record on disk. Workspace + scope + model are needed so the
     * goal is seeded in the right project bucket with the same model the
     * chat is currently using.
     */
    propose_goal?: {
      resolver: AskUserResolver;
      workspace: string;
      scope: { kind: "global" | "project" | "effort"; projectSlug?: string; effortSlug?: string };
      model: string;
      /** v0.17 P2 — see ProposeGoalToolOptions.autoRunner. */
      autoRunner?: (goalId: string, userMessage: string) => void;
    };
    /**
     * v0.17 P2 — chat-mode plan proposal. Same shape as propose_goal but
     * routes to {@link createProposePlanTool}; the LLM uses this when the
     * user asked for a plan / sketch / approach BEFORE the work itself.
     * `autoRunner` is the host-provided fire-and-forget kickoff that
     * calls `runPlan` with full closure deps.
     */
    propose_plan?: {
      resolver: AskUserResolver;
      workspace: string;
      model: string;
      autoRunner?: (planId: string, objective: string) => void;
    };
  };
  /**
   * Subagent scheduler the `dispatch_subagent` builtin tool dispatches into
   * (v0.5 wire-up Gap #4 + #5). When unset, enabling the tool flag is a
   * silent no-op (with a console warning so the wiring mistake is visible
   * during local dev). This is intentionally separate from
   * `subagentScheduler` (which is the legacy compact-only scheduler injection
   * — kept for backward compatibility); production callers should pass the
   * SAME scheduler to both fields when both compact and dispatch are wanted.
   */
  scheduler?: SubagentScheduler;
  /**
   * Approval broker (Approval Policy 矩阵). When set, every high-risk tool
   * call (per its `riskClass`) is routed through the broker before execution:
   * it may run silently, run after host-prompted approval, be denied, or be
   * deferred (run then ask on failure). When unset, tools execute with the
   * legacy zero-approval behaviour (backward-compatible).
   */
  approvalBroker?: ApprovalBroker;
  /**
   * Hooks runner (PreEdit / PostEdit / PreCommit / PreBash / PostTool /
   * OnGoalComplete). When set, the session threads it into every tool's
   * {@link ToolExecuteContext} (so write/edit/bash fire their own pre/post
   * hooks), runs `post-tool` after each tool call, and runs `on-goal-complete`
   * when a user turn finishes. Unset → hooks are entirely inert.
   */
  hooks?: HookInvoker;
  /**
   * Session-level approval resolver (Approval Policy 矩阵). When set together
   * with {@link approvalBroker}, approval prompts are driven by the session
   * itself: it yields an `approval_request` event, awaits this resolver for the
   * decision, yields `approval_resolved`, then continues executing the tool
   * in-place. This keeps long-lived transports (serve's SSE stream) open across
   * the user interaction. When unset, the broker's own resolver (if any) drives
   * the prompt; with neither, prompts fail safe to deny.
   */
  approvalResolver?: ApprovalResolver;
  /**
   * MATHRAN.md memory injection (v0.3 §14). When `enabled: true`, the
   * constructor synchronously reads `~/.mathran/MATHRAN.md` (global) and
   * `<workspace>/MATHRAN.md` (project) and prepends a single system message
   * with their concatenated contents BEFORE `opts.systemPrompt`. Order:
   * global → project → systemPrompt (the persona may reference memory).
   *
   * Reads are best-effort: missing or unreadable files are silently skipped.
   * If both files are missing, no memory message is injected.
   */
  memoryFiles?: {
    enabled: boolean;
    /** Defaults to `process.cwd()`. */
    workspace?: string;
  };
  /**
   * Three-layer MATHRAN.md memory injection (C 方案: USER < WORKSPACE <
   * PROJECT). When set, the constructor synchronously loads
   * `~/.mathran/MATHRAN.md`, `<workspace>/MATHRAN.md` and (when `projectSlug`
   * is given) `<workspace>/projects/<slug>/MATHRAN.md`, and prepends their
   * concatenated contents BEFORE the layered skills + persona prompt.
   *
   * This is the layered-config replacement for {@link memoryFiles}; the two
   * are mutually exclusive in practice (callers pick one). Reads are
   * best-effort — missing/unreadable files are silently skipped.
   */
  layeredMemory?: {
    workspace: string;
    projectSlug?: string;
    /** Override `$HOME` for the USER layer (tests). */
    home?: string;
  };
  /**
   * Optional layered skills (loaded via `loadLayeredSkills`) to advertise in
   * the system prompt. Injected AFTER memory and BEFORE the persona prompt as
   * its own system message. Empty / undefined → nothing injected.
   */
  layeredSkills?: ReadonlyArray<LoadedSkill>;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}


/** Per-`send()` options. */
export interface SendOpts {
  /**
   * Cancellation signal. When it fires:
   *   - before the turn starts, `send()` throws `AbortError` immediately and
   *     the history is left untouched;
   *   - mid-stream, the partial assistant text collected so far is committed to
   *     history with an ` [aborted]` marker (so callers can see partial
   *     progress) and `send()` throws `AbortError`;
   *   - between tool calls, any not-yet-executed calls in the round get a
   *     synthetic `[aborted]` tool result so history stays well-formed, then
   *     `send()` throws `AbortError`.
   * The signal is also threaded into the LLM request so providers abort the
   * underlying transport.
   */
  signal?: AbortSignal;
  /**
   * Attachment refs to stash on the user message we're about to push
   * (v0.17 mathub parity). The file contents/markers are already inlined in
   * `userText` by the route handler; this metadata is round-tripped through
   * the JSONL so a tab reload can rebuild the chip strip under the user
   * bubble. Providers ignore the field — see `LLMMessage.attachments`.
   */
  attachments?: Array<{ path: string; filename: string; mimeType: string }>;
  /**
   * v0.17 mathub parity W9 — Live Steering probe.
   *
   * Called at the top of every round inside `runRounds` (BEFORE the
   * LLM request). When the probe returns a non-empty string, the
   * runner:
   *
   *   1. injects a synthetic `{ role: "user", content: "[Steer from
   *      user: …]" }` message into history (so the LLM sees the
   *      steer on the next request AND the persisted jsonl shows it),
   *   2. yields a `{ type: "steer-received", text }` ChatEvent so
   *      the SSE stream forwards it to the SPA.
   *
   * The probe is responsible for clearing whatever underlying queue
   * it pulled from (it's a consume-on-read callback). Errors thrown
   * from the probe propagate; route handlers wrap their own try/catch
   * around `send()` so a bad probe doesn't kill history bookkeeping.
   *
   * Default unset = no steering (CLI / tests are unaffected).
   */
  steerProbe?: () => string | null | undefined;
}

/** Construct the canonical abort error (matches the Fetch/Streams convention). */
function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Stats returned by {@link ChatSession.compact} — the caller (CLI / REST)
 *  surfaces these to the user. */
export interface CompactStats {
  /** Token count of history before compaction. */
  originalTokenCount: number;
  /** Token count of history after compaction. */
  newTokenCount: number;
  /** Number of complete user-rooted rounds dropped from the middle. */
  droppedRoundCount: number;
  /** True when the call was a no-op (nothing to compact). */
  noop: boolean;
  /** Truthy warning string when compaction failed to drop the token count
   *  below the threshold (relevant for auto-compact loops). Absent on success. */
  warning?: string;
}

/** True when `err` is an AbortError (DOMException or a plain `.name` carrier). */
function isAbortError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: string }).name === "AbortError";
}

/**
 * Iterate `iterable`, but reject with `AbortError` as soon as `signal` fires —
 * even while we are parked awaiting the next chunk. The underlying iterator is
 * best-effort cancelled (`return()`) on exit so providers can release sockets.
 */
async function* iterateWithAbort<T>(
  iterable: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  if (!signal) {
    yield* iterable;
    return;
  }
  if (signal.aborted) throw abortError();
  const iter = iterable[Symbol.asyncIterator]();
  let onAbort!: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const res = await Promise.race([iter.next(), abortPromise]);
      if (res.done) return;
      yield res.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Best-effort cancel of the underlying iterator. We must NOT await it: a
    // provider parked on a never-settling promise would make `return()` hang
    // too. Real fetch/SDK iterators settle once the transport is aborted.
    const ret = iter.return?.();
    if (ret && typeof (ret as Promise<unknown>).then === "function") {
      (ret as Promise<unknown>).then(
        () => {},
        () => {},
      );
    }
  }
}

export class ChatSession {
  private readonly llm: LLMProvider;
  private readonly tools: ToolSpec[];
  private readonly toolByName: Map<string, ToolSpec>;
  private readonly maxToolRounds: number;
  readonly model?: string;
  private temperature?: number;
  private maxTokens?: number;
  private readonly toolContext?: ToolExecuteContext;
  readonly sessionId: string;
  private readonly toolOutputCap?: { maxInlineBytes?: number; workspace?: string | null };
  private readonly autoCompactCfg?: ChatSessionOptions["autoCompact"];
  private readonly workspace?: string;
  private readonly subagentScheduler?: SubagentScheduler;
  /**
   * v0.5 wire-up: separate scheduler reference used by the
   * `dispatch_subagent` builtin tool. Holds the SAME instance as
   * `subagentScheduler` for production callers (which pass one scheduler in
   * both fields), but kept distinct so test harnesses can wire only the
   * dispatch surface without picking up compact's lazy-init defaults.
   */
  private readonly dispatchScheduler?: SubagentScheduler;
  /** v0.5 §7 — absolute paths read this session (read-before-write gate). */
  private readonly readPaths = new Set<string>();
  private readonly builtinToolsCfg?: ChatSessionOptions["builtinTools"];
  /** Approval broker (Approval Policy 矩阵). Optional; gates high-risk tools. */
  private readonly approvalBroker?: ApprovalBroker;
  /** Hooks runner (PreEdit/PostEdit/PreCommit/PreBash/PostTool/OnGoalComplete). */
  private readonly hookInvoker?: HookInvoker;
  /** Session-level approval resolver (yield-based prompt driver). */
  private readonly approvalResolver?: ApprovalResolver;
  /** Promise of an in-flight compact() — second concurrent caller awaits it. */
  private compactInFlight: Promise<CompactStats> | null = null;
  private messages: LLMMessage[] = [];

  constructor(opts: ChatSessionOptions) {
    this.llm = opts.llm;
    this.model = opts.model;
    this.tools = opts.tools ?? [];
    this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
    // Tool-call round cap. Default raised from 8 → 50 (v0.12.x).
    //
    // Background: at 8 rounds, LLM doing legitimate multi-step exploration
    // (e.g. reading a multi-thousand-line file via `sed` slices because
    // `read_file` is still un-paged) gets cut off mid-task with
    // "tool-call budget exhausted". Claude Code has no equivalent hard cap;
    // it bounds tool *output* (25K tokens per result, 100K total) and lets
    // the LLM loop freely. v0.13 will follow that approach (paged read_file
    // + per-result token cap) so this number becomes a runaway safety net,
    // not a routine limit.
    this.maxToolRounds = opts.maxToolRounds ?? 50;
    this.temperature = opts.temperature;
    this.maxTokens = opts.maxTokens;
    this.toolContext = opts.toolContext;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.toolOutputCap = opts.toolOutputCap;
    this.autoCompactCfg = opts.autoCompact;
    this.workspace = opts.workspace;
    this.subagentScheduler = opts.subagentScheduler;
    // v0.5 wire-up: prefer `opts.scheduler` for the dispatch tool, but fall
    // back to `opts.subagentScheduler` so production callers that already
    // pass the latter (for compact) automatically get dispatch too.
    this.dispatchScheduler = opts.scheduler ?? opts.subagentScheduler;
    this.builtinToolsCfg = opts.builtinTools;
    this.approvalBroker = opts.approvalBroker;
    this.approvalResolver = opts.approvalResolver;
    this.hookInvoker = opts.hooks;
    // Mix in built-in tools (v0.2 §9+). Order: built-ins first, then caller's
    // tools (so a caller-supplied tool with the same name wins via the
    // `toolByName` map's last-write).
    const builtins = this.buildBuiltinTools();
    if (builtins.length > 0) {
      this.tools = [...builtins, ...this.tools];
      this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
    }
    // v0.3 §14: prepend MATHRAN.md memory (global → project) BEFORE the
    // persona system prompt. Reads are sync (tiny files) and never throw —
    // any error makes the section disappear silently.
    if (opts.memoryFiles?.enabled) {
      try {
        const memWorkspace = opts.memoryFiles.workspace ?? process.cwd();
        const mem = loadMathranMemorySync({ workspace: memWorkspace });
        const fragment = formatMathranMemory(mem);
        if (fragment.length > 0) {
          this.messages.push({ role: "system", content: fragment });
        }
      } catch {
        // Defense-in-depth: loadMathranMemorySync swallows IO errors itself
        // but constructors must NEVER throw. Belt-and-suspenders.
      }
    }

    // v0.16 §C 方案: three-layer MATHRAN.md (USER < WORKSPACE < PROJECT) as
    // the layered-config replacement for `memoryFiles`. Same placement
    // (before skills + persona) and same best-effort, never-throw contract.
    if (opts.layeredMemory) {
      try {
        const mem = loadLayeredMathranMemorySync({
          workspace: opts.layeredMemory.workspace,
          ...(opts.layeredMemory.projectSlug
            ? { projectSlug: opts.layeredMemory.projectSlug }
            : {}),
          ...(opts.layeredMemory.home ? { home: opts.layeredMemory.home } : {}),
        });
        const fragment = formatLayeredMathranMemory(mem);
        if (fragment.length > 0) {
          this.messages.push({ role: "system", content: fragment });
        }
      } catch {
        // constructors must NEVER throw.
      }
    }

    // v0.16 §C 方案: advertise layered skills (PROJECT > WORKSPACE > USER) as
    // a system fragment, after memory and before the persona prompt. Never
    // throws; an empty list injects nothing.
    if (opts.layeredSkills && opts.layeredSkills.length > 0) {
      try {
        const skillsFragment = formatSkillsForPrompt(opts.layeredSkills);
        if (skillsFragment.length > 0) {
          this.messages.push({ role: "system", content: skillsFragment });
        }
      } catch {
        // constructors must NEVER throw.
      }
    }

    if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
      this.messages.push({ role: "system", content: opts.systemPrompt });
    }

  }

  /** Current conversation history (read-only copy). */
  history(): LLMMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /** Clear history, keeping any leading system prompt(s). */
  reset(): void {
    const leading = this.collectLeadingSystemMessages();
    this.messages = leading.map((m) => ({ ...m }));
  }

  /**
   * Replace the in-memory history with a hydrated copy (used by the disk-
   * backed `ScopedChatSessionStore` during session re-hydration on first
   * access after a process restart).
   *
   * Behavior:
   *   - If `next` contains a leading `system` message, it is used verbatim.
   *   - Otherwise the session's existing leading system prompt(s) are
   *     preserved and `next` is appended after them. v0.3 §14 may inject
   *     multiple leading system messages (memory + persona); all are kept.
   */
  replaceHistory(next: LLMMessage[]): void {
    // Conversation context changed — invalidate read-before-write tracking.
    this.readPaths.clear();
    if (next.length > 0 && next[0].role === "system") {
      this.messages = next.map((m) => ({ ...m }));
      return;
    }
    const leading = this.collectLeadingSystemMessages();
    this.messages = [
      ...leading.map((m) => ({ ...m })),
      ...next.map((m) => ({ ...m })),
    ];
  }

  /** All consecutive system messages at the start of {@link messages}. */
  private collectLeadingSystemMessages(): LLMMessage[] {
    const out: LLMMessage[] = [];
    for (const m of this.messages) {
      if (m.role !== "system") break;
      out.push(m);
    }
    return out;
  }

  // ─── Compact (v0.2 §5) ────────────────────────────────────────────────────

  // ─── Built-in tools (v0.2 §9+) ──────────────────────────────────

  /**
   * Build the list of ChatSession-owned built-in tool specs based on
   * `opts.builtinTools`. Currently produces:
   *
   *   - `read_file_summary` (Task 9) — dispatches `read_summarize` to a
   *     subagent runner. Returns the runner's summary text + a link to the
   *     cached source artifact. Silently a no-op if the caller didn't enable
   *     it; never throws during construction.
   *
   * Tool `execute()` failures (path escape, file-not-found, LLM error) come
   * back as `{ ok: false, content: <human msg> }` instead of throwing, so the
   * model can see the error in a tool result and try a different path.
   */
  private buildBuiltinTools(): ToolSpec[] {
    const cfg = this.builtinToolsCfg;
    if (!cfg) return [];
    const out: ToolSpec[] = [];
    if (cfg.search) {
      out.push(this.makeSearchTool());
    }
    if (cfg.read_file_summary) {
      out.push(this.makeReadFileSummaryTool());
    }
    // v0.4 §1 filesystem & shell tools. These are workspace-scoped: each
    // tool gets `this.workspace` baked in at construction time so escape
    // checks can be done with `path.relative`. When `workspace` is unset the
    // tool falls back to `ctx.workspace` and finally `process.cwd()`.
    if (cfg.bash) {
      out.push(
        createBashTool(this.workspace ? { workspace: this.workspace } : {}),
      );
    }
    if (cfg.read_file) {
      out.push(
        createReadFileTool(this.workspace ? { workspace: this.workspace } : {}),
      );
    }
    if (cfg.write_file) {
      out.push(
        createWriteFileTool(this.workspace ? { workspace: this.workspace } : {}),
      );
    }
    if (cfg.edit_file) {
      out.push(
        createEditFileTool(this.workspace ? { workspace: this.workspace } : {}),
      );
    }
    // v0.5 wire-up Gap #4 + #5: generic dispatch tool. Requires a scheduler
    // to be wired (callers that opt in but forget to pass one get a console
    // warning + silent skip, never a crash).
    if (cfg.dispatch_subagent) {
      if (this.dispatchScheduler) {
        out.push(
          createDispatchSubagentTool({ scheduler: this.dispatchScheduler }),
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "[mathran] ChatSession builtinTools.dispatch_subagent enabled but no `scheduler` provided; skipping.",
        );
      }
    }
    // v0.16 §11: per-host `ask_user` resolver. The factory injects the
    // host's resolver (CLI: readline; serve: throw `AskUserPending`;
    // goal: canned reply). Tool description / schema is host-agnostic so
    // the model sees the same affordance everywhere.
    if (cfg.ask_user && cfg.ask_user.resolver) {
      out.push(createAskUserTool({ resolver: cfg.ask_user.resolver }));
    }
    // v0.17 follow-up: propose_goal. Same resolver pattern as ask_user so
    // the SPA's existing confirmation UI is reused. The tool itself does
    // the createGoal write on confirm; serve.ts watches for tool-result
    // name=propose_goal and emits a `goal-proposed` SSE frame.
    if (cfg.propose_goal && cfg.propose_goal.resolver) {
      out.push(
        createProposeGoalTool({
          resolver: cfg.propose_goal.resolver,
          workspace: cfg.propose_goal.workspace,
          scope: cfg.propose_goal.scope,
          model: cfg.propose_goal.model,
          autoRunner: cfg.propose_goal.autoRunner,
        }),
      );
    }
    if (cfg.propose_plan && cfg.propose_plan.resolver) {
      out.push(
        createProposePlanTool({
          resolver: cfg.propose_plan.resolver,
          workspace: cfg.propose_plan.workspace,
          model: cfg.propose_plan.model,
          autoRunner: cfg.propose_plan.autoRunner,
        }),
      );
    }
    return out;
  }

  /**
   * Run a tool through the approval broker (Approval Policy 矩阵), then execute
   * it (or not) per the verdict. An async generator: it yields `approval_request`
   * / `approval_resolved` events around any user prompt and **returns** the tool
   * result the loop feeds back to the model (consume via `yield*`). When no
   * broker is wired, or the tool carries no `riskClass`, this is a thin
   * pass-through to `tool.execute` (legacy zero-approval behaviour).
   *
   * Prompts are driven by the session-level {@link approvalResolver} when set
   * (yield-based, keeps serve's SSE stream open); otherwise the broker's own
   * resolver drives them (CLI/tests). With neither, prompts fail safe to deny.
   */
  private async *executeWithApproval(
    tool: ToolSpec,
    call: { id: string; name: string },
    parsed: Record<string, unknown>,
    callCtx: ToolExecuteContext,
  ): AsyncGenerator<ChatEvent, { ok: boolean; content: string }, void> {
    const broker = this.approvalBroker;
    if (!broker || !tool.riskClass) {
      return await tool.execute(parsed, callCtx);
    }
    const authCall = {
      tool: call.name,
      riskClass: tool.riskClass,
      args: parsed,
      id: call.id,
    };

    // When no session-level resolver is wired, defer entirely to the broker's
    // own resolver (CLI/tests) — no event yielding needed.
    if (!this.approvalResolver) {
      const auth = await broker.authorize(authCall);
      if (auth.kind === "deny") {
        return {
          ok: false,
          content: `⛔ tool call denied by approval policy: ${auth.reason}`,
        };
      }
      if (auth.kind === "allow") {
        return await tool.execute(parsed, callCtx);
      }
      return yield* this.runDeferOnFailure(tool, authCall, parsed, callCtx, null);
    }

    // Session-driven (yield-based) prompt flow.
    const resolver = this.approvalResolver;
    const pre = await broker.preCheck(authCall);
    if (pre.kind === "deny") {
      return {
        ok: false,
        content: `⛔ tool call denied by approval policy: ${pre.reason}`,
      };
    }
    if (pre.kind === "allow") {
      return await tool.execute(parsed, callCtx);
    }
    if (pre.kind === "defer-on-failure") {
      return yield* this.runDeferOnFailure(tool, authCall, parsed, callCtx, resolver);
    }
    // pre.kind === "ask": surface the request, await the decision, continue.
    yield { type: "approval_request", request: pre.request };
    const decision = await resolver(pre.request);
    yield { type: "approval_resolved", id: pre.request.id, decision };
    const verdict = await broker.resolveDecision(authCall, decision);
    if (verdict.kind === "deny") {
      return {
        ok: false,
        content: `⛔ tool call denied by approval policy: ${verdict.reason}`,
      };
    }
    if (verdict.kind === "defer-on-failure") {
      return yield* this.runDeferOnFailure(tool, authCall, parsed, callCtx, resolver);
    }
    return await tool.execute(parsed, callCtx);
  }

  /**
   * `on-failure` policy: run the tool, then on failure ask retry/abandon. When
   * `resolver` is set, prompts are yield-based (serve); otherwise the broker's
   * own resolver drives them (CLI/tests).
   */
  private async *runDeferOnFailure(
    tool: ToolSpec,
    authCall: {
      tool: string;
      riskClass: RiskClass;
      args: Record<string, unknown>;
      id: string;
    },
    parsed: Record<string, unknown>,
    callCtx: ToolExecuteContext,
    resolver: ApprovalResolver | null,
  ): AsyncGenerator<ChatEvent, { ok: boolean; content: string }, void> {
    const broker = this.approvalBroker!;
    let result = await tool.execute(parsed, callCtx);
    let guard = 0;
    const MAX_RETRIES = 5;
    while (!result.ok && guard < MAX_RETRIES) {
      let failure;
      if (resolver) {
        const request = broker.buildFailureRequest(authCall, result.content);
        yield { type: "approval_request", request };
        const decision = await resolver(request);
        yield { type: "approval_resolved", id: request.id, decision };
        failure = broker.applyFailureDecision(decision);
      } else {
        failure = await broker.onFailure(authCall, result.content);
      }
      if (failure.kind === "retry") {
        result = await tool.execute(parsed, callCtx);
        guard++;
        continue;
      }
      return {
        ok: false,
        content: `⛔ tool failed and the user abandoned it: ${failure.reason}\n\n--- original failure ---\n${result.content}`,
      };
    }
    return result;
  }

  private makeSearchTool(): ToolSpec {
    const self = this;
    return {
      name: "search",
      riskClass: "read",
      description:
        "Search the workspace for a pattern. Use this when looking for code, text, or files. Returns top files and counts; full results are stored in an artifact.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Pattern to search for (literal text).",
          },
          glob: {
            type: "string",
            description: "Optional file glob, e.g. **/*.ts",
          },
          caseInsensitive: {
            type: "boolean",
            description: "If true, the match is case-insensitive.",
          },
        },
        required: ["query"],
      },
      async execute(args: Record<string, unknown>) {
        const query = typeof args.query === "string" ? args.query : "";
        const glob = typeof args.glob === "string" ? args.glob : undefined;
        const caseInsensitive =
          typeof args.caseInsensitive === "boolean" ? args.caseInsensitive : undefined;
        try {
          const sched = self.getOrBuildScheduler();
          const result = await sched.dispatch({
            type: "search",
            input: {
              query,
              ...(glob !== undefined ? { globPattern: glob } : {}),
              ...(caseInsensitive !== undefined ? { caseInsensitive } : {}),
            },
            hardCapBytes: 2048,
          });
          if (result.status === "error" || result.status === "timeout") {
            return {
              ok: false,
              content: `search failed (${result.status}): ${result.errorMessage ?? "unknown error"}`,
            };
          }
          return { ok: true, content: result.summary };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, content: `search error: ${msg}` };
        }
      },
    };
  }

  /**
   * Construct the `read_file_summary` ToolSpec. The closure captures `this`
   * so the tool can lazily resolve `getOrBuildScheduler()` at call time —
   * matches the compact lazy-init pattern.
   */
  private makeReadFileSummaryTool(): ToolSpec {
    const self = this;
    return {
      name: "read_file_summary",
      riskClass: "read",
      description:
        "Read a file and get a focused summary answering your question. " +
        "Use this for long files where you only need specific information. " +
        "Returns summary text and a link to the cached source.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to workspace",
          },
          question: {
            type: "string",
            description: "What you want to know from the file",
          },
        },
        required: ["path", "question"],
      },
      async execute(args: Record<string, unknown>) {
        const filePath = typeof args.path === "string" ? args.path : "";
        const question = typeof args.question === "string" ? args.question : "";
        if (!filePath) {
          return { ok: false, content: "error: read_file_summary requires 'path'" };
        }
        if (!question) {
          return {
            ok: false,
            content: "error: read_file_summary requires 'question'",
          };
        }
        try {
          const sched = self.getOrBuildScheduler();
          const result = await sched.dispatch({
            type: "read_summarize",
            input: {
              path: filePath,
              question,
              llm: self.llm,
              modelHint: self.model,
            } as unknown as Record<string, unknown>,
            hardCapBytes: 2048,
          });
          if (result.status !== "ok") {
            // Surface the error text directly to the model so it can recover
            // (try a different path, ask for help, etc.). Don't throw.
            const reason =
              result.summary || result.errorMessage || `status=${result.status}`;
            return { ok: false, content: `read_file_summary error: ${reason}` };
          }
          const link = result.artifactPath
            ? `\n\nFull source cached at: ${result.artifactPath}`
            : "";
          return { ok: true, content: result.summary + link };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, content: `read_file_summary error: ${msg}` };
        }
      },
    };
  }

  /** Resolve (or lazily build) the scheduler used for compact dispatch. */
  private getOrBuildScheduler(): SubagentScheduler {
    if (this.subagentScheduler) return this.subagentScheduler;
    const registry = new SubagentRegistry();
    registry.register(compactRunner);
    registry.register(searchRunner);
    registry.register(readSummarizeRunner);
    // Workspace: prefer user-provided; otherwise use process.cwd() as a sane
    // default (artifacts land under <cwd>/.mathran/subagents/<runId>/).
    const ws = this.workspace ?? process.cwd();
    return new SubagentScheduler({ workspace: ws, registry });
  }

  /**
   * Compact the current history via the `compact` subagent runner. Always
   * preserves the leading system message; drops the middle chunk in favor of
   * a single summary `role:"system"` message; keeps the last
   * `keepRecentRounds` user-rooted rounds verbatim.
   *
   * Concurrent calls await the first in-flight compaction.
   */
  async compact(opts?: { keepRecentRounds?: number }): Promise<CompactStats> {
    if (this.compactInFlight) return this.compactInFlight;
    this.compactInFlight = this.compactImpl(opts).finally(() => {
      this.compactInFlight = null;
    });
    return this.compactInFlight;
  }

  private async compactImpl(opts?: { keepRecentRounds?: number }): Promise<CompactStats> {
    const sched = this.getOrBuildScheduler();
    const cfg = this.autoCompactCfg;
    const keepRecentRounds =
      opts?.keepRecentRounds ??
      cfg?.keepRecentRounds ??
      DEFAULT_KEEP_RECENT_ROUNDS;
    const contextWindow = cfg?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

    const input: CompactRunnerInput = {
      messages: this.messages.map((m) => ({ ...m })),
      contextWindow,
      keepRecentRounds,
      modelHint: this.model,
      llm: this.llm,
    };

    const result = await sched.dispatch({
      type: "compact",
      input: input as unknown as Record<string, unknown>,
    });

    if (result.status !== "ok" || !result.artifactPath) {
      throw new Error(
        `compact failed: ${result.status}${
          result.errorMessage ? ": " + result.errorMessage : ""
        }`,
      );
    }

    // Read the artifact and swap messages.
    const ws = this.workspace ?? process.cwd();
    const relative = result.artifactPath;
    // artifactPath is POSIX-style relative to workspace, of the form
    // `.mathran/subagents/<runId>/compacted.json`. Recover runId + filename to
    // call readArtifact (which already knows the layout).
    const segs = relative.split("/");
    const filename = segs[segs.length - 1];
    const runId = segs[segs.length - 2];
    let raw: string;
    try {
      raw = await readArtifact(ws, runId, filename);
    } catch {
      // Fallback: read directly via path.join.
      raw = await (await import("node:fs/promises")).readFile(
        path.join(ws, relative),
        "utf8",
      );
    }
    const artifact = JSON.parse(raw) as CompactedArtifact;

    if (!artifact.noop) {
      this.messages = artifact.newMessages.map((m) => ({ ...m }));
    }

    const stats: CompactStats = {
      originalTokenCount: artifact.originalTokenCount,
      newTokenCount: artifact.newTokenCount,
      droppedRoundCount: artifact.droppedRoundCount,
      noop: artifact.noop,
    };
    // Surface a warning if we still exceed the threshold after compaction,
    // so the caller / auto-compact loop doesn't infinitely re-trigger.
    if (cfg && !artifact.noop) {
      const thresholdPct = cfg.thresholdPct ?? 0.75;
      const limit = contextWindow * thresholdPct;
      if (artifact.newTokenCount > limit) {
        stats.warning = `compacted history (${artifact.newTokenCount} tok) still exceeds threshold (${Math.round(
          limit,
        )} tok); will not re-compact this turn`;
      }
    }
    return stats;
  }

  /**
   * Auto-compact pre-check (v0.2 §5). Called once at the start of {@link send}
   * when `autoCompact.enabled` is true. Silent no-op when the provider can't
   * count tokens, or when the count is under the configured threshold.
   */
  private async maybeAutoCompact(): Promise<void> {
    const cfg = this.autoCompactCfg;
    if (!cfg?.enabled) return;
    const llm = this.llm as LLMProvider & { countTokens?: (m: LLMMessage[]) => number };
    if (typeof llm.countTokens !== "function") return;
    let count: number;
    try {
      count = llm.countTokens(this.messages);
    } catch {
      return; // never crash the send path due to counting errors
    }
    if (typeof count !== "number" || !Number.isFinite(count)) return;
    const window = cfg.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const threshold = window * (cfg.thresholdPct ?? 0.75);
    if (count <= threshold) return;
    try {
      await this.compact();
    } catch {
      // Swallow: auto-compact must never block the user's send.
    }
  }

  /**
   * Run one user turn. Streams text/tool events; resolves the conversation by
   * looping through tool calls until the model stops requesting them.
   */
  async *send(userText: string, opts: SendOpts = {}): AsyncIterable<ChatEvent> {
    const signal = opts.signal;
    // Abort before we touch history: leave `messages` untouched and bail.
    if (signal?.aborted) throw abortError();

    // Auto-compact pre-check (v0.2 §5): compact BEFORE we push the new user
    // message, so we don't immediately discard it. Silent on failure.
    await this.maybeAutoCompact();

    this.messages.push(
      opts.attachments && opts.attachments.length > 0
        ? { role: "user", content: userText, attachments: opts.attachments }
        : { role: "user", content: userText },
    );

    yield* this.runRounds(opts);
  }

  /**
   * Resume the LLM loop *without* pushing a new user message (v0.16 §11).
   *
   * Use this after the caller has mutated `messages` in place — the
   * canonical case is the serve `/answer-ask` endpoint patching the
   * placeholder tool result for a pending `ask_user` call to the user's
   * reply, then resuming the same round.
   *
   * Skips both auto-compact (the in-place mutation just happened; we'd
   * lose the freshly-patched tool result) and the user-message push
   * (resume callers continue mid-round, not at a turn boundary).
   * Otherwise identical to `send` — same tool-call loop, same event
   * stream, same abort handling.
   */
  async *resume(opts: SendOpts = {}): AsyncIterable<ChatEvent> {
    const signal = opts.signal;
    if (signal?.aborted) throw abortError();
    yield* this.runRounds(opts);
  }

  /**
   * Internal shared loop body used by both `send` and `resume`. Keeping
   * the tool-call round-trip + provider-validation invariants in one
   * place means adding new entry points (resume, slash-command-driven
   * LLM call, …) doesn't drift on history bookkeeping.
   */
  /** The text of the most recent user message (for on-goal-complete). */
  private lastUserText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "user" && typeof m.content === "string") return m.content;
    }
    return "";
  }

  private async *runRounds(opts: SendOpts): AsyncIterable<ChatEvent> {
    const signal = opts.signal;
    const steerProbe = opts.steerProbe;

    for (let round = 0; round <= this.maxToolRounds; round++) {
      // Abort between rounds (history is well-formed here: every prior
      // assistant tool-call has a paired tool result).
      if (signal?.aborted) throw abortError();

      // v0.17 mathub parity W9 — Live Steering. Probe BEFORE we build
      // the LLM request so the steered user message is part of `messages`
      // when we ship the next request, AND so the persisted history
      // (history() = this.messages) shows the steer between rounds. The
      // probe is consume-on-read: if it returns a non-empty string, we
      // own it. The synthetic user message is intentionally a plain
      // text turn (no tool_calls) so provider validation stays happy at
      // any round-boundary (after an assistant message with no tool
      // calls, or after a tool result from the previous round). Errors
      // from the probe propagate — a misbehaving server callback should
      // fail loudly, not silently swallow user input.
      if (steerProbe) {
        const steered = steerProbe();
        if (typeof steered === "string" && steered.length > 0) {
          this.messages.push({
            role: "user",
            content: `[Steer from user: ${steered}]`,
          });
          yield { type: "steer-received", text: steered };
        }
      }

      const req: LLMRequest = {
        messages: this.messages.map((m) => ({ ...m })),
        model: this.model ?? "",
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
        ...(signal ? { signal } : {}),
        ...(this.tools.length > 0
          ? {
              tools: this.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            }
          : {}),
      };

      const response = await this.llm.chat(req);

      let text = "";
      let finishReason: Extract<LLMStreamChunk, { type: "done" }>["finishReason"] = "stop";
      const callOrder: string[] = [];
      const calls = new Map<string, PendingToolCall>();

      try {
        for await (const chunk of iterateWithAbort(response.stream(), signal)) {
          if (chunk.type === "text") {
            text += chunk.delta;
            yield { type: "text", delta: chunk.delta };
          } else if (chunk.type === "tool-call") {
            const key = chunk.id || chunk.name || `call_${callOrder.length}`;
            let pending = calls.get(key);
            if (!pending) {
              pending = { id: chunk.id || key, name: chunk.name, args: "" };
              calls.set(key, pending);
              callOrder.push(key);
            }
            if (chunk.name) pending.name = chunk.name;
            if (chunk.id) pending.id = chunk.id;
            pending.args += chunk.argsDelta;
          } else if (chunk.type === "done") {
            finishReason = chunk.finishReason;
          }
        }
      } catch (err) {
        if (isAbortError(err)) {
          // Commit the partial assistant text so the user/goal can see how far
          // we got. We deliberately drop any half-streamed tool calls: the
          // assistant message carries no `toolCalls`, so history stays
          // well-formed (no dangling tool_call awaiting a tool result).
          this.messages.push({
            role: "assistant",
            content: text.length > 0 ? `${text} [aborted]` : "[aborted]",
          });
        }
        throw err;
      }

      const toolCalls = callOrder
        .map((k) => calls.get(k)!)
        .filter((c) => c.name && c.name.length > 0);

      // Record the assistant turn. We must persist `toolCalls` alongside the
      // text so the next request to the LLM can echo them back in the
      // provider-specific shape (OpenAI `tool_calls`, Anthropic `tool_use`,
      // …). Without this the assistant message paired with the tool result
      // looks malformed and OpenAI / Anthropic / Azure will reject it.
      const assistantMessage: LLMMessage = { role: "assistant", content: text };
      if (toolCalls.length > 0) {
        assistantMessage.toolCalls = toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.args,
        }));
      }
      this.messages.push(assistantMessage);

      if (toolCalls.length === 0) {
        // on-goal-complete hooks — the model finished the user's request this
        // turn. Only fired when such hooks exist (zero-cost otherwise) so a
        // plain chat turn doesn't spawn processes. Non-blocking.
        if (this.hookInvoker && this.hookInvoker.hooksForType("on-goal-complete").length > 0) {
          const done = await this.hookInvoker.run("on-goal-complete", {
            goalText: this.lastUserText(),
          });
          if (done.summary) {
            this.messages.push({ role: "system", content: done.summary });
          }
        }
        yield { type: "done", finishReason };
        return;
      }

      if (round === this.maxToolRounds) {
        // Out of tool budget: emit the calls + a synthetic tool result for
        // each so the conversation history stays well-formed (every assistant
        // tool_call must be paired with a tool message). This way a future
        // `send()` on the same session will not blow up provider validation.
        for (const call of toolCalls) {
          yield { type: "tool-call", id: call.id, name: call.name, args: call.args };
          const message =
            "error: tool-call budget exhausted (maxToolRounds=" + this.maxToolRounds + ")";
          this.messages.push({
            role: "tool",
            content: message,
            toolCallId: call.id,
            name: call.name,
          });
          yield {
            type: "tool-result",
            id: call.id,
            name: call.name,
            ok: false,
            content: message,
          };
        }
        yield { type: "done", finishReason };
        return;
      }

      for (let ci = 0; ci < toolCalls.length; ci++) {
        const call = toolCalls[ci];
        // Abort between tool calls: keep history well-formed by closing every
        // remaining (un-executed) call with a synthetic `[aborted]` tool
        // result, then surface the AbortError to the caller.
        if (signal?.aborted) {
          for (let ri = ci; ri < toolCalls.length; ri++) {
            const pending = toolCalls[ri];
            this.messages.push({
              role: "tool",
              content: "[aborted]",
              toolCallId: pending.id,
              name: pending.name,
            });
          }
          throw abortError();
        }

        yield { type: "tool-call", id: call.id, name: call.name, args: call.args };

        const tool = this.toolByName.get(call.name);
        let result: { ok: boolean; content: string };
        if (!tool) {
          result = { ok: false, content: `error: unknown tool "${call.name}"` };
        } else {
          let parsed: Record<string, unknown> = {};
          let parseFailed = false;
          try {
            parsed = call.args.trim().length > 0 ? JSON.parse(call.args) : {};
          } catch {
            parseFailed = true;
            result = {
              ok: false,
              content: `error: invalid JSON arguments for tool "${call.name}": ${call.args}`,
            };
          }
          if (!parseFailed) {
            try {
              const callCtx: ToolExecuteContext = {
                ...this.toolContext,
                toolCallId: call.id,
                ...(this.hookInvoker ? { hooks: this.hookInvoker } : {}),
                recordRead: (p: string) =>
                  this.readPaths.add(
                    path.isAbsolute(p)
                      ? p
                      : path.resolve(this.workspace ?? "", p),
                  ),
                hasRead: (p: string) =>
                  this.readPaths.has(
                    path.isAbsolute(p)
                      ? p
                      : path.resolve(this.workspace ?? "", p),
                  ),
              };
              result = yield* this.executeWithApproval(
                tool,
                call,
                parsed,
                callCtx,
              );
            } catch (err: any) {
              if (isAskUserPending(err)) {
                // v0.16 §11: bail out of the LLM loop so the serve route can
                // persist a `pendingAsk` annotation and end the SSE stream.
                // Before re-throwing we must keep history well-formed: every
                // assistant `tool_call` MUST be paired with a tool message,
                // otherwise the next provider call rejects the conversation.
                // Push a placeholder tool message for this call (the resume
                // endpoint patches its content to the user's reply) AND for
                // any not-yet-executed tool calls in the same batch — closing
                // the batch is the only way to satisfy provider validation
                // when we abort mid-loop.
                this.messages.push({
                  role: "tool",
                  content: ASK_USER_PENDING_PLACEHOLDER,
                  toolCallId: call.id,
                  name: call.name,
                });
                for (let ri = ci + 1; ri < toolCalls.length; ri++) {
                  const pending = toolCalls[ri];
                  this.messages.push({
                    role: "tool",
                    content: "[skipped: prior ask_user pending]",
                    toolCallId: pending.id,
                    name: pending.name,
                  });
                }
                yield {
                  type: "ask_user",
                  id: call.id,
                  name: call.name,
                  question: (err as AskUserPending).question,
                };
                throw err;
              }
              result = { ok: false, content: `error: ${err?.message ?? String(err)}` };
            }
          } else {
            result = result!;
          }
        }

        let inlineContent = result.content;
        if (this.toolOutputCap) {
          const capped = await capToolOutput(call.id, result.content, {
            maxInlineBytes: this.toolOutputCap.maxInlineBytes ?? 4096,
            workspace: this.toolOutputCap.workspace ?? null,
            sessionId: this.sessionId,
          });
          inlineContent = capped.inlineContent;
        }

        this.messages.push({
          role: "tool",
          content: inlineContent,
          toolCallId: call.id,
          name: call.name,
        });
        yield {
          type: "tool-result",
          id: call.id,
          name: call.name,
          ok: result.ok,
          content: result.content,
        };

        // post-tool hooks — fire after every tool call (non-blocking). Their
        // output is injected as a system message so the model sees what the
        // hook did without polluting the tool_call/tool_result pairing.
        if (this.hookInvoker) {
          const post = await this.hookInvoker.run("post-tool", {
            toolName: call.name,
          });
          if (post.summary) {
            this.messages.push({ role: "system", content: post.summary });
          }
        }
      }
      // Loop again so the model can react to the tool results.
    }
  }
}
