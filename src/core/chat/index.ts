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
  CompactStats,
} from "./session.js";
export { createLeanCheckTool, type LeanCheckToolOptions } from "./tools/lean-check.js";
export { createBashTool, type BashToolOptions } from "./tools/bash.js";
export { createReadFileTool, type ReadFileToolOptions } from "./tools/read-file.js";
export { createWriteFileTool, type WriteFileToolOptions } from "./tools/write-file.js";
export { createEditFileTool, type EditFileToolOptions } from "./tools/edit-file.js";
export {
  createDispatchSubagentTool,
  type DispatchSubagentToolOptions,
} from "./tools/dispatch-subagent.js";
export { renderTranscriptMarkdown, type TranscriptMeta } from "./transcript.js";
