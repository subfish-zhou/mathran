/**
 * mathran chat kernel — barrel export.
 *
 * The conversational core shared by the CLI (`mathran` / `mathran -p`) and the
 * `serve` chat panel. Consumers drive a `ChatSession` and render the
 * `AsyncIterable<ChatEvent>` it yields from `send()`.
 */

export { ChatSession } from "./session.js";
export type {
  ChatEvent,
  ChatSessionOptions,
  ToolSpec,
} from "./session.js";
export { createLeanCheckTool, type LeanCheckToolOptions } from "./tools/lean-check.js";
export { renderTranscriptMarkdown, type TranscriptMeta } from "./transcript.js";
