import { ToolRegistry } from "./registry";
import { searchWikiTool } from "./search-wiki";
import { searchEffortsTool } from "./search-efforts";
import { searchForumTool } from "./search-forum";
import { searchArxivTool } from "./search-arxiv";
import { searchWebTool } from "./search-web";
import { searchGithubTool } from "./search-github";
import { queryDatabaseTool } from "./query-database";
import { createEffortTool } from "./create-effort";
import { createForumThreadTool } from "./create-forum-thread";
import { createForumPostTool } from "./create-forum-post";
import { updateForumPostTool } from "./update-forum-post";
import { deleteForumPostTool } from "./delete-forum-post";
import { editThreadTitleTool } from "./edit-thread-title";
import { updateThreadStatusTool } from "./update-thread-status";
import { deleteThreadTool } from "./delete-thread";
import { listThreadPostsTool } from "./list-thread-posts";
import { listProjectThreadsTool } from "./list-project-threads";
import { listWikiPagesTool } from "./list-wiki-pages";
import { reactToPostTool } from "./react-to-post";
import { removePostReactionTool } from "./remove-post-reaction";
import { markPostInsightfulTool } from "./mark-post-insightful";
import { createPollTool } from "./create-poll";
import { votePollTool } from "./vote-poll";
import { schedulePostTool } from "./schedule-post";
import { flagPostTool } from "./flag-post";
import { bookmarkPostTool } from "./bookmark-post";
import { removeBookmarkTool } from "./remove-bookmark";
import { movePostTool } from "./move-post";
import { setThreadPinnedTool } from "./set-thread-pinned";
import { setThreadLockedTool } from "./set-thread-locked";
import { setThreadWatchTool } from "./set-thread-watch";
import { moveThreadToStreamTool } from "./move-thread-to-stream";
import { moveThreadToProjectTool } from "./move-thread-to-project";
import { markThreadReadTool } from "./mark-thread-read";
import { markAllThreadsReadTool } from "./mark-all-threads-read";
import { searchForumPostsTool } from "./search-forum-posts";
import { getPollTool } from "./get-poll";
import { getScheduledTool } from "./get-scheduled";
import { cancelScheduledTool } from "./cancel-scheduled";
import { createWikiPageTool } from "./create-wiki-page";
import { updateWikiPageTool } from "./update-wiki-page";
import { runLatexTool } from "./run-latex";
import { getProjectIndexTool } from "./get-project-index";
import { readWikiPageTool } from "./read-wiki-page";
import { readEffortTool } from "./read-effort";
import { readThreadTool } from "./read-thread";
import { deepResearchTool } from "./deep-research";
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
import { getResearchProfileTool } from "./get-research-profile";
import { getUserPublicationsTool } from "./get-user-publications";
import { getUserKnowledgeTool } from "./get-user-knowledge";
import { runPythonTool } from "./run-python";
// IMPL [pworkspace-mvp] sage interpreter not in MVP image — kept exported but not registered
import { loadSkillReferenceTool } from "./load-skill-reference";
import { readEffortGraphTool } from "./read-effort-graph";
import { readProgramTool } from "./read-program";
import { listProgramsTool } from "./list-programs";
import { listEffortIssuesTool } from "./list-effort-issues";
import { summarizeThreadTool } from "./summarize-thread";
import { readEffortDetailsTool } from "./read-effort-details";
import { getProgramIndexTool } from "./get-program-index";
import { listMentionsTool } from "./list-mentions";
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
import { updateEffortTool } from "./update-effort";
import { updateEffortFullTool } from "./update-effort-full";
import { updateEffortStatusTool } from "./update-effort-status";
import { updateEffortFormalStatementTool } from "./update-effort-formal-statement";
import { deleteEffortTool } from "./delete-effort";
import { forkEffortTool } from "./fork-effort";
import { listEffortVersionsTool } from "./list-effort-versions";
import { createEffortVersionTool } from "./create-effort-version";
import { deleteEffortVersionTool } from "./delete-effort-version";
// [assistant-toolkit-2] Batch B: effort review workflow.
import { listReviewsTool } from "./list-reviews";
import { getReviewTool } from "./get-review";
import { createReviewTool } from "./create-review";
import { updateReviewTool } from "./update-review";
import { addReviewCommentTool } from "./add-review-comment";
import { resolveReviewCommentTool } from "./resolve-review-comment";
import { requestReviewTool } from "./request-review";
// [assistant-toolkit-2] Batch C: effort relations + mathref/backref.
import { addRelationTool } from "./add-relation";
import { removeRelationTool } from "./remove-relation";
import { listDependentsTool } from "./list-dependents";
import { crossProjectRelationsTool } from "./cross-project-relations";
import { resolveRefsTool } from "./resolve-refs";
import { peekRefTool } from "./peek-ref";
import { listBackrefsTool } from "./list-backrefs";
// [assistant-toolkit-2] Batch D: effort doc-pages + structure.
import { listDocPagesTool } from "./list-doc-pages";
import { getDocPageTool } from "./get-doc-page";
import { createDocPageTool } from "./create-doc-page";
import { updateDocPageTool } from "./update-doc-page";
import { deleteDocPageTool } from "./delete-doc-page";
import { reorderDocPagesTool } from "./reorder-doc-pages";
import { getStructureTool } from "./get-structure";
import { updateStructureTool } from "./update-structure";
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


