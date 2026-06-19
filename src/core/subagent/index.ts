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
export type {
  SchedulerOpts,
  SubagentTaskWithRuntime,
  SubprocessRuntimeLike,
} from "./scheduler.js";
export {
  SubprocessRuntime,
} from "./runtime/subprocess.js";
export type {
  SubprocessRuntimeOpts,
  SubprocessRunArgs,
  SchedulerLike,
} from "./runtime/subprocess.js";
export {
  encodeMessage,
  decodeLine,
  LineSplitter,
} from "./runtime/protocol.js";
export type {
  Message as SubagentProtocolMessage,
  ParentToChild,
  ChildToParent,
} from "./runtime/protocol.js";
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
export {
  researchRunner,
  parsePlannerAction,
  formatFindings,
  PLANNER_SYSTEM,
  SYNTHESIS_SYSTEM,
  DEFAULT_MAX_ROUNDS,
  SUBDISPATCH_HARD_CAP_BYTES,
  type ResearchInput,
  type ResearchScheduler,
  type ResearchFinding,
  type PlannerAction,
} from "./runners/research.js";
