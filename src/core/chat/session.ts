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
import { SubagentRegistry } from "../subagent/registry.js";
import { SubagentScheduler } from "../subagent/scheduler.js";
import { readArtifact } from "../subagent/artifact.js";
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
}

/** A tool the model can invoke. Parameters are a JSON-schema object. */
export interface ToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
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
   * Built-in tools that ChatSession exposes to the LLM (v0.2 §9+). Each flag
   * is opt-in; when enabled, the tool is mixed into `tools` ahead of any
   * caller-supplied entries. Built-in tools require `subagentScheduler` to be
   * wired (production code) or the lazy scheduler from `getOrBuildScheduler`
   * (tests) — when the requirement is unmet, the tool is silently dropped to
   * keep this purely additive.
   *
   * - `read_file_summary` — dispatches the `read_summarize` runner.
   */
  builtinTools?: {
    read_file_summary?: boolean;
  };
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
  private readonly builtinToolsCfg?: ChatSessionOptions["builtinTools"];
  /** Promise of an in-flight compact() — second concurrent caller awaits it. */
  private compactInFlight: Promise<CompactStats> | null = null;
  private messages: LLMMessage[] = [];

  constructor(opts: ChatSessionOptions) {
    this.llm = opts.llm;
    this.model = opts.model;
    this.tools = opts.tools ?? [];
    this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
    this.maxToolRounds = opts.maxToolRounds ?? 8;
    this.temperature = opts.temperature;
    this.maxTokens = opts.maxTokens;
    this.toolContext = opts.toolContext;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.toolOutputCap = opts.toolOutputCap;
    this.autoCompactCfg = opts.autoCompact;
    this.workspace = opts.workspace;
    this.subagentScheduler = opts.subagentScheduler;
    this.builtinToolsCfg = opts.builtinTools;
    // Mix in built-in tools (v0.2 §9+). Order: built-ins first, then caller's
    // tools (so a caller-supplied tool with the same name wins via the
    // `toolByName` map's last-write).
    const builtins = this.buildBuiltinTools();
    if (builtins.length > 0) {
      this.tools = [...builtins, ...this.tools];
      this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
    }
    if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
      this.messages.push({ role: "system", content: opts.systemPrompt });
    }
  }

  /** Current conversation history (read-only copy). */
  history(): LLMMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /** Clear history, keeping any leading system prompt. */
  reset(): void {
    const system = this.messages.find((m) => m.role === "system");
    this.messages = system ? [{ ...system }] : [];
  }

  /**
   * Replace the in-memory history with a hydrated copy (used by the disk-
   * backed `ScopedChatSessionStore` during session re-hydration on first
   * access after a process restart).
   *
   * Behavior:
   *   - If `next` contains a leading `system` message, it is used verbatim.
   *   - Otherwise the session's existing system prompt (if any) is preserved
   *     and `next` is appended after it.
   */
  replaceHistory(next: LLMMessage[]): void {
    if (next.length > 0 && next[0].role === "system") {
      this.messages = next.map((m) => ({ ...m }));
      return;
    }
    const system = this.messages.find((m) => m.role === "system");
    this.messages = system
      ? [{ ...system }, ...next.map((m) => ({ ...m }))]
      : next.map((m) => ({ ...m }));
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
    if (cfg.read_file_summary) {
      out.push(this.makeReadFileSummaryTool());
    }
    return out;
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

    this.messages.push({ role: "user", content: userText });

    for (let round = 0; round <= this.maxToolRounds; round++) {
      // Abort between rounds (history is well-formed here: every prior
      // assistant tool-call has a paired tool result).
      if (signal?.aborted) throw abortError();

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
              result = await tool.execute(parsed, this.toolContext);
            } catch (err: any) {
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
      }
      // Loop again so the model can react to the tool results.
    }
  }
}
