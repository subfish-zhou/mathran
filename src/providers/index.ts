/**
 * v0.1 provider implementations — barrel export.
 *
 * These plug into the interfaces declared in src/core/providers/*.
 * They are the standalone-mode defaults for `mathran prove`.
 */

export { LocalLeanProvider, type LocalLeanProviderOptions } from "./lean/local.js";
export { InMemoryStorage } from "./storage/in-memory.js";
export { LocalFsArtifactSink } from "./artifact-sink/local-fs.js";
export { copilotChat, resolveCopilotToken, type CopilotChatRequest, type CopilotChatResponse } from "./llm/copilot.js";
