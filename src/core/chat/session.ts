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

import type {
  LLMProvider,
  LLMMessage,
  LLMRequest,
  LLMStreamChunk,
} from "../providers/llm.js";

/** A tool the model can invoke. Parameters are a JSON-schema object. */
export interface ToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  /**
   * Execute the tool. `args` is the parsed JSON arguments object (or `{}` if
   * the model emitted no/invalid JSON). Returns the textual result that is fed
   * back to the model plus an `ok` flag for callers/loggers.
   */
  execute(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
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
  private messages: LLMMessage[] = [];

  constructor(opts: ChatSessionOptions) {
    this.llm = opts.llm;
    this.model = opts.model;
    this.tools = opts.tools ?? [];
    this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
    this.maxToolRounds = opts.maxToolRounds ?? 8;
    this.temperature = opts.temperature;
    this.maxTokens = opts.maxTokens;
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

      // Record the assistant turn (text content, possibly empty alongside calls).
      this.messages.push({ role: "assistant", content: text });

      if (toolCalls.length === 0) {
        yield { type: "done", finishReason };
        return;
      }

      if (round === this.maxToolRounds) {
        // Out of tool budget: surface the calls but stop the loop.
        for (const call of toolCalls) {
          yield { type: "tool-call", id: call.id, name: call.name, args: call.args };
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
              result = await tool.execute(parsed);
            } catch (err: any) {
              result = { ok: false, content: `error: ${err?.message ?? String(err)}` };
            }
          } else {
            result = result!;
          }
        }

        this.messages.push({
          role: "tool",
          content: result.content,
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
