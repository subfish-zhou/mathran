/**
 * ContextFragment — the unit of dynamic system-prompt content.
 *
 * Codex parity: `codex-rs/core/src/context/`. Each thing that wants to inject
 * text into the LLM's system prompt (persona, workspace hint, user memories,
 * active skills, goal nudges, etc.) is a fragment with a stable id and an
 * explicit priority. The ContextManager (manager.ts) gathers them at render
 * time and stitches them in priority order.
 *
 * The point of this abstraction is NOT to be clever. It's to replace the
 * current pile of if-then string concatenations in executor.ts +
 * chat-handler.ts with one place that decides order + budget. Adding a
 * codex parity fragment (image_generation_instructions, hook context,
 * subagent notification, ...) becomes "new file + register in boot.ts".
 *
 * Ported: 2026-06-10 (commit 11a/sprint-3 of mathub-ai-codex-upgrade).
 */

import type { WorkspaceStatusHint } from "../prompt-builder";

/**
 * Priority namespaces for ordering fragments in the final system block.
 * Lower numbers render first. Convention:
 *   0..49    : persona / role
 *   50..99   : multi-step / planning guidance (kept tight against persona
 *              for byte-level parity with prompt-builder.ts:212
 *              buildSystemPrompt() which appends MULTI_STEP_GUIDANCE
 *              directly after base before workspace).
 *   100..199 : workspace / environment
 *   200..299 : user memory / preferences
 *   300..399 : skill / capability hints
 *   500..549 : turn-time hints (goal nudge)
 *   550..599 : sub-agent specific (avoid hint)
 *   600+     : late / closing reminders
 */
export const FragmentPriority = {
  Persona: 0,
  MultiStep: 50,
  Workspace: 100,
  UserMemory: 200,
  Skills: 300,
  GoalNudge: 500,
  AvoidHint: 550,
  Closing: 600,
  HookContext: 700,
  ImageOutputHint: 750,
  SubagentNotification: 800,
} as const;

export type FragmentChatContext = "personal" | "project" | "thread" | "program";

export interface SkillLite {
  name: string;
  body: string;
  /**
   * Reference filenames available via load_skill_reference, as a flat
   * string array. Matches the shape the executor passes
   * (`Object.keys(skill.references)`).
   */
  references?: string[];
}

export interface TurnFragmentState {
  /** The current user message. Lets memory / skill fragments key off intent. */
  queryText?: string;
  /** Goal provider's "missing X" hint, injected late as a system nudge. */
  goalNudgeHint?: string;
  /** Sub-agent: things the spawned agent should NOT do. */
  avoidHint?: string;
  /** Skills selected by the matcher this turn. */
  matchedSkills?: SkillLite[];
  /** Optional pre-built section header for skills (legacy compat). */
  skillSystemSection?: string;
  /**
   * [commit-12] Hook outcomes: developer-role context to inject after a
   * tool turn. Each entry becomes a paragraph in the rendered fragment.
   */
  hookAdditionalContext?: string[];
  /**
   * [commit-12] Sub-agent stop notifications buffered between turns.
   * Rendered as JSON inside <subagent_notification> markers.
   */
  subagentNotifications?: SubagentNotificationPayload[];
  /**
   * [commit-12] Output files produced by the previous tool call. Rendered
   * as a hint so the LLM knows which files exist and how to reference them.
   */
  imageOutputs?: ToolOutputFileHint[];
}

/**
 * Payload for one sub-agent stop notification. Matches the codex-rs
 * `subagent_notification.rs` JSON shape (snake_case keys).
 */
export interface SubagentNotificationPayload {
  agentReference: string;
  status: "completed" | "failed" | "cancelled";
  durationMs?: number;
  totalTokens?: number;
  resultPreview?: string;
}

/**
 * Hint about an output file emitted by the previous tool call.
 */
export interface ToolOutputFileHint {
  name: string;
  mimeType: string;
  bytes?: number;
  path?: string;
}

export interface FragmentRenderInput {
  context: FragmentChatContext;
  userId?: string;
  projectId?: string | null;
  projectTitle?: string | null;
  programId?: string | null;
  programTitle?: string | null;
  threadId?: string | null;
  threadTitle?: string | null;
  workspaceStatus?: WorkspaceStatusHint;
  /** Turn-time bag. Optional per-fragment. */
  turnState?: TurnFragmentState;
}

export interface ContextFragment {
  /** Stable id (used for register/unregister + audit log). */
  id: string;
  /** Lower = renders earlier in the system block. See FragmentPriority. */
  priority: number;
  /**
   * When 'persistent', the fragment renders at conversation-bootstrap time
   * (chat-handler.ts initial system message). When 'turn-time', it renders
   * on each turn at the call site (executor.ts, sub-agent spawn).
   *
   * Both flavors live in the same registry so `list()` can audit them in
   * one place; the manager exposes renderPersistent() and renderTurnTime()
   * helpers that filter.
   */
  scope: "persistent" | "turn-time";
  /**
   * Render the fragment. Return '' to skip. MUST be deterministic given
   * the same input (no Date.now / random / network calls except the
   * specific I/O that defines this fragment — e.g. user-memory's DB read).
   */
  render(input: FragmentRenderInput): Promise<string> | string;
}
