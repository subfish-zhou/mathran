/**
 * Anthropic Provider
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions/completions";
import type { LLMProvider, LLMProviderParams, ChatChunk, ChatMessage, ToolDef } from "./types";
import { isFunctionTool, isFunctionToolCall, chunkBase, makeUsageChunk } from "./types";

// ========== Client singleton ==========

let _anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (_anthropicClient) return _anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to your .env.local file.");
  }
  _anthropicClient = new Anthropic({ apiKey });
  return _anthropicClient;
}

// ========== Provider ==========

export class AnthropicProvider implements LLMProvider {
  async *chatCompletion(params: LLMProviderParams): AsyncIterable<ChatChunk> {
    const client = getAnthropicClient();
    const { system, messages } = convertMessagesToAnthropic(params.messages);
    const tools = params.tools?.length ? convertToolsToAnthropic(params.tools) : undefined;

    const createParams: Anthropic.MessageCreateParams = {
      model: params.model,
      max_tokens: params.maxTokens ?? 16384,
      messages,
      ...(system ? { system } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
    };

    if (params.stream === false) {
      const response = await client.messages.create(
        createParams,
        params.signal ? { signal: params.signal } : undefined,
      );
      yield* anthropicResponseToChunks(response);
      return;
    }

    const stream = client.messages.stream(
      createParams,
      params.signal ? { signal: params.signal } : undefined,
    );

    const runId = `chatcmpl-${crypto.randomUUID()}`;
    let currentToolCallIndex = -1;

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        currentToolCallIndex++;
      }
      const chunk = anthropicEventToChunk(event, runId, currentToolCallIndex);
      if (chunk) {
        yield chunk;
      }
    }

    // Emit a final chunk with usage from the stream
    const finalMessage = await stream.finalMessage();
    if (finalMessage.usage) {
      yield makeUsageChunk(runId, finalMessage.usage.input_tokens, finalMessage.usage.output_tokens);
    }
  }
}

// ========== Anthropic Conversion Helpers ==========

function convertMessagesToAnthropic(
  messages: ChatMessage[],
): { system: string | undefined; messages: Anthropic.MessageParam[] } {
  let system: string | undefined;
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      continue;
    }

    if (msg.role === "user") {
      result.push({
        role: "user",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant") {
      const assistantMsg = msg as ChatCompletionAssistantMessageParam;
      const blocks: Anthropic.ContentBlockParam[] = [];

      if (assistantMsg.content) {
        blocks.push({
          type: "text",
          text: typeof assistantMsg.content === "string"
            ? assistantMsg.content
            : JSON.stringify(assistantMsg.content),
        });
      }

      if (assistantMsg.tool_calls) {
        for (const tc of assistantMsg.tool_calls) {
          if (!isFunctionToolCall(tc)) continue;
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch { /* keep empty */ }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }

      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolMsg = msg as ChatCompletionToolMessageParam;
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolMsg.tool_call_id,
            content: typeof toolMsg.content === "string"
              ? toolMsg.content
              : JSON.stringify(toolMsg.content),
          },
        ],
      });
      continue;
    }
  }

  return { system, messages: result };
}

function convertToolsToAnthropic(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.filter(isFunctionTool).map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: (t.function.parameters ?? {
      type: "object" as const,
      properties: {},
    }) as Anthropic.Tool.InputSchema,
  }));
}

function anthropicEventToChunk(
  event: Anthropic.MessageStreamEvent,
  runId: string,
  currentToolCallIndex: number,
): ChatChunk | null {
  const base = chunkBase(runId, "");

  if (event.type === "content_block_delta") {
    const delta = event.delta;
    if (delta.type === "text_delta") {
      return {
        ...base,
        choices: [
          {
            index: 0,
            delta: { content: delta.text, role: "assistant" },
            finish_reason: null,
          },
        ],
      };
    }
    if (delta.type === "input_json_delta") {
      return {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: currentToolCallIndex,
                  function: { arguments: delta.partial_json },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }
  }

  if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    const block = event.content_block as Anthropic.ToolUseBlock;
    return {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: currentToolCallIndex,
                id: block.id,
                type: "function" as const,
                function: { name: block.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "message_stop") {
    return {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }

  return null;
}

function* anthropicResponseToChunks(response: Anthropic.Message): Generator<ChatChunk> {
  const runId = `chatcmpl-${crypto.randomUUID()}`;
  const base = chunkBase(runId, response.model);

  let toolCallIndex = 0;
  for (const block of response.content) {
    if (block.type === "text") {
      yield {
        ...base,
        choices: [
          {
            index: 0,
            delta: { content: block.text, role: "assistant" },
            finish_reason: null,
          },
        ],
      };
    } else if (block.type === "tool_use") {
      yield {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: block.id,
                  type: "function" as const,
                  function: { name: block.name, arguments: JSON.stringify(block.input) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      toolCallIndex++;
    }
  }

  yield {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };

  if (response.usage) {
    yield makeUsageChunk(runId, response.usage.input_tokens, response.usage.output_tokens);
  }
}
