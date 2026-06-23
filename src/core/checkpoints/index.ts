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
  resolveRewindPrefix,
  rewindCheckpoints,
  formatRewindResult,
  runRewind,
  type RewindTarget,
  type RewindResult,
  type RewindFileResult,
} from "./rewind.js";
