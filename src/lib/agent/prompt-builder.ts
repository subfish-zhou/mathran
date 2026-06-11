// ========== Prompt Builder ==========
// Generates system prompts and tool lists per chat context.

export type ChatContextType = 'personal' | 'project' | 'thread' | 'program';

// IMPL [pworkspace-mvp] Personal Workspace status surface — passed through from
// chat-handler so the system prompt can tell the LLM whether sandbox tools are
// available (opted in + container running) or unavailable (not opted in).
export type WorkspaceRuntimeStateHint =
  | 'not_provisioned'
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'archived'
  | 'destroyed';

export interface WorkspaceStatusHint {
  enabled: boolean;
  state: WorkspaceRuntimeStateHint;
}

export interface PromptBuilderInput {
  context: ChatContextType;
  userId: string;
  projectId?: string;
  projectTitle?: string;
  programId?: string;
  programTitle?: string;
  threadId?: string;
  threadTitle?: string;
  // IMPL [pworkspace-mvp] Optional — when present, an additional system prompt
  // section explains workspace availability to the LLM.
  workspaceStatus?: WorkspaceStatusHint;
}

// ========== Tool Lists ==========

const PERSONAL_TOOLS = [
  'search_arxiv',
  'search_web',
  'search_github',
  'search_efforts',
  'search_forum',
  'get_user_publications',
  'get_user_knowledge',
  'get_research_profile',
  'run_python',
  // IMPL [pworkspace-mvp] run_sage temporarily disabled — sage interpreter not in MVP image.
  // 'run_sage',
  // IMPL [quick-win-4] run_wolfram removed (stub).
  'load_skill_reference',
  // IMPL [quick-win-3] scratchpad tools (per-conversation external memory)
  'scratchpad_write',
  'scratchpad_read',
  'scratchpad_list',
  // IMPL [quick-win-1] PDF reader
  'read_pdf',
  // IMPL [quick-win-5] TodoWrite tools — surface multi-step plans to the user.
  'todo_write',
  'todo_read',
];

const PROJECT_TOOLS = [
  ...PERSONAL_TOOLS,
  'get_project_index',
  'read_wiki_page',
  'read_effort',
  'read_effort_graph',
  'read_effort_details',
  'list_effort_issues',
  'read_thread',
  'summarize_thread',
  'search_wiki',
  'query_database',
  'create_effort',
  'create_forum_thread',
  'create_forum_post',
  'create_wiki_page',
  'update_wiki_page',
  'run_latex',
  'deep_research',
  'check_sub_agent',
  'cancel_sub_agent',
  // [assistant-toolkit] Forum post / thread / poll / wiki management tools.
  // Registered in tools/index.ts; surfaced here so the LLM can call them in
  // project + thread contexts (THREAD_TOOLS inherits PROJECT_TOOLS).
  // Batch 1 (P0): edit/delete existing posts + rename thread.
  'update_forum_post',
  'delete_forum_post',
  'edit_thread_title',
  // Batch 2 (P1): reactions, thread status, listings, polls, scheduling.
  'react_to_post',
  'remove_post_reaction',
  'mark_post_insightful',
  'update_thread_status',
  'delete_thread',
  'list_thread_posts',
  'list_project_threads',
  'list_wiki_pages',
  'create_poll',
  'vote_poll',
  'schedule_post',
  // Batch 3 (P2): moderation, bookmarks, thread admin, poll/schedule reads.
  'flag_post',
  'bookmark_post',
  'remove_bookmark',
  'move_post',
  'set_thread_pinned',
  'set_thread_locked',
  'set_thread_watch',
  'move_thread_to_stream',
  'move_thread_to_project',
  'mark_thread_read',
  'mark_all_threads_read',
  'search_forum_posts',
  'get_poll',
  'get_scheduled',
  'cancel_scheduled',
  // [assistant-toolkit-2] Batch A: effort write operations.
  'update_effort',
  'update_effort_full',
  'update_effort_status',
  'update_effort_formal_statement',
  'delete_effort',
  'fork_effort',
  'list_effort_versions',
  'create_effort_version',
  'delete_effort_version',
  // [assistant-toolkit-2] Batch B: effort review workflow.
  'list_reviews',
  'get_review',
  'create_review',
  'update_review',
  'add_review_comment',
  'resolve_review_comment',
  'request_review',
  // [assistant-toolkit-2] Batch C: effort relations + mathref/backref.
  'add_relation',
  'remove_relation',
  'list_dependents',
  'cross_project_relations',
  'resolve_refs',
  'peek_ref',
  'list_backrefs',
  // [assistant-toolkit-2] Batch D: effort doc-pages + structure.
  'list_doc_pages',
  'get_doc_page',
  'create_doc_page',
  'update_doc_page',
  'delete_doc_page',
  'reorder_doc_pages',
  'get_structure',
  'update_structure',
  'update_step_status',
];

const THREAD_TOOLS = [...PROJECT_TOOLS];

const PROGRAM_TOOLS = [
  ...PERSONAL_TOOLS,
  'get_program_index',
  'list_programs',
  'read_program',
  'get_project_index',
  'read_wiki_page',
  'read_effort',
  'read_effort_graph',
  'search_wiki',
  'search_efforts',
  'search_forum',
];

const TOOLS_BY_CONTEXT: Record<ChatContextType, string[]> = {
  personal: PERSONAL_TOOLS,
  project: PROJECT_TOOLS,
  thread: THREAD_TOOLS,
  program: PROGRAM_TOOLS,
};

// ========== Tool Accessor ==========

export function getToolsForContext(context: ChatContextType): string[] {
  return TOOLS_BY_CONTEXT[context] ?? PERSONAL_TOOLS;
}

// ========== System Prompt Builder ==========

// IMPL [quick-win-5] Multi-step task guidance: encourage TodoWrite usage so the user
// gets visibility into the agent's plan and progress.
export const MULTI_STEP_GUIDANCE = `

# Planning multi-step work

If the user's request needs 2+ distinct steps (research → synthesize → answer; gather data → analyze → write up; etc.), CALL \`todo_write\` UP FRONT with the full plan. Then update it as you go:
- Mark exactly ONE item as \`in_progress\` at a time.
- Move items to \`completed\` immediately after finishing them.
- Add new items if the plan expands; mark obsolete ones \`cancelled\`.
- Re-call \`todo_write\` with the FULL list each time (replace semantics).

Do NOT use todos for trivial single-step tasks (one tool call, one search, etc.). Skip todos when the answer is conversational.

# Persisting intermediate results

When you discover something the LLM will need later (paper notes, derivations, partial answers) and risk losing it to context compaction, write it to the scratchpad:
- \`scratchpad_write(key, content)\` — overwrite-by-key.
- \`scratchpad_read(key)\` / \`scratchpad_list()\` — recall.

# PDFs

For arXiv PDFs or other PDF URLs, use \`read_pdf\` to extract text + metadata before reasoning about contents.`;

export function buildSystemPrompt(input: PromptBuilderInput): string {
  // IMPL [quick-win-5] Append shared multi-step guidance to all contexts.
  const base = buildSystemPromptBase(input);
  // IMPL [pworkspace-mvp] Append workspace status hint after multi-step guidance
  // so it appears late in the prompt (LLMs weight late context). Stays additive
  // — the quick-win-5 multi-step block is unchanged.
  return base + MULTI_STEP_GUIDANCE + buildWorkspaceStatusSection(input.workspaceStatus);
}

export function buildSystemPromptBase(input: PromptBuilderInput): string {
  switch (input.context) {
    case 'personal':
      // IMPL [quick-win-4] Removed Wolfram from sandboxed environments listing.
      // IMPL [pworkspace-mvp] Removed SageMath — not in MVP sandbox image.
      return 'You are the personal AI Research Assistant on Mathub, a collaborative math research platform.\n\nYou can search papers (search_arxiv), explore public/discoverable efforts and forum discussions, access the current user publications and knowledge base, and run Python code in a sandboxed environment when the workspace is enabled.\n\nUse LaTeX notation freely. Be mathematically precise but accessible.';

    case 'project': {
      const title = input.projectTitle || input.projectId || 'this project';
      return `You are the AI Research Assistant for the project "${title}" on Mathub.\n\nYou have full access to this project. Start by calling get_project_index to understand the project structure, then use read_wiki_page, read_effort, read_thread to read specific items, and search_wiki, search_efforts, search_forum to search.\n\nAlso available: search_arxiv (external papers), query_database (project metrics), create_effort (create new work), run_latex (render LaTeX), deep_research (in-depth research).\n\nUse LaTeX notation freely. Be mathematically precise but accessible.`;
    }

    case 'thread': {
      const threadTitle = input.threadTitle || input.threadId || 'this thread';
      const projectTitle = input.projectTitle || input.projectId || 'its project';
      return `You are assisting with a discussion thread "${threadTitle}" in project "${projectTitle}" on Mathub.\n\nYou have full access to the project this thread belongs to. You can read the thread content, explore project data, search papers, and more.\n\nUse LaTeX notation freely. Be mathematically precise but accessible.`;
    }

    case 'program': {
      const title = input.programTitle || input.programId || 'this program';
      return `You are the AI Research Assistant for research program "${title}" on Mathub.\n\nStart by calling get_program_index to understand the program structure. You can see all projects under this program, compare efforts across projects, and search across the platform. Use read_program for detailed program metadata, get_project_index to dive into individual projects, and search_wiki/search_efforts/search_forum to search across the program.\n\nUse LaTeX notation freely. Be mathematically precise but accessible.`;
    }

    default:
      return 'You are the personal AI Research Assistant on Mathub, a collaborative math research platform.\n\nUse LaTeX notation freely. Be mathematically precise but accessible.';
  }
}

// IMPL [pworkspace-mvp] Workspace status guidance. Conditionally attached to
// every system prompt so the LLM understands sandbox tool availability.
export function buildWorkspaceStatusSection(status?: WorkspaceStatusHint): string {
  if (!status) return '';
  if (!status.enabled) {
    return `\n\n# Personal Workspace\n\nThe user has not enabled the AI workspace. Sandbox tools (run_python, workspace_*) will not work in this conversation. If the user asks you to run code or save files, briefly explain that they need to enable the AI workspace under Settings → AI Workspace, then offer the best non-sandbox alternative (explain the result, write the code as a snippet, etc.). Do not attempt to call sandbox tools.`;
  }
  if (status.state === 'running') {
    return `\n\n# Personal Workspace\n\nYou have a persistent personal workspace at \`~/workspace\` (also reachable via the workspace_* tools). Files written there survive across conversations. Use it for intermediate scripts, derivations, datasets, and notes the user may want to revisit. Long-term memory lives in \`~/memory\` (read-only unless tools say otherwise).`;
  }
  if (status.state === 'provisioning' || status.state === 'stopped' || status.state === 'not_provisioned') {
    return `\n\n# Personal Workspace\n\nThe user's workspace is not yet running. The first sandbox tool call this turn may take a few seconds while the container starts. After that, files at \`~/workspace\` persist across conversations.`;
  }
  // archived / destroyed — treat as unavailable.
  return `\n\n# Personal Workspace\n\nThe user's workspace is currently unavailable (state: ${status.state}). Avoid sandbox tool calls.`;
}
