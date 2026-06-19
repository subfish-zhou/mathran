/**
 * Subagent infrastructure barrel (v0.2 §1).
 */

export type {
  SubagentTaskType,
  SubagentTask,
  SubagentResult,
  SubagentContext,
  SubagentRunner,
} from "./types.js";
export { SubagentRegistry, defaultSubagentRegistry } from "./registry.js";
export { SubagentScheduler } from "./scheduler.js";
export type { SchedulerOpts } from "./scheduler.js";
export {
  createArtifactDir,
  writeArtifact,
  readArtifact,
  listArtifactRuns,
} from "./artifact.js";
export {
  compactRunner,
  computeCompacted,
  findKeepStartIndex,
  DEFAULT_KEEP_RECENT_ROUNDS,
  DEFAULT_CONTEXT_WINDOW,
  COMPACT_SUMMARY_PREFIX,
  type CompactRunnerInput,
  type CompactedArtifact,
} from "./runners/compact.js";
export {
  readSummarizeRunner,
  buildSummarizePrompt,
  looksBinary,
  resolveInsideWorkspace,
  DEFAULT_MAX_FILE_BYTES,
  READ_SUMMARIZE_PROMPT_TEMPLATE,
  TRUNCATION_MARKER,
  type ReadSummarizeRunnerInput,
} from "./runners/read-summarize.js";
