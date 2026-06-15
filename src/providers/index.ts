/**
 * v0.1 provider implementations — barrel export.
 *
 * These plug into the interfaces declared in src/core/providers/*.
 * They are the standalone-mode defaults for `mathran prove`.
 */

export { LocalLeanProvider, type LocalLeanProviderOptions } from "./lean/local.js";
export { InMemoryStorage } from "./storage/in-memory.js";
export { FsStorage, type FsStorageOptions } from "./storage/fs.js";
export { LocalFsArtifactSink } from "./artifact-sink/local-fs.js";
export { copilotChat, resolveCopilotToken, type CopilotChatRequest, type CopilotChatResponse } from "./llm/copilot.js";
export { OpenAIAdapter, type OpenAIAdapterOptions } from "./llm/openai.js";
export { AnthropicAdapter, type AnthropicAdapterOptions } from "./llm/anthropic.js";
export { AzureOpenAIAdapter, type AzureOpenAIAdapterOptions } from "./llm/azure.js";
export { OllamaAdapter, type OllamaAdapterOptions } from "./llm/ollama.js";
export { CopilotAdapter, type CopilotAdapterOptions } from "./llm/copilot-adapter.js";
export {
  ModelRouter,
  resolveApiKey,
  type ProviderConfig,
  type ProviderKind,
  type MathranConfig,
  type AdapterFactory,
  type ModelRouterOptions,
} from "./llm/router.js";
