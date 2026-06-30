/**
 * Checkpoints module barrel (/diff + checkpoint/rewind).
 */

export * from "./schema.js";
export * from "./store.js";
export { snapshotFile } from "./snapshot.js";
export {
  wrapMutateTool,
  type CheckpointMiddlewareOptions,
} from "./middleware.js";
export {
  diffLines,
  formatFileDiff,
  formatCheckpointDiff,
  formatCheckpointList,
} from "./diff-format.js";
export { parseDiffArg, runDiff, type DiffTarget } from "./diff-run.js";
export {
  parseRewindArg,
  parseRewindArgs,
  resolveRewindPrefix,
  rewindCheckpoints,
  applyConversationRewind,
  formatRewindResult,
  runRewind,
  defaultSummarizer,
  type RewindTarget,
  type RewindArgs,
  type RewindResult,
  type RewindFileResult,
  type RewindConversationResult,
  type RunRewindHostHooks,
  type ConversationHistoryAdapter,
  type MinimalMessage,
  type Summarizer,
} from "./rewind.js";
export { makeChatStoreHistoryAdapter } from "./history-adapter.js";
