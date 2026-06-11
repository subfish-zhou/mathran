/**
 * Multi-model LLM provider abstraction
 *
 * Defines a uniform interface for streaming chat completions across
 * Azure OpenAI, OpenAI, and Anthropic backends. All providers return
 * AsyncIterable<ChatChunk> using OpenAI's chunk shape as the common format.
 *
 * Provider implementations live in ./providers/; this module re-exports
 * the full public API for backward compatibility.
 */

export type { ChatMessage, ToolDef, ChatChunk, LLMProviderParams, LLMProvider } from "./providers/types";
export { AzureOpenAIProvider } from "./providers/azure";
export { OpenAIProvider } from "./providers/openai";
export { AnthropicProvider } from "./providers/anthropic";
