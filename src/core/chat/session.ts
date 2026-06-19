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
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
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

  /**
   * Run one user turn. Streams text/tool events; resolves the conversation by
   * looping through tool calls until the model stops requesting them.
   */
  async *send(userText: string): AsyncIterable<ChatEvent> {
    this.messages.push({ role: "user", content: userText });

    for (let round = 0; round <= this.maxToolRounds; round++) {
      const req: LLMRequest = {
        messages: this.messages.map((m) => ({ ...m })),
        model: this.model ?? "",
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
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

      for await (const chunk of response.stream()) {
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

      for (const call of toolCalls) {
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
