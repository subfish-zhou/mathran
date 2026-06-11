import { ToolRegistry } from "./registry";
// TODO(mathran-v0.1): import { searchWikiTool } from "./search-wiki";
// TODO(mathran-v0.1): import { searchEffortsTool } from "./search-efforts";
// TODO(mathran-v0.1): import { searchForumTool } from "./search-forum";
import { searchArxivTool } from "./search-arxiv";
import { searchWebTool } from "./search-web";
// TODO(mathran-v0.1): import { searchGithubTool } from "./search-github";
// TODO(mathran-v0.1): import { queryDatabaseTool } from "./query-database";
// TODO(mathran-v0.1): import { createEffortTool } from "./create-effort";
// TODO(mathran-v0.1): import { createForumThreadTool } from "./create-forum-thread";
// TODO(mathran-v0.1): import { createForumPostTool } from "./create-forum-post";
// TODO(mathran-v0.1): import { updateForumPostTool } from "./update-forum-post";
// TODO(mathran-v0.1): import { deleteForumPostTool } from "./delete-forum-post";
// TODO(mathran-v0.1): import { editThreadTitleTool } from "./edit-thread-title";
// TODO(mathran-v0.1): import { updateThreadStatusTool } from "./update-thread-status";
// TODO(mathran-v0.1): import { deleteThreadTool } from "./delete-thread";
// TODO(mathran-v0.1): import { listThreadPostsTool } from "./list-thread-posts";
// TODO(mathran-v0.1): import { listProjectThreadsTool } from "./list-project-threads";
// TODO(mathran-v0.1): import { listWikiPagesTool } from "./list-wiki-pages";
// TODO(mathran-v0.1): import { reactToPostTool } from "./react-to-post";
// TODO(mathran-v0.1): import { removePostReactionTool } from "./remove-post-reaction";
// TODO(mathran-v0.1): import { markPostInsightfulTool } from "./mark-post-insightful";
// TODO(mathran-v0.1): import { createPollTool } from "./create-poll";
// TODO(mathran-v0.1): import { votePollTool } from "./vote-poll";
// TODO(mathran-v0.1): import { schedulePostTool } from "./schedule-post";
// TODO(mathran-v0.1): import { flagPostTool } from "./flag-post";
// TODO(mathran-v0.1): import { bookmarkPostTool } from "./bookmark-post";
// TODO(mathran-v0.1): import { removeBookmarkTool } from "./remove-bookmark";
// TODO(mathran-v0.1): import { movePostTool } from "./move-post";
// TODO(mathran-v0.1): import { setThreadPinnedTool } from "./set-thread-pinned";
// TODO(mathran-v0.1): import { setThreadLockedTool } from "./set-thread-locked";
// TODO(mathran-v0.1): import { setThreadWatchTool } from "./set-thread-watch";
// TODO(mathran-v0.1): import { moveThreadToStreamTool } from "./move-thread-to-stream";
// TODO(mathran-v0.1): import { moveThreadToProjectTool } from "./move-thread-to-project";
// TODO(mathran-v0.1): import { markThreadReadTool } from "./mark-thread-read";
// TODO(mathran-v0.1): import { markAllThreadsReadTool } from "./mark-all-threads-read";
// TODO(mathran-v0.1): import { searchForumPostsTool } from "./search-forum-posts";
// TODO(mathran-v0.1): import { getPollTool } from "./get-poll";
// TODO(mathran-v0.1): import { getScheduledTool } from "./get-scheduled";
// TODO(mathran-v0.1): import { cancelScheduledTool } from "./cancel-scheduled";
// TODO(mathran-v0.1): import { createWikiPageTool } from "./create-wiki-page";
// TODO(mathran-v0.1): import { updateWikiPageTool } from "./update-wiki-page";
import { runLatexTool } from "./run-latex";
// TODO(mathran-v0.1): import { getProjectIndexTool } from "./get-project-index";
// TODO(mathran-v0.1): import { readWikiPageTool } from "./read-wiki-page";
// TODO(mathran-v0.1): import { readEffortTool } from "./read-effort";
// TODO(mathran-v0.1): import { readThreadTool } from "./read-thread";
// TODO(mathran-v0.1): import { deepResearchTool } from "./deep-research";
import { checkSubAgentTool, cancelSubAgentTool } from "./manage-sub-agent";
import { listSubagentsTool } from "./list-subagents";
import { getSubagentStatusTool } from "./get-subagent-status";
import { getGoalTool } from "./get-goal";
import { updateGoalTool } from "./update-goal";
import { updatePlanTool } from "./update-plan";
import { spawnAwaiterTool } from "./spawn-awaiter";
import {
  memoryAddTool,
  memoryListTool,
  memoryReadTool,
  memorySearchTool,
} from "./memory";
// TODO(mathran-v0.1): import { getResearchProfileTool } from "./get-research-profile";
// TODO(mathran-v0.1): import { getUserPublicationsTool } from "./get-user-publications";
// TODO(mathran-v0.1): import { getUserKnowledgeTool } from "./get-user-knowledge";
import { runPythonTool } from "./run-python";
// IMPL [pworkspace-mvp] sage interpreter not in MVP image — kept exported but not registered
import { loadSkillReferenceTool } from "./load-skill-reference";
// TODO(mathran-v0.1): import { readEffortGraphTool } from "./read-effort-graph";
// TODO(mathran-v0.1): import { readProgramTool } from "./read-program";
// TODO(mathran-v0.1): import { listProgramsTool } from "./list-programs";
// TODO(mathran-v0.1): import { listEffortIssuesTool } from "./list-effort-issues";
// TODO(mathran-v0.1): import { summarizeThreadTool } from "./summarize-thread";
// TODO(mathran-v0.1): import { readEffortDetailsTool } from "./read-effort-details";
// TODO(mathran-v0.1): import { getProgramIndexTool } from "./get-program-index";
// TODO(mathran-v0.1): import { listMentionsTool } from "./list-mentions";
// IMPL [quick-win-3] scratchpad tools
import { scratchpadWriteTool, scratchpadReadTool, scratchpadListTool } from "./scratchpad";
// IMPL [quick-win-1] PDF reader
import { readPdfTool } from "./read-pdf";
// IMPL [quick-win-5] TodoWrite tools
import { todoWriteTool, todoReadTool } from "./todos";
// IMPL [pworkspace-mvp] Workspace + install-package tools
import { readWorkspaceFileTool } from "./workspace-read";
import { writeWorkspaceFileTool } from "./workspace-write";
import { listWorkspaceTool } from "./workspace-list";
import { deleteWorkspaceFileTool } from "./workspace-delete";
import { installPackageTool } from "./install-package";
// [assistant-toolkit-2] Batch A: effort write operations.
// TODO(mathran-v0.1): import { updateEffortTool } from "./update-effort";
// TODO(mathran-v0.1): import { updateEffortFullTool } from "./update-effort-full";
// TODO(mathran-v0.1): import { updateEffortStatusTool } from "./update-effort-status";
// TODO(mathran-v0.1): import { updateEffortFormalStatementTool } from "./update-effort-formal-statement";
// TODO(mathran-v0.1): import { deleteEffortTool } from "./delete-effort";
// TODO(mathran-v0.1): import { forkEffortTool } from "./fork-effort";
// TODO(mathran-v0.1): import { listEffortVersionsTool } from "./list-effort-versions";
// TODO(mathran-v0.1): import { createEffortVersionTool } from "./create-effort-version";
// TODO(mathran-v0.1): import { deleteEffortVersionTool } from "./delete-effort-version";
// [assistant-toolkit-2] Batch B: effort review workflow.
// TODO(mathran-v0.1): import { listReviewsTool } from "./list-reviews";
// TODO(mathran-v0.1): import { getReviewTool } from "./get-review";
// TODO(mathran-v0.1): import { createReviewTool } from "./create-review";
// TODO(mathran-v0.1): import { updateReviewTool } from "./update-review";
// TODO(mathran-v0.1): import { addReviewCommentTool } from "./add-review-comment";
// TODO(mathran-v0.1): import { resolveReviewCommentTool } from "./resolve-review-comment";
// TODO(mathran-v0.1): import { requestReviewTool } from "./request-review";
// [assistant-toolkit-2] Batch C: effort relations + mathref/backref.
// TODO(mathran-v0.1): import { addRelationTool } from "./add-relation";
// TODO(mathran-v0.1): import { removeRelationTool } from "./remove-relation";
// TODO(mathran-v0.1): import { listDependentsTool } from "./list-dependents";
// TODO(mathran-v0.1): import { crossProjectRelationsTool } from "./cross-project-relations";
import { resolveRefsTool } from "./resolve-refs";
import { peekRefTool } from "./peek-ref";
// TODO(mathran-v0.1): import { listBackrefsTool } from "./list-backrefs";
// [assistant-toolkit-2] Batch D: effort doc-pages + structure.
// TODO(mathran-v0.1): import { listDocPagesTool } from "./list-doc-pages";
// TODO(mathran-v0.1): import { getDocPageTool } from "./get-doc-page";
// TODO(mathran-v0.1): import { createDocPageTool } from "./create-doc-page";
// TODO(mathran-v0.1): import { updateDocPageTool } from "./update-doc-page";
// TODO(mathran-v0.1): import { deleteDocPageTool } from "./delete-doc-page";
// TODO(mathran-v0.1): import { reorderDocPagesTool } from "./reorder-doc-pages";
// TODO(mathran-v0.1): import { getStructureTool } from "./get-structure";
// TODO(mathran-v0.1): import { updateStructureTool } from "./update-structure";
import { updateStepStatusTool } from "./update-step-status";

export { ToolRegistry } from "./registry";
export type { ToolContext, ToolResult, ToolDefinition } from "./types";

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(searchWikiTool);
  registry.register(searchEffortsTool);
  registry.register(searchForumTool);
  registry.register(searchArxivTool);
  registry.register(searchWebTool);
  registry.register(searchGithubTool);
  registry.register(queryDatabaseTool);
  registry.register(createEffortTool);
  registry.register(createForumThreadTool);
  registry.register(createForumPostTool);
  registry.register(updateForumPostTool);
  registry.register(deleteForumPostTool);
  registry.register(editThreadTitleTool);
  registry.register(updateThreadStatusTool);
  registry.register(deleteThreadTool);
  registry.register(listThreadPostsTool);
  registry.register(listProjectThreadsTool);
  registry.register(listWikiPagesTool);
  registry.register(reactToPostTool);
  registry.register(removePostReactionTool);
  registry.register(markPostInsightfulTool);
  registry.register(createPollTool);
  registry.register(votePollTool);
  registry.register(schedulePostTool);
  registry.register(flagPostTool);
  registry.register(bookmarkPostTool);
  registry.register(removeBookmarkTool);
  registry.register(movePostTool);
  registry.register(setThreadPinnedTool);
  registry.register(setThreadLockedTool);
  registry.register(setThreadWatchTool);
  registry.register(moveThreadToStreamTool);
  registry.register(moveThreadToProjectTool);
  registry.register(markThreadReadTool);
  registry.register(markAllThreadsReadTool);
  registry.register(searchForumPostsTool);
  registry.register(getPollTool);
  registry.register(getScheduledTool);
  registry.register(cancelScheduledTool);
  registry.register(createWikiPageTool);
  registry.register(updateWikiPageTool);
  registry.register(runLatexTool);
  registry.register(getProjectIndexTool);
  registry.register(readWikiPageTool);
  registry.register(readEffortTool);
  registry.register(readThreadTool);
  registry.register(deepResearchTool);
  registry.register(checkSubAgentTool);
  registry.register(cancelSubAgentTool);
  registry.register(listSubagentsTool);
  registry.register(getSubagentStatusTool);
  // [commit-5b] Goal management tools — model-visible.
  registry.register(getGoalTool);
  registry.register(updateGoalTool);
  // [commit-6a] Plan management tool — structured todo list.
  registry.register(updatePlanTool);
  // [commit-08/sprint-2] Builtin awaiter sub-agent spawn.
  registry.register(spawnAwaiterTool);
  // [commit-07b/sprint-2] Codex-parity memory tools.
  registry.register(memoryAddTool);
  registry.register(memoryListTool);
  registry.register(memoryReadTool);
  registry.register(memorySearchTool);
  registry.register(getResearchProfileTool);
  registry.register(getUserPublicationsTool);
  registry.register(getUserKnowledgeTool);
  registry.register(runPythonTool);
  // IMPL [pworkspace-mvp] runSageTool not registered — sage interpreter not in MVP sandbox image. Re-enable when sage layer ships.
  // registry.register(runSageTool);
  // IMPL [quick-win-4] runWolframTool unregistered.
  registry.register(loadSkillReferenceTool);
  registry.register(readEffortGraphTool);
  registry.register(readProgramTool);
  registry.register(listProgramsTool);
  registry.register(listEffortIssuesTool);
  registry.register(summarizeThreadTool);
  registry.register(readEffortDetailsTool);
  registry.register(getProgramIndexTool);
  registry.register(listMentionsTool);
  // IMPL [quick-win-3] scratchpad tools
  registry.register(scratchpadWriteTool);
  registry.register(scratchpadReadTool);
  registry.register(scratchpadListTool);
  // IMPL [quick-win-1] read_pdf
  registry.register(readPdfTool);
  // IMPL [quick-win-5] todo_write / todo_read
  registry.register(todoWriteTool);
  registry.register(todoReadTool);
  // IMPL [pworkspace-mvp] Personal workspace tools
  registry.register(readWorkspaceFileTool);
  registry.register(writeWorkspaceFileTool);
  registry.register(listWorkspaceTool);
  registry.register(deleteWorkspaceFileTool);
  registry.register(installPackageTool);
  // [assistant-toolkit-2] Batch A: effort write operations.
  registry.register(updateEffortTool);
  registry.register(updateEffortFullTool);
  registry.register(updateEffortStatusTool);
  registry.register(updateEffortFormalStatementTool);
  registry.register(deleteEffortTool);
  registry.register(forkEffortTool);
  registry.register(listEffortVersionsTool);
  registry.register(createEffortVersionTool);
  registry.register(deleteEffortVersionTool);
  // [assistant-toolkit-2] Batch B: effort review workflow.
  registry.register(listReviewsTool);
  registry.register(getReviewTool);
  registry.register(createReviewTool);
  registry.register(updateReviewTool);
  registry.register(addReviewCommentTool);
  registry.register(resolveReviewCommentTool);
  registry.register(requestReviewTool);
  // [assistant-toolkit-2] Batch C: effort relations + mathref/backref.
  registry.register(addRelationTool);
  registry.register(removeRelationTool);
  registry.register(listDependentsTool);
  registry.register(crossProjectRelationsTool);
  registry.register(resolveRefsTool);
  registry.register(peekRefTool);
  registry.register(listBackrefsTool);
  // [assistant-toolkit-2] Batch D: effort doc-pages + structure.
  registry.register(listDocPagesTool);
  registry.register(getDocPageTool);
  registry.register(createDocPageTool);
  registry.register(updateDocPageTool);
  registry.register(deleteDocPageTool);
  registry.register(reorderDocPagesTool);
  registry.register(getStructureTool);
  registry.register(updateStructureTool);
  registry.register(updateStepStatusTool);
  return registry;
}


