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
  searchRunner,
  renderSearchSummary,
  globToRegExp,
  runNodeFallback,
  _resetRgProbeForTests,
  DEFAULT_GLOB,
  DEFAULT_MAX_FILES,
  DEFAULT_CONTEXT_LINES,
  MAX_TOTAL_MATCHES,
  MIN_QUERY_LENGTH,
  DEFAULT_IGNORE_DIRS,
  type SearchRunnerInput,
  type SearchMatch,
  type SearchSummary,
} from "./runners/search.js";
