/**
 * ChatSession — Mathran's lightweight conversational kernel.
 *
 * Shared by the CLI REPL/`-p` one-shot path and (soon) the `serve` chat panel:
 * both consume the same `AsyncIterable<ChatEvent>` from `send()`.
 *
 * This is deliberately NOT the full agent loop (`src/lib/agent/executor.ts`),
 * which depends on the `_stubs/` platform bindings and throws at runtime. The
 * kernel only does:
 *   messages history  +  LLMProvider.stream  +  a small, injectable tool set.
 *
 * Tool dispatch uses OpenAI-style function-calling (the `tool-call` chunks the
 * LLM adapters already emit). When a turn finishes with tool calls, each tool
 * is executed, its result is fed back as a `tool` message, and the LLM is
 * called again — until it produces a turn with no tool calls.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { atomicWriteFile } from "./atomic-write.js";
import type {
  LLMProvider,
  LLMMessage,
  LLMRequest,
  LLMStreamChunk,
  MessageContent,
  ContentPart,
} from "../providers/llm.js";
import { contentToString } from "../providers/llm.js";
import type { ReasoningEffortLevel } from "../reasoning-effort/index.js";
import { capToolOutput } from "./tool-output-cap.js";
import type { TodoList } from "./tools/todo-write.js";
import { renderTodoSnapshot } from "./tools/todo-write.js";
import {
  compactRunner,
  LocalCompactionStrategy,
  type CompactRunnerInput,
  type CompactedArtifact,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_KEEP_RECENT_ROUNDS,
} from "../subagent/runners/compact.js";
import {
  ensureBuiltInsRegistered,
  pickStrategy,
} from "../subagent/runners/compact-strategies.js";
import { injectionPolicyForPhase } from "../subagent/runners/compact-injection.js";
import type {
  CompactionHooks,
  CompactionOutcome,
  CompactionPhase,
  CompactionReason,
  CompactionRequest,
  CompactionTrigger,
} from "../subagent/runners/compact-types.js";
import { readSummarizeRunner } from "../subagent/runners/read-summarize.js";
import { searchRunner } from "../subagent/runners/search.js";
import { SubagentRegistry } from "../subagent/registry.js";
import { SubagentScheduler } from "../subagent/scheduler.js";
import { readArtifact } from "../subagent/artifact.js";
import {
  loadMathranMemorySync,
  formatMathranMemory,
  loadLayeredMathranMemorySync,
  formatLayeredMathranMemory,
} from "../memory/index.js";
import {
  formatSkillsForPrompt,
  type LoadedSkill,
} from "../skills/loader.js";
import {
  matchSkillTriggers,
  renderSkillPrompt,
  isAlwaysSkill,
} from "../skills/trigger.js";
import { registerSkillToolRules } from "../skills/temp-approval.js";
import { createBashTool } from "./tools/bash.js";
import { createReadFileTool } from "./tools/read-file.js";
import { createWriteFileTool } from "./tools/write-file.js";
import { createEditFileTool } from "./tools/edit-file.js";
import { createApplyPatchTool } from "./tools/apply-patch.js";
import { createReadWikiPageTool } from "./tools/read-wiki-page.js";
import { createListWikiPagesTool } from "./tools/list-wiki-pages.js";
import { createCreateWikiPageTool } from "./tools/create-wiki-page.js";
import { createUpdateWikiPageTool } from "./tools/update-wiki-page.js";
import { createDeleteWikiPageTool } from "./tools/delete-wiki-page.js";
import { createSearchWikiTool } from "./tools/search-wiki.js";
import { createListEffortsTool } from "./tools/list-efforts.js";
import { createReadEffortTool } from "./tools/read-effort.js";
import { createCreateEffortTool } from "./tools/create-effort.js";
import { createUpdateEffortDocumentTool } from "./tools/update-effort-document.js";
import { createAppendEffortDocumentTool } from "./tools/append-effort-document.js";
import { createUpdateEffortMetadataTool } from "./tools/update-effort-metadata.js";
import { createTransitionEffortStatusTool } from "./tools/transition-effort-status.js";
import { createSnapshotEffortTool } from "./tools/snapshot-effort.js";
import { createListEffortVersionsTool } from "./tools/list-effort-versions.js";
import { createReadEffortVersionTool } from "./tools/read-effort-version.js";
import { createAddEffortRelationTool } from "./tools/add-effort-relation.js";
import { createListEffortRelationsTool } from "./tools/list-effort-relations.js";
import { createListProjectsTool } from "./tools/list-projects.js";
import { createReadProjectMetadataTool } from "./tools/read-project-metadata.js";
import { createUpdateProjectMetadataTool } from "./tools/update-project-metadata.js";
import { createListDocPagesTool } from "./tools/list-doc-pages.js";
import { createReadDocPageTool } from "./tools/read-doc-page.js";
import { createCreateDocPageTool } from "./tools/create-doc-page.js";
import { createUpdateDocPageTool } from "./tools/update-doc-page.js";
import { createDispatchSubagentTool } from "./tools/dispatch-subagent.js";
import { createGetSubagentResultTool } from "./tools/get-subagent-result.js";
import {
  AskUserPending,
  ASK_USER_PENDING_PLACEHOLDER,
  createAskUserTool,
  isAskUserPending,
  type AskUserResolver,
} from "./tools/ask-user.js";
import { createProposeGoalTool } from "./tools/propose-goal.js";
import { createGoalSendMessageTool } from "./tools/goal-send-message.js";
import { createProposePlanTool } from "./tools/propose-plan.js";
import { createMemoryListTool } from "./tools/memory-list.js";
import { createMemoryReadTool } from "./tools/memory-read.js";
import { createUserProfileReadTool } from "./tools/user-profile-read.js";
import { createUserProfileSearchTool } from "./tools/user-profile-search.js";
import { createReadPaperTexTool } from "./tools/read-paper-tex.js";
import { createEffortDepNeighborsTool } from "./tools/effort-dep-neighbors.js";
import { createMemoryWriteTool } from "./tools/memory-write.js";
import { createMemoryAppendTool } from "./tools/memory-append.js";
import { createMemorySearchTool } from "./tools/memory-search.js";
import { createScratchpadReadTool } from "./tools/scratchpad-read.js";
import { createScratchpadWriteTool } from "./tools/scratchpad-write.js";
import { createRunPythonTool } from "./tools/run-python.js";
import { createRunLatexTool } from "./tools/run-latex.js";
import { createInstallPythonPackageTool } from "./tools/install-python-package.js";
import { createSearchWebTool } from "./tools/search-web.js";
import { createVerifyPageTool } from "./tools/verify-page.js";
import { createSearchArxivTool } from "./tools/search-arxiv.js";
import { createGlobTool } from "./tools/glob.js";
import { createGrepTool } from "./tools/grep.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createPdfExtractTool } from "./tools/pdf-extract.js";
import {
  createCompletePlanTool,
  createEnterPlanModeTool,
} from "./tools/plan-mode-tools.js";
import { createGitTools } from "./tools/git-tools.js";
import { createCodeModeTool } from "../code-mode/code-mode-tool.js";
import { wrapMutateTool } from "../checkpoints/middleware.js";
import { ApprovalBroker } from "./approval-broker.js";
import type { HookInvoker } from "../hooks/executor.js";
import { formatHookBlock } from "../hooks/executor.js";
import type { RiskClass, ApprovalRequest, ApprovalDecision, ApprovalResolver } from "../approval/types.js";
import {
  buildWriteProposal,
  type WriteProposal,
  type WriteProposalDecision,
} from "../approval/diff-preview.js";
import type { Outcome } from "../outcomes/schema.js";
import type { BackgroundSubagentRegistry } from "../subagent/background.js";
import type { ProfileEffects } from "../profiles/types.js";
import { isMutatingCall } from "../profiles/profile-resolver.js";
import { buildProfileBanner } from "../profiles/profile-message.js";
import * as path from "node:path";

/**
 * Per-invocation context the kernel threads into a tool's `execute()`.
 *
 * `scope` lets tools resolve project/effort-relative paths (T1-D / BUG #7
 * fix): lean_check can `cd` into an effort's `files/` directory, wiki tools
 * can read pages in the current project, etc. When the host doesn't know its
 * scope (CLI one-shots, isolated test harnesses), this is `undefined` and
 * tools must default to a non-project sandbox.
 */
export interface ToolExecuteContext {
  /** Workspace root (absolute). */
  workspace?: string;
  /** Chat scope this invocation belongs to. */
  scope?: {
    kind: "global" | "project" | "effort";
    projectSlug?: string;
    effortSlug?: string;
  };
  /** v0.5 §7 — record that a path has been read this session. */
  recordRead?: (path: string) => void;
  /** v0.5 §7 — query whether a path has been read this session. */
  hasRead?: (path: string) => boolean;
  /** v0.16 §11 — provider-emitted tool-call id for this invocation, set
   *  by the session per call. The `ask_user` tool forwards it to its
   *  resolver so a serve host can build an `AskUserPending` carrying a
   *  stable placeholder key the resume endpoint can patch back into
   *  history. Optional because callers outside the session loop (tests,
   *  direct `.execute()` probes) may not set it. */
  toolCallId?: string;
  /**
   * Hooks runner threaded in by the session so tools can fire `pre-edit` /
   * `post-edit` / `pre-bash` / `pre-commit` hooks around their work. Absent
   * when no hooks are configured (or in isolated test harnesses), in which
   * case tools must behave exactly as before.
   */
  hooks?: HookInvoker;
}

/** A tool the model can invoke. Parameters are a JSON-schema object. */
export interface ToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  /**
   * Coarse risk bucket driving the approval policy (Approval Policy 矩阵).
   * Optional for backward-compat: a tool without a `riskClass` is treated as
   * `read` by the approval broker (the most permissive bucket) so legacy /
   * third-party tools never accidentally gate. Builtin tools all set it.
   */
  riskClass?: RiskClass;
  /**
   * Plan-mode ACL flag (Part B1).
   *
   * When the chat session is in **plan mode** (a read-only "thinking"
   * phase opted into via `enter_plan_mode`), the dispatcher only allows
   * tools with `readOnly === true` to execute. All other tools (write,
   * exec, mutating semantics, side-effecting external calls) are blocked
   * with `PlanModeBlockedError`, surfaced back to the model as an
   * `ok: false` tool result so the loop can keep reasoning without
   * mutating state.
   *
   * Optional / defaults to `false`. Backward-compat: any tool that does
   * not opt in to `readOnly: true` is treated as mutating and therefore
   * blocked in plan mode. This conservative default mirrors Claude Code's
   * Plan Mode — unknown / un-classified tools are never silently allowed.
   *
   * Note: this is independent of `riskClass`. A tool may have
   * `riskClass: "read"` and still be `readOnly: false` (e.g.
   * `propose_goal` / `propose_plan` carry a read risk class but write
   * goal / plan records to disk on user confirmation). Always classify
   * `readOnly` by *side effects*, not by the approval risk bucket.
   */
  readOnly?: boolean;
  /**
   * Execute the tool. `args` is the parsed JSON arguments object (or `{}` if
   * the model emitted no/invalid JSON). `ctx` carries optional workspace/scope
   * hints — tools should treat it as advisory and fall back to safe defaults
   * when it's not set. Returns the textual result that is fed back to the
   * model plus an `ok` flag for callers/loggers.
   */
  execute(args: Record<string, unknown>, ctx?: ToolExecuteContext): Promise<{ ok: boolean; content: string }>;
}

/**
 * Part B1 — thrown by the dispatcher when a tool call is rejected because
 * the chat session is in plan mode and the tool is not `readOnly`. Callers
 * (the chat loop) catch this and surface it as a regular `ok: false` tool
 * result so the model can keep reasoning without mutating state.
 *
 * Hardening (2026-06-30): the error message uses the same "refused in plan
 * mode" phrasing as the user-facing tool result so logs and surface text
 * stay aligned.
 */
export class PlanModeBlockedError extends Error {
  readonly toolName: string;
  constructor(toolName: string) {
    super(
      `tool '${toolName}' refused in plan mode: mutating tools are blocked`,
    );
    this.name = "PlanModeBlockedError";
    this.toolName = toolName;
  }
}

/**
 * Plan-mode meta-tool whitelist (Hardening 2026-06-30).
 *
 * Tool names that are allowed to execute even while the session is in plan
 * mode, regardless of their `ToolSpec.readOnly` flag. These are the meta
 * affordances the LLM still needs while it's *planning*:
 *
 *   • `complete_plan`  — the escape hatch out of plan mode.
 *   • `enter_plan_mode` — idempotent re-entry (also readOnly:true, kept
 *                        here for explicitness).
 *   • `ask_user`       — clarification round-trip; already readOnly:true
 *                        but listed for explicitness so deny-by-default
 *                        readers see the policy in one place.
 *   • `todo_write`     — bookkeeping. `todo_write` is classified
 *                        `readOnly: false` (it writes a JSON file under
 *                        `.mathran/todos/`), but the file is conversation
 *                        scratch state, not workspace mutation; letting
 *                        the model maintain its in-flight plan list is
 *                        the whole point of plan mode.
 *
 * The whitelist is an additive layer on top of the `readOnly === true`
 * gate: a tool passes plan-mode gating if EITHER `readOnly === true` OR
 * its name is in this set. Everything else (`write_file`, `edit_file`,
 * `bash`, `run_python`, `run_latex`, `dispatch_subagent`, `propose_goal`,
 * `propose_plan`, …) is hard-rejected with `PlanModeBlockedError`.
 */
export const PLAN_MODE_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  "complete_plan",
  "enter_plan_mode",
  "ask_user",
  "todo_write",
]);

/**
 * Minimal subagent-result shape carried on the `subagent-completed` ChatEvent
 * (#3). A trimmed projection of `SubagentResult` so the host SSE layer can ship
 * the essentials without the SPA depending on the full kernel type.
 */
export interface SubagentResultLite {
  status: string;
  summary: string;
  artifactPath: string | null;
  durationMs?: number;
}

/**
 * Events streamed out of `send()`. Mirrors `LLMStreamChunk` and extends it with
 * `tool-result` so both the CLI and an HTTP transport can render the full turn.
 */
export type ChatEvent =
  | { type: "text"; delta: string }
  | {
      /** UX gap B — reasoning / chain-of-thought delta. Mirrors the
       *  provider `reasoning` stream chunk (Anthropic `thinking_delta`,
       *  OpenAI / Copilot `reasoning_content`). The host SSE layer passes
       *  it straight through so the SPA can render a collapsed "💭 reasoning"
       *  panel. Accumulated onto the assistant message's `reasoning` field
       *  for jsonl persistence; disposable (first dropped on compaction) and
       *  never replayed back to the provider. */
      type: "reasoning";
      delta: string;
    }
  | { type: "tool-call"; id: string; name: string; args: string }
  | { type: "tool-result"; id: string; name: string; ok: boolean; content: string }
  | {
      /** 2026-06-25 — emitted right after a successful `write_file` /
       *  `edit_file` tool call so the SPA can render a structured
       *  download chip (filename + size + Download / Copy-path buttons).
       *
       *  Why a side-channel event instead of stuffing fields into
       *  `tool-result`: the existing ToolResult shape is `{ok, content:
       *  string}` and every adapter / persistence path treats `content`
       *  as opaque text. Adding a structured payload there would ripple
       *  through six call sites. A separate event leaves the existing
       *  invariant intact and lets the SPA opt-in cleanly.
       *
       *  Both `path` and `relPath` are emitted so the SPA can show the
       *  short name and the absolute path tooltip without re-parsing.
       *  `bytes` is post-write file size; `mime` is best-effort from
       *  the file extension. The SPA renders the FileBubble below
       *  the corresponding tool-result bubble. */
      type: "file-written";
      toolCallId: string;
      path: string;
      relPath: string;
      filename: string;
      bytes: number;
      mime: string;
    }
  | {
      /** Approval Policy 矩阵 — emitted just before the host prompts the user
       *  to approve a high-risk tool call. Lets the SPA render its
       *  `ApprovalDialog` (serve) / observers log the request. CLI hosts use
       *  their readline resolver and may ignore this event. */
      type: "approval_request";
      request: ApprovalRequest;
    }
  | {
      /** Approval Policy 矩阵 — emitted after a tool call's approval is
       *  resolved (allowed / denied / deferred), carrying the decision so the
       *  SPA can dismiss its modal and observers can audit the outcome. */
      type: "approval_resolved";
      id: string;
      decision: ApprovalDecision;
    }
  | {
      /** UX gap A — Diff preview before file write. Emitted just before an
       *  already-authorised write_file / edit_file call executes, when its
       *  matching `allow` rule carries `requireDiffPreview: true`. Carries the
       *  unified diff + truncated old/new content so the SPA renders a
       *  `DiffPreviewModal`; the session then BLOCKS on the
       *  {@link writeProposalResolver} until the user accepts / declines / edits.
       *  CLI / goal hosts without a resolver never see this — the write just
       *  runs. */
      type: "propose-write";
      proposal: WriteProposal;
    }
  | {
      /** UX gap A — emitted right after a `propose-write` is resolved, carrying
       *  the user's verdict so the SPA can dismiss the modal and observers can
       *  audit it. `accept` (optionally with edited content) runs the write;
       *  `decline` reports a rejection to the model. */
      type: "propose-write-resolved";
      toolCallId: string;
      decision: WriteProposalDecision;
    }
  | {
      /** v0.16 §11 — the model called `ask_user`; the host (serve) will
       *  persist a pending annotation and end the stream so the user can
       *  reply via `POST /answer-ask`. CLI / goal hosts never see this
       *  event because their resolvers return synchronously.
       *
       *  v0.19 Codex parity — when the model supplied a structured
       *  `options` / `default` / `timeoutSeconds` / `allowCustom`, those
       *  flow through the event so SSE consumers (the SPA's
       *  ToolCallDisplay askPending card) can render the richer UI
       *  without having to refetch the conversation annotations
       *  sidecar. All four fields are optional — a plain
       *  `ask_user({ question })` call still emits the same shape it
       *  always did. */
      type: "ask_user";
      id: string;
      name: string;
      question: string;
      options?: string[];
      default?: string;
      timeoutSeconds?: number;
      allowCustom?: boolean;
    }
  | {
      /** v0.17 mathub parity W7 — emitted by the *goal* runner (NOT the
       *  chat session) at the top of every goal round so the SPA can
       *  render the `Step N/MAX · ⏱ Xs` status strip. `maxRounds` is
       *  optional: plain chat (single-round semantics) never emits this
       *  event; goal runs with no `roundsMax` budget emit `round` without
       *  a cap. W9 (Live Steering) extends ChatEvent further with
       *  `steer-received` — this case stays additive and unaffected. */
      type: "round-start";
      round: number;
      maxRounds?: number;
    }
  | {
      /** v0.17 mathub parity W9 — emitted by `runRounds` whenever a
       *  `SendOpts.steerProbe` returns a non-empty string at a round
       *  boundary. The runner injects the steer text as a synthetic
       *  `[Steer from user: …]` user message into history BEFORE the
       *  next LLM request, then yields this event so the SPA can
       *  dismiss its "queued" toast + render a "📣 Steered" badge on
       *  the next round bubble. The injected user message also lands
       *  in the persisted conversation jsonl as a normal user turn so
       *  reloads see what the user actually steered with. */
      type: "steer-received";
      text: string;
    }
  | {
      /** outcomes 收尾 C-2 — emitted by the *host* SSE layer (NOT the kernel)
       *  when a background self-grade round lands an Outcome on disk while a
       *  stream is open. The kernel never yields this itself; it lives in the
       *  union so `serve.ts` can write it through the same typed `writeSSE`
       *  envelope and the SPA can switch on it. The SPA filters on `goalId`,
       *  toasts `📊 Goal graded: X/5`, and refreshes its outcomes list. */
      type: "goal-graded";
      goalId: string;
      outcome: Outcome;
    }
  | {
      /** Background Agents (#3) — emitted by the *host* SSE layer (NOT the
       *  kernel) when a background subagent dispatched from this conversation
       *  reaches a terminal state. Lives in the union so `serve.ts` can write
       *  it through the same typed `writeSSE` envelope. The SPA filters on
       *  `subagentId`, toasts completion, and flips the panel row to its
       *  terminal colour. `result` is the bounded scheduler summary (omitted
       *  for pure cancels that never produced one). */
      type: "subagent-completed";
      subagentId: string;
      status: "done" | "failed" | "cancelled";
      durationMs: number;
      result?: SubagentResultLite;
    }
  | {
      /** Defect #1 — token accounting. Emitted once per LLM round-trip
       *  inside `send()` (i.e. once per `llm.chat()` call), carrying the
       *  provider-reported usage so the goal runner can sum REAL token
       *  consumption (system prompt + full history + tool calls + output)
       *  instead of re-estimating only the (user, final-assistant) pair.
       *  `inputTokens` / `outputTokens` are undefined when the provider
       *  didn't return a `usage` block; the count of these events still
       *  equals the number of assistant turns / LLM calls this `send()`
       *  made, so the runner can populate `assistantTurnsTotal` /
       *  `llmCallsTotal` regardless of token availability. */
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      /** TODO-2 §3.2 / C8 — compaction lifecycle event. Emitted by
       *  compactV2() when a compaction attempt completes (success OR
       *  failure). Carries the full telemetry so the goal runner can
       *  bump compactionRuns / compactionTokensDropped and the SSE
       *  layer can push a real-time badge to the SPA. NOT emitted
       *  for noop (droppedRoundCount=0) compactions — those are
       *  silent. */
      type: "compaction";
      outcome: "ok" | "skipped" | "cancelled" | "failed";
      reason: string;
      phase: string;
      trigger: string;
      policy: string;
      originalTokens: number;
      newTokens: number;
      droppedRoundCount: number;
      durationMs: number;
      summaryTokens?: number;
    }
  | {
      /** Layer 1 — token budget continuation. Emitted by the goal runner
       *  (NOT the chat session) when a `mark_done` is blocked because the
       *  goal hasn't yet spent 90% of `budget.tokensMax`. The runner injects
       *  a nudge user message into history and reschedules the next
       *  iteration; this event lets the daemon log + SSE layer surface a
       *  "💰 N continuation(s)" badge. */
      type: "budget-continuation";
      goalId: string;
      pct: number;
      continuationCount: number;
      tokensUsed: number;
      budget: number;
    }
  | {
      type: "done";
      finishReason: Extract<LLMStreamChunk, { type: "done" }>["finishReason"];
    };

export interface ChatSessionOptions {
  llm: LLMProvider;
  model?: string;
  tools?: ToolSpec[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Reasoning-effort budget (#6): `low | medium | high | max`. A pure
   * passthrough threaded into every `LLMRequest` so the provider adapter can
   * inject its "think harder" fields. Can be changed live via {@link
   * ChatSession.setEffort} (the `/effort` slash command). Omitting it sends no
   * `effort` on the wire (provider defaults apply).
   */
  effort?: ReasoningEffortLevel;
  /** Safety cap on tool-call round-trips per `send()`. Default 8. */
  maxToolRounds?: number;
  /**
   * Per-session context threaded into every `tool.execute()` call. The host
   * (the `serve` route or CLI) supplies this so tools resolve relative paths
   * inside the right project/effort directory (T1-D / BUG #7 fix).
   */
  toolContext?: ToolExecuteContext;
  /**
   * Stable identifier for this session, used to namespace spilled tool-output
   * dumps under `<workspace>/.mathran/tool-output/<sessionId>/`. Defaults to a
   * generated UUID when omitted.
   */
  sessionId?: string;
  /**
   * Tool-result hard cap (v0.2 §2). When set, every tool result is passed
   * through `capToolOutput()` before being pushed into history: the inline
   * portion is truncated to `maxInlineBytes` (default 4096) and, when a
   * `workspace` is given, the full output is spilled to disk. When this option
   * is *undefined*, tool results are stored verbatim (backward-compatible).
   */
  toolOutputCap?: { maxInlineBytes?: number; workspace?: string | null };
  /**
   * Auto-compact (v0.2 §5 + TODO-2 §3.2). When `enabled: true`, every
   * `send()` call checks the token count of `this.messages` against
   * `contextWindow * thresholdPct` and runs `compactV2({ phase: "pre_turn" })`
   * first if we'd overflow. Requires the wrapped LLMProvider to implement
   * `countTokens`; falls back to a silent no-op when the provider can't
   * count tokens. Defaults: thresholdPct=0.75, keepRecentRounds=5,
   * contextWindow=200000.
   *
   * TODO-2 §3.2 mid-turn precheck (opt-in): when `enableMidTurnPrecheck`
   * is true, every LLM round-trip inside a `send()` loop also tallies the
   * provider-reported input token count and runs an extra mid-turn
   * compaction when the cumulative tally exceeds
   * `midTurnThresholdPct * contextWindow` (default = thresholdPct + 0.05).
   * This is the codex InitialContextInjection::BeforeLastUserMessage path:
   * summary is spliced INSIDE the tail just above the last real user
   * message so the model stays in-distribution.
   */
  autoCompact?: {
    enabled?: boolean;
    thresholdPct?: number;
    keepRecentRounds?: number;
    contextWindow?: number;
    /** TODO-2 §3.2 — opt in to mid-turn precheck (default false). */
    enableMidTurnPrecheck?: boolean;
    /** TODO-2 §3.2 — mid-turn trigger threshold (default thresholdPct + 0.05). */
    midTurnThresholdPct?: number;
    /**
     * 2026-06-29 (codex-parity) — absolute pre-turn trigger in tokens.
     * When set, takes precedence over `thresholdPct * contextWindow`:
     * compact when `countTokens(messages) >= absoluteThresholdTokens`.
     * Matches codex's `model_auto_compact_token_limit` semantics
     * (see ~/code/codex/codex-rs/core/src/session/turn.rs
     * auto_compact_token_status). Use for cases where the user wants
     * compaction at an explicit token count rather than a fraction of
     * a model's nominal context window.
     */
    absoluteThresholdTokens?: number;
    /**
     * 2026-06-29 — absolute mid-turn trigger in tokens. When set with
     * `enableMidTurnPrecheck=true`, mid-turn compaction fires when
     * cumulative provider-reported input tokens crosses this value.
     * Falls back to `midTurnThresholdPct * contextWindow` when unset.
     */
    midTurnAbsoluteThresholdTokens?: number;
  };
  /**
   * Workspace root for subagent artifacts (v0.2 §5). Required for `compact()`
   * to write the compacted-history artifact. When omitted, `compact()` falls
   * back to a per-session temp dir.
   */
  workspace?: string;
  /**
   * 2026-06-30 — Sandbox v1 (Bubblewrap) for mutating exec tools.
   *
   * When supplied with `enabled: true`, `bash` / `run_python` / `run_latex`
   * / `lean_check` route their child-process spawns through
   * `spawnSandboxed` from `src/core/sandbox/`. When omitted or
   * `enabled: false`, the tools fall through to raw `spawn(...)` — same
   * behaviour as pre-2026-06-30 mathran. See `docs/sandbox.md`.
   */
  sandbox?: import("../sandbox/index.js").SandboxConfig;
  /**
   * Plan-tracker bug fix (2026-06-30) — supplier of the current todo list
   * request and injects a short snapshot of unfinished items as a
   * transient `system` message at the end of `messages`, so the model
   * actually sees the in-flight plan when it's deciding what to do next.
   *
   * Without this hook, the only signal the LLM gets after writing a plan
   * is the one-line tool result (`"4 todos · 1 in_progress, 3 pending"`)
   * tucked deep in history — which it forgets a few rounds later, leaving
   * conversations with `in_progress` items that never flip to `done`.
   *
   * The hook is async (callers typically `await loadTodos(...)`); errors
   * are caught and skipped — a snapshot failure must never break a turn.
   * The injected message is removed from history after the turn so a long
   * thread doesn't accumulate stale snapshots.
   *
   * Wired by `serve.ts` and `goal/runner.ts` with the same
   * (workspace, scope, conversationId) tuple they pass to
   * `createTodoWriteTool`. Omit in tests / CLI one-shots that don't
   * persist todos.
   */
  todoSnapshot?: () => Promise<TodoList | null>;
  /**
   * TODO-2 §3.2 / C8 — observer for compaction lifecycle events. Invoked
   * synchronously after every compactV2() attempt (success OR failure)
   * with a `{ type: "compaction", ... }` ChatEvent. Goal-mode runner
   * wires this to its `emit()` so SSE clients see compaction in real
   * time and `updateGoalStats` can bump `compactionRuns`. Listener
   * exceptions are caught — never block the send loop.
   *
   * Noop compactions (droppedRoundCount=0) are NOT reported here to
   * avoid noise.
   */
  onCompactionEvent?: (ev: ChatEvent & { type: "compaction" }) => void;
  /**
   * Optional injected subagent scheduler. Tests pass a custom one; production
   * code lets ChatSession build its own (with the compact runner registered)
   * lazily on first compact.
   */
  subagentScheduler?: SubagentScheduler;
  /**
  /**
   * Opt-in built-in tools the LLM can call (v0.2 §8 onward). Each switch is
   * default-off; enabling one injects a {@link ToolSpec} into the per-turn
   * tool list. Built-in tools require `subagentScheduler` to be wired
   * (production code) or the lazy scheduler from `getOrBuildScheduler`
   * (tests) — when the requirement is unmet, the tool is silently dropped to
   * keep this purely additive.
   *
   *   - `search` — dispatches the `search` subagent runner (Task 8).
   *   - `read_file_summary` — dispatches the `read_summarize` runner (Task 9).
   *   - `bash` (v0.4 §1) — `bash -lc` shell, workspace-scoped, capped output.
   *   - `read_file` (v0.4 §1) — raw bytes with `cat -n` line numbers.
   *   - `write_file` (v0.4 §1) — create / overwrite UTF-8 file.
   *   - `edit_file` (v0.4 §1) — unique-string replace (or `replace_all`).
   *   - `dispatch_subagent` (v0.5 wire-up Gap #4 + #5) — generic dispatch
   *     into the subagent scheduler (compact/search/read_summarize/research/
   *     lean_explore), optional subprocess runtime. Requires
   *     `opts.scheduler` to be wired; otherwise the tool is silently skipped
   *     with a console warning (purely additive — no crash).
   */
  builtinTools?: {
    search?: boolean;
    read_file_summary?: boolean;
    bash?: boolean;
    read_file?: boolean;
    write_file?: boolean;
    edit_file?: boolean;
    /**
     * V4A multi-file patch tool (`apply_patch`). Lets the model apply
     * Add / Update / Delete / Move in a single tool call. Parses the
     * Codex V4A grammar, runs phase-1 in-memory validation against the
     * workspace, then commits atomically. Fuzzy line matching tolerates
     * whitespace / indentation / unicode / line-similarity drift via
     * the same 9-strategy chain the Hermes patch tool uses.
     *
     * Counted as a write tool — wrapped in checkpoint capture when
     * `opts.checkpoints` is configured so `/diff` and `/rewind` cover
     * multi-file mutations the same way they cover write_file /
     * edit_file.
     */
    apply_patch?: boolean;
    /**
     * Gap #1 (wiki / effort / project chat tools) — enables 25 LLM-callable
     * tools that wrap the wiki/effort/project filesystem stores into chat
     * shape so the model can read+write project content directly without an
     * HTTP round-trip through the REST layer.
     *
     * Tools registered (when `true`):
     *   - Wiki (6):    read_wiki_page, list_wiki_pages, create_wiki_page,
     *                  update_wiki_page, delete_wiki_page, search_wiki
     *   - Effort (12): list_efforts, read_effort, create_effort,
     *                  update_effort_document, append_effort_document,
     *                  update_effort_metadata, transition_effort_status,
     *                  snapshot_effort, list_effort_versions,
     *                  read_effort_version, add_effort_relation,
     *                  list_effort_relations
     *   - Project (7): list_projects, read_project_metadata,
     *                  update_project_metadata, list_doc_pages,
     *                  read_doc_page, create_doc_page, update_doc_page
     *
     * All tools accept a builder-time `workspace` (baked from
     * `this.workspace`) and fall back to `ctx.workspace` then `process.cwd()`.
     */
    gap1_project_tools?: boolean;
    /**
     * `dispatch_subagent` (v0.5 wire-up Gap #4 + #5; #3 background). `true`
     * enables sync-only dispatch. Pass an object with `background` to also
     * allow `mode: "background"` — the run is tracked in the supplied registry
     * (scoped to `parentConversationId`) and a companion `get_subagent_result`
     * tool is exposed so the LLM can poll it. Requires `opts.scheduler`.
     */
    dispatch_subagent?:
      | boolean
      | {
          background?: {
            registry: BackgroundSubagentRegistry;
            parentConversationId: string;
          };
        };
    /**
     * v0.16 §11 — host-specific `ask_user` resolver. Pass the readline
     * resolver from CLI, the `throw new AskUserPending` resolver from
     * serve, the canned-reply resolver from goal mode. Omit (or set
     * `undefined`) to disable the tool. Unlike the boolean flags above,
     * this is an object because the resolver differs per host.
     */
    ask_user?: { resolver: AskUserResolver };
    /**
     * v0.17 follow-up — chat-mode goal proposal. Same resolver shape as
     * `ask_user` (the tool piggybacks ask_user's serve UI). When provided,
     * the LLM gets a `propose_goal` tool that, upon model invocation, asks
     * the user to confirm max-rounds + token budget and then creates a
     * Goal record on disk. Workspace + scope + model are needed so the
     * goal is seeded in the right project bucket with the same model the
     * chat is currently using.
     */
    propose_goal?: {
      resolver: AskUserResolver;
      workspace: string;
      scope: { kind: "global" | "project" | "effort"; projectSlug?: string; effortSlug?: string };
      model: string;
      /** v0.17 P2 — see ProposeGoalToolOptions.autoRunner. */
      autoRunner?: (goalId: string, userMessage: string) => void;
    };
    /**
     * v0.18 — chat-mode steer for an existing long-running goal. Lets the
     * chat LLM (and therefore the user) inject a `[Steer from user: …]`
     * message into a goal's next round without leaving the chat, without
     * forking a new goal, and without bypassing the chat transcript with a
     * raw HTTP `/api/goals/:id/steer` call. See
     * {@link createGoalSendMessageTool} for full rationale and behaviour.
     *
     * Wired with the same `workspace` and `autoRunner` the propose_goal
     * binding already has — the autoRunner is reused to kick idle/failed
     * goals so the steer is consumed without delay.
     */
    goal_send_message?: {
      workspace: string;
      autoRunner?: (goalId: string, userMessage: string) => void;
    };
    /**
     * v0.17 P2 — chat-mode plan proposal. Same shape as propose_goal but
     * routes to {@link createProposePlanTool}; the LLM uses this when the
     * user asked for a plan / sketch / approach BEFORE the work itself.
     * `autoRunner` is the host-provided fire-and-forget kickoff that
     * calls `runPlan` with full closure deps.
     */
    propose_plan?: {
      resolver: AskUserResolver;
      workspace: string;
      model: string;
      autoRunner?: (planId: string, objective: string) => void;
    };
    /**
     * gap #3 — long-term, topic-based memory tools. Each persists under
     * `<workspace>/.mathran/memory/<topic>.md` and survives across sessions.
     */
    memory_list?: boolean;
    memory_read?: boolean;
    memory_write?: boolean;
    memory_append?: boolean;
    memory_search?: boolean;
    /**
     * user-distillation Phase 1 — read-only access to the user's
     * research profile (papers / projects / taste). User-home scoped,
     * NOT workspace scoped, so the same profile follows the user
     * across workspaces. There is intentionally no write-side tool —
     * see _tasks/user-distillation/PLAN.md.
     */
    user_profile_read?: boolean | { profileDir?: string };
    /**
     * sync-upgrade Phase 1-C — read-only access to arxiv paper LaTeX
     * source. Enabled by default in chat + goal mode. No write —
     * fetched sources go to <workspace>/.mathran/paper-sources/ via
     * the shared cache.
     */
    read_paper_tex?: boolean;
    /**
     * sync-upgrade Phase 3-C — read-only inspection of an effort's
     * predecessors/successors in the dep graph. Enabled by default;
     * use case: agent looks up "what already exists around X" before
     * generating a new effort.
     */
    effort_dep_neighbors?: boolean;
    /**
     * user-distillation Phase 4 — BM25 search over the profile so the
     * model can ask "is this topic relevant to anything the user
     * cares about" without dumping the full profile into context.
     */
    user_profile_search?: boolean | { profileDir?: string };
    /**
     * gap #3 — per-conversation scratchpad tools. They persist under
     * `<workspace>/.mathran/scratchpad/<convId>/<name>.md`. The conversation id
     * is taken from the explicit `conversationId` here, else falls back to
     * `checkpoints.conversationId`; without one the tool errors at call time.
     */
    scratchpad_read?: boolean | { conversationId?: string };
    scratchpad_write?: boolean | { conversationId?: string };
    /**
     * gap #4 — per-conversation scientific-computing tools. They operate inside
     * a per-conversation virtualenv / latex tmpdir under
     * `<workspace>/.mathran/`. The conversation id is taken from the explicit
     * `conversationId` here, else falls back to `checkpoints.conversationId`;
     * without one the tool errors at call time.
     */
    run_python?: boolean | { conversationId?: string };
    run_latex?: boolean | { conversationId?: string };
    install_python_package?: boolean | { conversationId?: string };
    /**
     * gap #5 — `search_web` web search tool. `true` enables it with the
     * default provider (brave) reading the API key from the
     * `BRAVE_SEARCH_API_KEY` / `SERPAPI_API_KEY` env. Pass an object to pin a
     * `provider` and/or supply an explicit `apiKey` from host config. With no
     * key the tool returns a friendly ok=false (never throws).
     */
    search_web?: boolean | { provider?: "brave" | "serpapi"; apiKey?: string };
    /**
     * gap #5 — `verify_page` LLM claim-verification tool. Reads a wiki page,
     * scores its claims, and writes `verification` frontmatter. Uses the
     * session LLM by default; pass an object to override the `model`.
     */
    verify_page?: boolean | { model?: string };
    /**
     * gap #2 — stateless arXiv search. Unlike the python/latex tools this is a
     * read-only network query with no per-conversation state, so it takes a
     * plain boolean.
     */
    search_arxiv?: boolean;
    /**
     * 2026-06-25 — Codex / Claude Code parity built-ins.
     * `glob`: list workspace paths matching a pattern (Node fs.glob).
     * `grep`: ripgrep wrapper with structured output (read-only).
     * `web_fetch`: one-shot URL fetch w/ SSRF guard + 1 MB cap.
     * Plain boolean or object cfg (web_fetch accepts allowPrivateNetwork
     * for an SSRF-guard escape hatch, mainly for tests).
     */
    glob?: boolean;
    grep?: boolean;
    web_fetch?: boolean | { allowPrivateNetwork?: boolean; userAgent?: string };
    /**
     * 2026-06-25 — `pdf_extract` tool. Spawns a Python helper in a
     * stable per-user venv at ~/.mathran/python-venv/pdf-extract/ to
     * convert PDFs to markdown with optional math-LaTeX preservation
     * (Marker backend). See src/core/chat/tools/pdf-extract.ts.
     */
    pdf_extract?: boolean;
    /**
     * Part B1 — chat-level plan mode tools (`enter_plan_mode` /
     * `complete_plan`). Default ON when the host explicitly enables them.
     * The flag itself is a plain boolean; the tools take no host wiring
     * beyond a pair of callbacks pointing at
     * {@link ChatSession.enablePlanMode} /
     * {@link ChatSession.disablePlanMode}, which the builder wires up.
     *
     * Plan mode is an in-memory session flag; it does NOT persist across
     * session restarts.
     */
    plan_mode?: boolean;
    /**
     * Part B2 — git inspect/commit chat tools. Registers 4 read-only
     * tools by default: `git_status`, `git_diff`, `git_log`, `git_branch`.
     * Pass an object with `allowCommit: true` to additionally register
     * `git_commit` (riskClass: write, gated by the approval broker).
     *
     * cwd is the session workspace; the tools refuse to run outside it
     * by virtue of being workspace-scoped.
     */
    git?: boolean | { allowCommit?: boolean };
    /**
     * Code mode v1 — `run_code_mode` meta-tool. Lets the LLM submit a JS
     * script that runs inside a sandboxed QuickJS VM and calls multiple
     * mathran tools in one round trip. Default OFF — this is an opt-in
     * power feature for token-saving, NOT a baseline capability.
     *
     * `true` enables it with the read-only tool whitelist (read_file, glob,
     * grep, plus the wiki/effort read tools). Pass an object to extend the
     * whitelist (`allowWrite` adds write/edit/apply_patch; `allowBash` adds
     * bash + run_python) or override the 256 MiB / 60 s caps.
     *
     * See {@link createCodeModeTool} and `docs/code-mode.md` for details.
     */
    code_mode?:
      | boolean
      | {
          allowWrite?: boolean;
          allowBash?: boolean;
          extraAllowedTools?: readonly string[];
          memoryLimitBytes?: number;
          timeoutMs?: number;
        };
  };
  /**
   * Subagent scheduler the `dispatch_subagent` builtin tool dispatches into
   * (v0.5 wire-up Gap #4 + #5). When unset, enabling the tool flag is a
   * silent no-op (with a console warning so the wiring mistake is visible
   * during local dev). This is intentionally separate from
   * `subagentScheduler` (which is the legacy compact-only scheduler injection
   * — kept for backward compatibility); production callers should pass the
   * SAME scheduler to both fields when both compact and dispatch are wanted.
   */
  scheduler?: SubagentScheduler;
  /**
   * Approval broker (Approval Policy 矩阵). When set, every high-risk tool
   * call (per its `riskClass`) is routed through the broker before execution:
   * it may run silently, run after host-prompted approval, be denied, or be
   * deferred (run then ask on failure). When unset, tools execute with the
   * legacy zero-approval behaviour (backward-compatible).
   */
  approvalBroker?: ApprovalBroker;
  /**
   * Hooks runner (PreEdit / PostEdit / PreCommit / PreBash / PostTool /
   * OnGoalComplete). When set, the session threads it into every tool's
   * {@link ToolExecuteContext} (so write/edit/bash fire their own pre/post
   * hooks), runs `post-tool` after each tool call, and runs `on-goal-complete`
   * when a user turn finishes. Unset → hooks are entirely inert.
   */
  hooks?: HookInvoker;
  /**
   * Session-level approval resolver (Approval Policy 矩阵). When set together
   * with {@link approvalBroker}, approval prompts are driven by the session
   * itself: it yields an `approval_request` event, awaits this resolver for the
   * decision, yields `approval_resolved`, then continues executing the tool
   * in-place. This keeps long-lived transports (serve's SSE stream) open across
   * the user interaction. When unset, the broker's own resolver (if any) drives
   * the prompt; with neither, prompts fail safe to deny.
   */
  approvalResolver?: ApprovalResolver;
  /**
   * UX gap A — Diff preview before file write. Session-level resolver the
   * broker consults AFTER it has authorised a write-style call whose matching
   * `allow` rule carries `requireDiffPreview: true`. The session yields a
   * `propose-write` event (unified diff + truncated contents), awaits this
   * resolver, yields `propose-write-resolved`, then either runs the write
   * (optionally with the user's edited content) or reports a rejection back to
   * the model. When unset, `requireDiffPreview` rules degrade gracefully to the
   * legacy behaviour: the authorised write runs immediately with no preview.
   */
  writeProposalResolver?: (
    proposal: WriteProposal,
  ) => Promise<WriteProposalDecision>;
  /**
   * Permission Profile (#2). When set, a HARD reject is applied at the tool
   * dispatch entry point (before the approval broker, so the user cannot
   * override it) for mutating tool calls under a read-only / review profile,
   * and for any tool listed in {@link ProfileEffects.denylistTools}. A banner
   * describing the active profile is also injected as a leading system message.
   * The broker's policy is expected to already reflect `profile.policy` (the
   * CLI wires that up); this field only drives the dispatch-level enforcement
   * and the banner.
   */
  profile?: ProfileEffects;
  /**
   * MATHRAN.md memory injection (v0.3 §14). When `enabled: true`, the
   * constructor synchronously reads `~/.mathran/MATHRAN.md` (global) and
   * `<workspace>/MATHRAN.md` (project) and prepends a single system message
   * with their concatenated contents BEFORE `opts.systemPrompt`. Order:
   * global → project → systemPrompt (the persona may reference memory).
   *
   * Reads are best-effort: missing or unreadable files are silently skipped.
   * If both files are missing, no memory message is injected.
   */
  memoryFiles?: {
    enabled: boolean;
    /** Defaults to `process.cwd()`. */
    workspace?: string;
  };
  /**
   * Three-layer MATHRAN.md memory injection (C 方案: USER < WORKSPACE <
   * PROJECT). When set, the constructor synchronously loads
   * `~/.mathran/MATHRAN.md`, `<workspace>/MATHRAN.md` and (when `projectSlug`
   * is given) `<workspace>/projects/<slug>/MATHRAN.md`, and prepends their
   * concatenated contents BEFORE the layered skills + persona prompt.
   *
   * This is the layered-config replacement for {@link memoryFiles}; the two
   * are mutually exclusive in practice (callers pick one). Reads are
   * best-effort — missing/unreadable files are silently skipped.
   */
  layeredMemory?: {
    workspace: string;
    projectSlug?: string;
    /** Override `$HOME` for the USER layer (tests). */
    home?: string;
  };
  /**
   * Optional layered skills (loaded via `loadLayeredSkills`) to advertise in
   * the system prompt. Injected AFTER memory and BEFORE the persona prompt as
   * its own system message. Empty / undefined → nothing injected.
   */
  layeredSkills?: ReadonlyArray<LoadedSkill>;
  /**
   * Auto-checkpoint config (/diff + checkpoint/rewind). When set, the built-in
   * `write_file` / `edit_file` tools are wrapped so a {@link Checkpoint} is
   * recorded (before + after snapshot of the touched path) into
   * `<workspace>/.mathran/cache/checkpoints/<conversationId>/` before each
   * successful mutate. `/diff` and `/rewind` read that store. Requires
   * `workspace` (or `checkpoints.workspace`) so snapshots can be resolved.
   * Unset → no checkpoints (backward-compatible).
   */
  checkpoints?: {
    conversationId: string;
    /** Defaults to {@link ChatSessionOptions.workspace}. */
    workspace?: string;
  };
  /**
   * MCP client registry (#4). When set, the connected MCP servers' tools are
   * projected into mathran {@link ToolSpec}s (namespaced `mcp__<server>__<tool>`,
   * `riskClass: "exec"` so they flow through the approval policy) and appended
   * to the tool list AFTER the builtins. Structural type so the session doesn't
   * depend on the concrete `McpRegistry` class. Unset → no MCP tools (purely
   * additive, backward-compatible).
   */
  mcpRegistry?: { toolSpecs(): ToolSpec[] };
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}


/** Per-`send()` options. */
export interface SendOpts {
  /**
   * Cancellation signal. When it fires:
   *   - before the turn starts, `send()` throws `AbortError` immediately and
   *     the history is left untouched;
   *   - mid-stream, the partial assistant text collected so far is committed to
   *     history with an ` [aborted]` marker (so callers can see partial
   *     progress) and `send()` throws `AbortError`;
   *   - between tool calls, any not-yet-executed calls in the round get a
   *     synthetic `[aborted]` tool result so history stays well-formed, then
   *     `send()` throws `AbortError`.
   * The signal is also threaded into the LLM request so providers abort the
   * underlying transport.
   */
  signal?: AbortSignal;
  /**
   * Attachment refs to stash on the user message we're about to push
   * (v0.17 mathub parity). The file contents/markers are already inlined in
   * `userText` by the route handler; this metadata is round-tripped through
   * the JSONL so a tab reload can rebuild the chip strip under the user
   * bubble. Providers ignore the field — see `LLMMessage.attachments`.
   */
  attachments?: Array<{ path: string; filename: string; mimeType: string }>;
  /**
   * v0.17 mathub parity W9 — Live Steering probe.
   *
   * Called at the top of every round inside `runRounds` (BEFORE the
   * LLM request). When the probe returns a non-empty string, the
   * runner:
   *
   *   1. injects a synthetic `{ role: "user", content: "[Steer from
   *      user: …]" }` message into history (so the LLM sees the
   *      steer on the next request AND the persisted jsonl shows it),
   *   2. yields a `{ type: "steer-received", text }` ChatEvent so
   *      the SSE stream forwards it to the SPA.
   *
   * The probe is responsible for clearing whatever underlying queue
   * it pulled from (it's a consume-on-read callback). Errors thrown
   * from the probe propagate; route handlers wrap their own try/catch
   * around `send()` so a bad probe doesn't kill history bookkeeping.
   *
   * Default unset = no steering (CLI / tests are unaffected).
   */
  steerProbe?: () => string | null | undefined;
}

/** Construct the canonical abort error (matches the Fetch/Streams convention). */
function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Stats returned by {@link ChatSession.compact} — the caller (CLI / REST)
 *  surfaces these to the user. */
export interface CompactStats {
  /** Token count of history before compaction. */
  originalTokenCount: number;
  /** Token count of history after compaction. */
  newTokenCount: number;
  /** Number of complete user-rooted rounds dropped from the middle. */
  droppedRoundCount: number;
  /** True when the call was a no-op (nothing to compact). */
  noop: boolean;
  /** Truthy warning string when compaction failed to drop the token count
   *  below the threshold (relevant for auto-compact loops). Absent on success. */
  warning?: string;
}

/** True when `err` is an AbortError (DOMException or a plain `.name` carrier). */
function isAbortError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: string }).name === "AbortError";
}

/**
 * Iterate `iterable`, but reject with `AbortError` as soon as `signal` fires —
 * even while we are parked awaiting the next chunk. The underlying iterator is
 * best-effort cancelled (`return()`) on exit so providers can release sockets.
 */
async function* iterateWithAbort<T>(
  iterable: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  if (!signal) {
    yield* iterable;
    return;
  }
  if (signal.aborted) throw abortError();
  const iter = iterable[Symbol.asyncIterator]();
  let onAbort!: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const res = await Promise.race([iter.next(), abortPromise]);
      if (res.done) return;
      yield res.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Best-effort cancel of the underlying iterator. We must NOT await it: a
    // provider parked on a never-settling promise would make `return()` hang
    // too. Real fetch/SDK iterators settle once the transport is aborted.
    const ret = iter.return?.();
    if (ret && typeof (ret as Promise<unknown>).then === "function") {
      (ret as Promise<unknown>).then(
        () => {},
        () => {},
      );
    }
  }
}

export class ChatSession {
  private readonly llm: LLMProvider;
  private readonly tools: ToolSpec[];
  private readonly toolByName: Map<string, ToolSpec>;
  private readonly maxToolRounds: number;
  readonly model?: string;
  private temperature?: number;
  private maxTokens?: number;
  /** Reasoning-effort budget threaded into each LLMRequest (#6). */
  private currentEffort?: ReasoningEffortLevel;
  private readonly toolContext?: ToolExecuteContext;
  readonly sessionId: string;
  private readonly toolOutputCap?: { maxInlineBytes?: number; workspace?: string | null };
  private readonly autoCompactCfg?: ChatSessionOptions["autoCompact"];
  /** TODO-2 §3.2 / C8 — compaction event observer (goal-mode wires emit). */
  private readonly onCompactionEvent?: ChatSessionOptions["onCompactionEvent"];
  private readonly workspace?: string;
  /**
   * 2026-06-30 — sandbox config (Bubblewrap) for mutating exec tools
   * (bash / run_python / run_latex / lean_check). Passed through from the
   * host (chat.ts / serve.ts) on construction; when absent or
   * `enabled: false`, exec tools fall through to a raw spawn (back-compat).
   */
  private readonly sandbox?: import("../sandbox/index.js").SandboxConfig;
  /** 2026-06-30 plan-tracker bug fix — supplier of the current todo list,
   *  see {@link ChatSessionOptions.todoSnapshot} for the full rationale.
   *  Awaited and converted to a transient system reminder before every
   *  LLM request; the reminder is spliced back out after the request so
   *  it doesn't bloat history. */
  private readonly todoSnapshot?: () => Promise<TodoList | null>;
  private readonly subagentScheduler?: SubagentScheduler;
  /**
   * v0.5 wire-up: separate scheduler reference used by the
   * `dispatch_subagent` builtin tool. Holds the SAME instance as
   * `subagentScheduler` for production callers (which pass one scheduler in
   * both fields), but kept distinct so test harnesses can wire only the
   * dispatch surface without picking up compact's lazy-init defaults.
   */
  private readonly dispatchScheduler?: SubagentScheduler;
  /** v0.5 §7 — absolute paths read this session (read-before-write gate). */
  private readonly readPaths = new Set<string>();
  private readonly builtinToolsCfg?: ChatSessionOptions["builtinTools"];
  private readonly checkpointsCfg?: ChatSessionOptions["checkpoints"];
  /** Approval broker (Approval Policy 矩阵). Optional; gates high-risk tools. */
  private readonly approvalBroker?: ApprovalBroker;
  /** Hooks runner (PreEdit/PostEdit/PreCommit/PreBash/PostTool/OnGoalComplete). */
  private readonly hookInvoker?: HookInvoker;
  /** Session-level approval resolver (yield-based prompt driver). */
  private readonly approvalResolver?: ApprovalResolver;
  /** UX gap A — diff-preview resolver (yield-based write-proposal driver). */
  private readonly writeProposalResolver?: (
    proposal: WriteProposal,
  ) => Promise<WriteProposalDecision>;
  /** Permission Profile (#2) — drives the dispatch-level hard reject. */
  private readonly profile?: ProfileEffects;
  /**
   * Part B1 — plan mode flag.
   *
   * When `true`, the dispatcher (executeWithApproval) only allows tools
   * with `ToolSpec.readOnly === true` to execute; everything else is
   * blocked with PlanModeBlockedError, returned to the model as an
   * `ok: false` tool result. Toggled via {@link enablePlanMode} /
   * {@link disablePlanMode}.
   *
   * Not persisted: every fresh ChatSession starts with `planMode = false`.
   * The chat-level `enter_plan_mode` / `complete_plan` tools (commit 3)
   * are the user-visible affordance for toggling it.
   */
  private planMode: boolean = false;
  /** Promise of an in-flight compact() — second concurrent caller awaits it. */
  private compactInFlight: Promise<CompactStats> | null = null;
  /** TODO-2 §3.2 — promise of an in-flight compactV2() — second caller awaits it. */
  private compactInFlightV2: Promise<CompactionOutcome> | null = null;
  /** TODO-2 §3.2 — cumulative provider-reported input tokens for the current send() turn. */
  private cumulativeInputTokens = 0;
  private messages: LLMMessage[] = [];
  /**
   * Skills/Plugins 二层: skills carrying a `trigger` (keyword / regex). These
   * are matched against each user message and injected per-turn (transiently),
   * unlike "always" skills which inject at construction. Empty when no layered
   * skills were provided.
   */
  private readonly triggerSkills: LoadedSkill[] = [];

  constructor(opts: ChatSessionOptions) {
    this.llm = opts.llm;
    this.model = opts.model;
    this.tools = opts.tools ?? [];
    this.toolByName = new Map(this.tools.map((t) => [t.name, t]));

    // Tool-call round cap. Default raised from 8 → 50 (v0.12.x).
    //
    // Background: at 8 rounds, LLM doing legitimate multi-step exploration
    // (e.g. reading a multi-thousand-line file via `sed` slices because
    // `read_file` is still un-paged) gets cut off mid-task with
    // "tool-call budget exhausted". Claude Code has no equivalent hard cap;
    // it bounds tool *output* (25K tokens per result, 100K total) and lets
    // the LLM loop freely. v0.13 will follow that approach (paged read_file
    // + per-result token cap) so this number becomes a runaway safety net,
    // not a routine limit.
    this.maxToolRounds = opts.maxToolRounds ?? 50;
    this.temperature = opts.temperature;
    this.maxTokens = opts.maxTokens;
    this.currentEffort = opts.effort;
    this.toolContext = opts.toolContext;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.toolOutputCap = opts.toolOutputCap;
    this.autoCompactCfg = opts.autoCompact;
    this.workspace = opts.workspace;
    // 2026-06-30 — sandbox passthrough (Bubblewrap). When the host doesn't
    // configure one, mutating tools route to raw spawn.
    if (opts.sandbox) this.sandbox = opts.sandbox;
    this.todoSnapshot = opts.todoSnapshot;
    this.onCompactionEvent = opts.onCompactionEvent;
    this.subagentScheduler = opts.subagentScheduler;
    // v0.5 wire-up: prefer `opts.scheduler` for the dispatch tool, but fall
    // back to `opts.subagentScheduler` so production callers that already
    // pass the latter (for compact) automatically get dispatch too.
    this.dispatchScheduler = opts.scheduler ?? opts.subagentScheduler;
    this.builtinToolsCfg = opts.builtinTools;
    this.checkpointsCfg = opts.checkpoints;
    this.approvalBroker = opts.approvalBroker;
    this.approvalResolver = opts.approvalResolver;
    this.writeProposalResolver = opts.writeProposalResolver;
    this.hookInvoker = opts.hooks;
    this.profile = opts.profile;
    // Mix in built-in tools (v0.2 §9+). Order: built-ins first, then caller's
    // tools (so a caller-supplied tool with the same name wins via the
    // `toolByName` map's last-write).
    const builtins = this.buildBuiltinTools();
    if (builtins.length > 0) {
      this.tools = [...builtins, ...this.tools];
      this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
    }
    // MCP tools (#4): pull every connected server's namespaced tools from the
    // registry and append them AFTER builtins + caller tools. Best-effort — a
    // throwing registry must never abort session construction.
    if (opts.mcpRegistry) {
      try {
        const mcpTools = opts.mcpRegistry.toolSpecs();
        if (mcpTools.length > 0) {
          this.tools = [...this.tools, ...mcpTools];
          this.toolByName = new Map(this.tools.map((t) => [t.name, t]));
        }
      } catch {
        // constructors must NEVER throw.
      }
    }
    // v0.3 §14: prepend MATHRAN.md memory (global → project) BEFORE the
    // persona system prompt. Reads are sync (tiny files) and never throw —
    // any error makes the section disappear silently.
    if (opts.memoryFiles?.enabled) {
      try {
        const memWorkspace = opts.memoryFiles.workspace ?? process.cwd();
        const mem = loadMathranMemorySync({ workspace: memWorkspace });
        const fragment = formatMathranMemory(mem);
        if (fragment.length > 0) {
          this.messages.push({ role: "system", content: fragment });
        }
      } catch {
        // Defense-in-depth: loadMathranMemorySync swallows IO errors itself
        // but constructors must NEVER throw. Belt-and-suspenders.
      }
    }

    // v0.16 §C 方案: three-layer MATHRAN.md (USER < WORKSPACE < PROJECT) as
    // the layered-config replacement for `memoryFiles`. Same placement
    // (before skills + persona) and same best-effort, never-throw contract.
    if (opts.layeredMemory) {
      try {
        const mem = loadLayeredMathranMemorySync({
          workspace: opts.layeredMemory.workspace,
          ...(opts.layeredMemory.projectSlug
            ? { projectSlug: opts.layeredMemory.projectSlug }
            : {}),
          ...(opts.layeredMemory.home ? { home: opts.layeredMemory.home } : {}),
        });
        const fragment = formatLayeredMathranMemory(mem);
        if (fragment.length > 0) {
          this.messages.push({ role: "system", content: fragment });
        }
      } catch {
        // constructors must NEVER throw.
      }
    }

    // v0.16 §C 方案: advertise layered skills (PROJECT > WORKSPACE > USER) as
    // a system fragment, after memory and before the persona prompt. Never
    // throws; an empty list injects nothing.
    //
    // Skills/Plugins 二层 §B: split the loaded skills into "always" (no
    // trigger → injected here, permanently) and "trigger" (keyword/regex →
    // matched + injected per-turn in send()). Always-skills also register
    // their `allowedTools` as temporary approval rules up front.
    if (opts.layeredSkills && opts.layeredSkills.length > 0) {
      try {
        const skillsFragment = formatSkillsForPrompt(opts.layeredSkills);
        if (skillsFragment.length > 0) {
          this.messages.push({ role: "system", content: skillsFragment });
        }
        const alwaysFragments: string[] = [];
        for (const skill of opts.layeredSkills) {
          if (isAlwaysSkill(skill)) {
            const rendered = renderSkillPrompt(skill, "");
            if (rendered.trim().length > 0) alwaysFragments.push(rendered.trim());
            registerSkillToolRules(this.approvalBroker, skill);
          } else {
            this.triggerSkills.push(skill);
          }
        }
        if (alwaysFragments.length > 0) {
          this.messages.push({
            role: "system",
            content: alwaysFragments.join("\n\n"),
          });
        }
      } catch {
        // constructors must NEVER throw.
      }
    }

    if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
      this.messages.push({ role: "system", content: opts.systemPrompt });
    }

    // Permission Profiles (#2): inject the active-profile banner as the LAST
    // leading system message so the model is reminded of the current profile's
    // constraints on every turn (it survives /reset, which keeps leading
    // system messages).
    if (this.profile) {
      const banner = buildProfileBanner(this.profile);
      if (banner.trim().length > 0) {
        this.messages.push({ role: "system", content: banner });
      }
    }

  }

  /** Current conversation history (read-only copy). */
  history(): LLMMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /**
   * C-round Commit 4: ask the underlying LLM provider whether it understands
   * `ContentPart[]` with image parts. The router aggregates per-route support
   * (`ModelRouter.routeSupportsVision(modelString)`); a plain provider exposes
   * the static `supportsVision` boolean. Returns false when neither is
   * present so the host degrades to legacy `[Image: ...]` text markers.
   */
  providerSupportsVision(): boolean {
    const provider = this.llm as LLMProvider & {
      supportsVision?: boolean;
      routeSupportsVision?: (modelString: string) => boolean;
    };
    if (typeof provider.routeSupportsVision === "function" && this.model) {
      try {
        return provider.routeSupportsVision(this.model) === true;
      } catch {
        return false;
      }
    }
    return provider.supportsVision === true;
  }

  /**
   * Reasoning-effort budget for this session (#6). `undefined` means no
   * `effort` is sent on the wire (provider defaults apply).
   */
  getEffort(): ReasoningEffortLevel | undefined {
    return this.currentEffort;
  }

  /**
   * Set the reasoning-effort budget live (the `/effort` slash command). Takes
   * effect on the next `send()`. Pass `undefined` to clear it.
   */
  setEffort(level: ReasoningEffortLevel | undefined): void {
    this.currentEffort = level;
  }

  /**
   * Part B1 — enter plan mode.
   *
   * After this call, every tool invocation in this session is gated by
   * the dispatcher: only tools with `ToolSpec.readOnly === true` are
   * allowed; everything else surfaces as an `ok: false` tool result.
   * Idempotent. Not persisted across session restarts.
   */
  enablePlanMode(): void {
    this.planMode = true;
  }

  /**
   * Part B1 — exit plan mode and resume normal tool dispatch.
   * Idempotent.
   */
  disablePlanMode(): void {
    this.planMode = false;
  }

  /** Part B1 — inspect the current plan-mode flag (host / test affordance). */
  isPlanMode(): boolean {
    return this.planMode;
  }

  /** Clear history, keeping any leading system prompt(s). */
  reset(): void {
    const leading = this.collectLeadingSystemMessages();
    this.messages = leading.map((m) => ({ ...m }));
  }

  /**
   * Append a `system` note to history (/rewind 物理恢复 marker). Used by the
   * `/rewind` slash command to record `[Rewound to before checkpoint …]` so
   * the model sees the workspace was rolled back. Also invalidates the
   * read-before-write tracking, since files on disk changed underneath it.
   */
  appendSystemNote(text: string): void {
    this.readPaths.clear();
    this.messages.push({ role: "system", content: text });
  }

  /**
   * Channels v1 (2026-06-30) — inject a reverse-channel message into
   * history. The MCP bridge calls this when an upstream server pushes a
   * `mathran/channel` notification (Telegram bot, Sentry alert, lean
   * compile finished, …) and the channel registry routes it to this
   * session.
   *
   * v1 semantics: QUEUE mode only. The message is appended as a plain
   * `role: "user"` turn, so the LLM sees it on its NEXT round between
   * turns — never mid-stream. Interrupt-style delivery (abort the in-
   * flight round + prepend a priority user message) is reserved for v2
   * (see src/core/channels/index.ts).
   *
   * The injected message carries `meta.fromChannel` ("mcp:<server>")
   * so the SSE bridge can forward it to the SPA as a distinct bubble.
   * Provider adapters MUST ignore `meta` — see `LLMMessage.meta`.
   *
   * Deliberately a small, isolated method: this file is a hot spot
   * (todoSnapshot / Granular wiring / hook v1 wrap) so Channels v1 only
   * ADDS — never touches `runRounds` / `send` / approval / compaction
   * paths.
   */
  injectChannelMessage(msg: {
    content: string;
    source: string;
    role?: "user";
  }): void {
    if (typeof msg.content !== "string" || msg.content.length === 0) return;
    this.messages.push({
      role: "user",
      content: msg.content,
      meta: {
        fromChannel: msg.source,
        channelTs: Date.now(),
      },
    });
  }

  /**
   * 2026-06-30 — subscribe this session to a Channel registry so MCP
   * pushes (`mathran/channel` notifications) routed at `sessionId` are
   * appended via {@link injectChannelMessage}. Returns an unsubscribe
   * function the caller MUST invoke when the session is evicted /
   * disposed / the process exits — otherwise the registry holds a
   * reference to the session and keeps it alive past its useful life.
   *
   * Lifecycle ownership: ChatSession deliberately does NOT auto-register
   * in the constructor — that would couple the session's lifetime to a
   * process-level singleton and have no place to hook unregister. Hosts
   * call this from the same scope that creates the session
   * (chat.ts: process exit; serve.ts ScopedChatSessionStore: getOrCreate
   * register / evictOne unregister).
   *
   * Idempotent: registering the same sessionId replaces the previous
   * subscription per ChannelRegistry semantics — the session continues
   * to receive routes after re-registration without missing messages.
   */
  subscribeToChannels(
    registry: { register: (sub: { sessionId: string; deliver: (m: { content: string; source: string; role?: "user" }) => void }) => () => void },
    sessionId: string,
  ): () => void {
    const unsubscribe = registry.register({
      sessionId,
      deliver: (m) => this.injectChannelMessage(m),
    });
    return unsubscribe;
  }

  /**
   * Replace the in-memory history with a hydrated copy (used by the disk-
   * backed `ScopedChatSessionStore` during session re-hydration on first
   * access after a process restart).
   *
   * Behavior:
   *   - If `next` contains a leading `system` message, it is used verbatim.
   *   - Otherwise the session's existing leading system prompt(s) are
   *     preserved and `next` is appended after them. v0.3 §14 may inject
   *     multiple leading system messages (memory + persona); all are kept.
   */
  replaceHistory(next: LLMMessage[]): void {
    // Conversation context changed — invalidate read-before-write tracking.
    this.readPaths.clear();
    if (next.length > 0 && next[0].role === "system") {
      this.messages = next.map((m) => ({ ...m }));
      return;
    }
    const leading = this.collectLeadingSystemMessages();
    this.messages = [
      ...leading.map((m) => ({ ...m })),
      ...next.map((m) => ({ ...m })),
    ];
  }

  /** All consecutive system messages at the start of {@link messages}. */
  private collectLeadingSystemMessages(): LLMMessage[] {
    const out: LLMMessage[] = [];
    for (const m of this.messages) {
      if (m.role !== "system") break;
      out.push(m);
    }
    return out;
  }

  // ─── Compact (v0.2 §5) ────────────────────────────────────────────────────

  // ─── Built-in tools (v0.2 §9+) ──────────────────────────────────

  /**
   * Build the list of ChatSession-owned built-in tool specs based on
   * `opts.builtinTools`. Currently produces:
   *
   *   - `read_file_summary` (Task 9) — dispatches `read_summarize` to a
   *     subagent runner. Returns the runner's summary text + a link to the
   *     cached source artifact. Silently a no-op if the caller didn't enable
   *     it; never throws during construction.
   *
   * Tool `execute()` failures (path escape, file-not-found, LLM error) come
   * back as `{ ok: false, content: <human msg> }` instead of throwing, so the
   * model can see the error in a tool result and try a different path.
   */
  /**
   * Wrap a mutate tool (`write_file` / `edit_file`) with the checkpoint
   * middleware when {@link ChatSessionOptions.checkpoints} is configured and a
   * workspace is known; otherwise return it unchanged.
   */
  private maybeCheckpoint(tool: ToolSpec): ToolSpec {
    const cfg = this.checkpointsCfg;
    const workspace = cfg?.workspace ?? this.workspace;
    if (!cfg || !workspace) return tool;
    return wrapMutateTool(tool, {
      workspace,
      conversationId: cfg.conversationId,
      // /rewind 5-mode parity — pass a live closure over messages.length so
      // each checkpoint records the conversation prefix that existed right
      // before the mutate ran. Conversation-aware rewind modes
      // (`code-and-conversation`, `conversation-only`, `summarize-*`)
      // truncate the jsonl back to this count.
      getMessageCount: () => this.messages.length,
    });
  }

  private buildBuiltinTools(): ToolSpec[] {
    const cfg = this.builtinToolsCfg;
    if (!cfg) return [];
    const out: ToolSpec[] = [];
    if (cfg.search) {
      out.push(this.makeSearchTool());
    }
    if (cfg.read_file_summary) {
      out.push(this.makeReadFileSummaryTool());
    }
    // v0.4 §1 filesystem & shell tools. These are workspace-scoped: each
    // tool gets `this.workspace` baked in at construction time so escape
    // checks can be done with `path.relative`. When `workspace` is unset the
    // tool falls back to `ctx.workspace` and finally `process.cwd()`.
    if (cfg.bash) {
      // 2026-06-30 — pass sandbox config to bash so v1 Bubblewrap engages
      // when enabled. Otherwise (`enabled: false` or unset) bash falls
      // through to raw spawn — back-compat byte-for-byte.
      out.push(
        createBashTool({
          ...(this.workspace ? { workspace: this.workspace } : {}),
          ...(this.sandbox ? { sandbox: this.sandbox } : {}),
        }),
      );
    }
    if (cfg.read_file) {
      out.push(
        createReadFileTool(this.workspace ? { workspace: this.workspace } : {}),
      );
    }
    if (cfg.write_file) {
      out.push(
        this.maybeCheckpoint(
          createWriteFileTool(this.workspace ? { workspace: this.workspace } : {}),
        ),
      );
    }
    if (cfg.edit_file) {
      out.push(
        this.maybeCheckpoint(
          createEditFileTool(this.workspace ? { workspace: this.workspace } : {}),
        ),
      );
    }
    if (cfg.apply_patch) {
      // apply_patch handles its own multi-file checkpoint capture (the
      // single-path `wrapMutateTool` middleware can't represent it), so
      // we pass the checkpoint config directly into the factory.
      const cpCfg = this.checkpointsCfg;
      const cpWorkspace = cpCfg?.workspace ?? this.workspace;
      const checkpoints =
        cpCfg && cpWorkspace
          ? {
              conversationId: cpCfg.conversationId,
              workspace: cpWorkspace,
            }
          : undefined;
      out.push(
        createApplyPatchTool({
          ...(this.workspace ? { workspace: this.workspace } : {}),
          ...(checkpoints ? { checkpoints } : {}),
        }),
      );
    }
    // Gap #1 (wiki / effort / project chat tools). All 25 tools share the
    // builder-time `workspace` injection pattern; each is wrapped via
    // `maybeCheckpoint` for write-class tools so the existing checkpoint
    // middleware (write_file / edit_file) also covers wiki/effort/doc mutations.
    if (cfg.gap1_project_tools) {
      const wsOpts = this.workspace ? { workspace: this.workspace } : {};
      // Wiki tools.
      out.push(createReadWikiPageTool(wsOpts));
      out.push(createListWikiPagesTool(wsOpts));
      out.push(this.maybeCheckpoint(createCreateWikiPageTool(wsOpts)));
      out.push(this.maybeCheckpoint(createUpdateWikiPageTool(wsOpts)));
      out.push(this.maybeCheckpoint(createDeleteWikiPageTool(wsOpts)));
      out.push(createSearchWikiTool(wsOpts));
      // Effort tools.
      out.push(createListEffortsTool(wsOpts));
      out.push(createReadEffortTool(wsOpts));
      out.push(this.maybeCheckpoint(createCreateEffortTool(wsOpts)));
      out.push(this.maybeCheckpoint(createUpdateEffortDocumentTool(wsOpts)));
      out.push(this.maybeCheckpoint(createAppendEffortDocumentTool(wsOpts)));
      out.push(this.maybeCheckpoint(createUpdateEffortMetadataTool(wsOpts)));
      out.push(this.maybeCheckpoint(createTransitionEffortStatusTool(wsOpts)));
      out.push(this.maybeCheckpoint(createSnapshotEffortTool(wsOpts)));
      out.push(createListEffortVersionsTool(wsOpts));
      out.push(createReadEffortVersionTool(wsOpts));
      out.push(this.maybeCheckpoint(createAddEffortRelationTool(wsOpts)));
      out.push(createListEffortRelationsTool(wsOpts));
      // Project / doc tools.
      out.push(createListProjectsTool(wsOpts));
      out.push(createReadProjectMetadataTool(wsOpts));
      out.push(this.maybeCheckpoint(createUpdateProjectMetadataTool(wsOpts)));
      out.push(createListDocPagesTool(wsOpts));
      out.push(createReadDocPageTool(wsOpts));
      out.push(this.maybeCheckpoint(createCreateDocPageTool(wsOpts)));
      out.push(this.maybeCheckpoint(createUpdateDocPageTool(wsOpts)));
    }
    // v0.5 wire-up Gap #4 + #5: generic dispatch tool. Requires a scheduler
    // to be wired (callers that opt in but forget to pass one get a console
    // warning + silent skip, never a crash).
    if (cfg.dispatch_subagent) {
      if (this.dispatchScheduler) {
        const dsCfg =
          typeof cfg.dispatch_subagent === "object"
            ? cfg.dispatch_subagent
            : undefined;
        const background = dsCfg?.background;
        out.push(
          createDispatchSubagentTool({
            scheduler: this.dispatchScheduler,
            ...(background ? { background } : {}),
          }),
        );
        // Background mode pairs with a poll tool so the LLM can check a
        // detached run without blocking. Only useful when background is wired.
        if (background) {
          out.push(
            createGetSubagentResultTool({ registry: background.registry }),
          );
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "[mathran] ChatSession builtinTools.dispatch_subagent enabled but no `scheduler` provided; skipping.",
        );
      }
    }
    // v0.16 §11: per-host `ask_user` resolver. The factory injects the
    // host's resolver (CLI: readline; serve: throw `AskUserPending`;
    // goal: canned reply). Tool description / schema is host-agnostic so
    // the model sees the same affordance everywhere.
    if (cfg.ask_user && cfg.ask_user.resolver) {
      // 2026-06-30 — Granular Approval channel `ask_user`: forward a gate
      // that reads broker.granularConfig at call time (so a live settings
      // reload — which currently restarts the session — picks up changes
      // even without a full session rebuild). When no broker is attached
      // (test fixtures, headless host), default to "always prompt".
      const brokerForAskUser = this.approvalBroker;
      const askUserGate = brokerForAskUser
        ? () => brokerForAskUser.granularConfig.ask_user !== false
        : undefined;
      out.push(
        createAskUserTool({
          resolver: cfg.ask_user.resolver,
          ...(askUserGate ? { granularGate: askUserGate } : {}),
        }),
      );
    }
    // v0.17 follow-up: propose_goal. Same resolver pattern as ask_user so
    // the SPA's existing confirmation UI is reused. The tool itself does
    // the createGoal write on confirm; serve.ts watches for tool-result
    // name=propose_goal and emits a `goal-proposed` SSE frame.
    if (cfg.propose_goal && cfg.propose_goal.resolver) {
      const pgWorkspace = cfg.propose_goal.workspace;
      out.push(
        createProposeGoalTool({
          resolver: cfg.propose_goal.resolver,
          workspace: pgWorkspace,
          scope: cfg.propose_goal.scope,
          model: cfg.propose_goal.model,
          autoRunner: cfg.propose_goal.autoRunner,
          // #5: keyword/tag retrieval over .mathran/cache/outcomes for
          // few-shot context. Lazy import keeps the outcomes module off the
          // ChatSession hot path when propose_goal is unused.
          retrieveFewShot: async (objective: string) => {
            const { retrieveSimilarOutcomes, formatOutcomesFewShot } =
              await import("../outcomes/retrieve.js");
            const hits = await retrieveSimilarOutcomes(pgWorkspace, objective, {
              limit: 3,
            });
            return formatOutcomesFewShot(hits);
          },
        }),
      );
    }
    // v0.18 — chat-mode steer for an existing long-running goal. See
    // `createGoalSendMessageTool` for full rationale (essentially the
    // (1+1.9) Goldbach incident: user wanted to update a running goal
    // mid-search without forking a new one or bypassing the chat
    // transcript with a raw API call).
    if (cfg.goal_send_message) {
      out.push(
        createGoalSendMessageTool({
          workspace: cfg.goal_send_message.workspace,
          autoRunner: cfg.goal_send_message.autoRunner,
        }),
      );
    }
    if (cfg.propose_plan && cfg.propose_plan.resolver) {
      out.push(
        createProposePlanTool({
          resolver: cfg.propose_plan.resolver,
          workspace: cfg.propose_plan.workspace,
          model: cfg.propose_plan.model,
          autoRunner: cfg.propose_plan.autoRunner,
        }),
      );
    }
    // gap #3 — long-term memory tools (workspace-scoped, fs-only).
    const memWorkspace = this.workspace ? { workspace: this.workspace } : {};
    if (cfg.memory_list) {
      out.push(createMemoryListTool(memWorkspace));
    }
    if (cfg.memory_read) {
      out.push(createMemoryReadTool(memWorkspace));
    }
    if (cfg.memory_write) {
      out.push(this.maybeCheckpoint(createMemoryWriteTool(memWorkspace)));
    }
    if (cfg.memory_append) {
      out.push(this.maybeCheckpoint(createMemoryAppendTool(memWorkspace)));
    }
    if (cfg.memory_search) {
      out.push(createMemorySearchTool(memWorkspace));
    }
    // user-distillation Phase 1 — read-only profile access for the model.
    if (cfg.user_profile_read) {
      const profileOpts =
        typeof cfg.user_profile_read === "object" && cfg.user_profile_read.profileDir
          ? { profileDir: cfg.user_profile_read.profileDir }
          : {};
      out.push(createUserProfileReadTool(profileOpts));
    }
    // user-distillation Phase 4 — BM25 search across the same profile.
    if (cfg.user_profile_search) {
      const searchOpts =
        typeof cfg.user_profile_search === "object" && cfg.user_profile_search.profileDir
          ? { profileDir: cfg.user_profile_search.profileDir }
          : {};
      out.push(createUserProfileSearchTool(searchOpts));
    }
    // sync-upgrade Phase 1-C — arxiv paper LaTeX source reader.
    if (cfg.read_paper_tex) {
      out.push(createReadPaperTexTool());
    }
    // sync-upgrade Phase 3-C — effort dep graph neighbor inspection.
    if (cfg.effort_dep_neighbors) {
      out.push(createEffortDepNeighborsTool());
    }
    // gap #3 — per-conversation scratchpad tools. The conversation id comes
    // from an explicit override, else the checkpoints conversation id.
    if (cfg.scratchpad_read) {
      const convId =
        (typeof cfg.scratchpad_read === "object"
          ? cfg.scratchpad_read.conversationId
          : undefined) ?? this.checkpointsCfg?.conversationId;
      out.push(
        createScratchpadReadTool({
          ...(this.workspace ? { workspace: this.workspace } : {}),
          ...(convId ? { conversationId: convId } : {}),
        }),
      );
    }
    if (cfg.scratchpad_write) {
      const convId =
        (typeof cfg.scratchpad_write === "object"
          ? cfg.scratchpad_write.conversationId
          : undefined) ?? this.checkpointsCfg?.conversationId;
      out.push(
        this.maybeCheckpoint(
          createScratchpadWriteTool({
            ...(this.workspace ? { workspace: this.workspace } : {}),
            ...(convId ? { conversationId: convId } : {}),
          }),
        ),
      );
    }
    // gap #4 — per-conversation Python / LaTeX execution tools. Same convId
    // resolution as the scratchpad tools. All execute arbitrary code, so they
    // carry riskClass "exec" and (being write operations under .mathran) run
    // through maybeCheckpoint like bash.
    if (cfg.run_python) {
      const convId =
        (typeof cfg.run_python === "object"
          ? cfg.run_python.conversationId
          : undefined) ?? this.checkpointsCfg?.conversationId;
      out.push(
        this.maybeCheckpoint(
          createRunPythonTool({
            ...(this.workspace ? { workspace: this.workspace } : {}),
            ...(convId ? { conversationId: convId } : {}),
            ...(this.sandbox ? { sandbox: this.sandbox } : {}),
          }),
        ),
      );
    }
    if (cfg.run_latex) {
      const convId =
        (typeof cfg.run_latex === "object"
          ? cfg.run_latex.conversationId
          : undefined) ?? this.checkpointsCfg?.conversationId;
      out.push(
        this.maybeCheckpoint(
          createRunLatexTool({
            ...(this.workspace ? { workspace: this.workspace } : {}),
            ...(convId ? { conversationId: convId } : {}),
            ...(this.sandbox ? { sandbox: this.sandbox } : {}),
          }),
        ),
      );
    }
    if (cfg.install_python_package) {
      const convId =
        (typeof cfg.install_python_package === "object"
          ? cfg.install_python_package.conversationId
          : undefined) ?? this.checkpointsCfg?.conversationId;
      out.push(
        this.maybeCheckpoint(
          createInstallPythonPackageTool({
            ...(this.workspace ? { workspace: this.workspace } : {}),
            ...(convId ? { conversationId: convId } : {}),
          }),
        ),
      );
    }
    if (cfg.search_web) {
      const swCfg = typeof cfg.search_web === "object" ? cfg.search_web : {};
      out.push(
        createSearchWebTool({
          ...(swCfg.provider ? { provider: swCfg.provider } : {}),
          ...(swCfg.apiKey ? { apiKey: swCfg.apiKey } : {}),
        }),
      );
    }
    if (cfg.verify_page) {
      const vpCfg = typeof cfg.verify_page === "object" ? cfg.verify_page : {};
      out.push(
        this.maybeCheckpoint(
          createVerifyPageTool({
            ...(this.workspace ? { workspace: this.workspace } : {}),
            llm: this.llm,
            model: vpCfg.model ?? this.model ?? "",
          }),
        ),
      );
    }
    // gap #2 — stateless read-only arXiv search; no checkpoint wrapping needed.
    if (cfg.search_arxiv) {
      out.push(createSearchArxivTool());
    }
    // 2026-06-25 — three Codex/Claude-Code-parity tools wired in here so
    // chat-mode + goal-mode (both share this factory) pick them up via
    // the same `builtinTools` cfg map as the other read-only tools.
    if (cfg.glob) {
      out.push(createGlobTool(this.workspace ? { workspace: this.workspace } : {}));
    }
    if (cfg.grep) {
      out.push(createGrepTool(this.workspace ? { workspace: this.workspace } : {}));
    }
    if (cfg.web_fetch) {
      const wfCfg = typeof cfg.web_fetch === "object" ? cfg.web_fetch : {};
      out.push(
        createWebFetchTool({
          ...(wfCfg.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
          ...(wfCfg.userAgent ? { userAgent: wfCfg.userAgent } : {}),
        }),
      );
    }
    // 2026-06-25 — PDF extraction tool. Replaces the model's old
    // "shell out to pdftotext" workaround which destroyed math
    // formulas. Two modes (fast / math); see pdf-extract.ts.
    if (cfg.pdf_extract) {
      out.push(createPdfExtractTool());
    }
    // Part B1 — chat-level plan mode tools. Both tools are readOnly so the
    // model can always *exit* plan mode after entering it. We bind to
    // arrow callbacks (NOT bound methods) so the closures keep working
    // even if the host swaps the session reference later in tests.
    if (cfg.plan_mode) {
      const planOpts = {
        enablePlanMode: () => this.enablePlanMode(),
        disablePlanMode: () => this.disablePlanMode(),
      };
      out.push(createEnterPlanModeTool(planOpts));
      out.push(createCompletePlanTool(planOpts));
    }
    // Part B2 — git inspect / commit tools. Always workspace-scoped; the
    // commit tool is opt-in via `cfg.git.allowCommit`. `cfg.git === true`
    // is treated as `{ allowCommit: false }` (inspect-only).
    if (cfg.git) {
      const gitCfg = typeof cfg.git === "object" ? cfg.git : {};
      out.push(
        ...createGitTools({
          ...(this.workspace ? { workspace: this.workspace } : {}),
          ...(gitCfg.allowCommit ? { allowCommit: true } : {}),
        }),
      );
    }
    // Code mode v1 — opt-in `run_code_mode` meta-tool. Wired LAST so the
    // closure over `out` captures every tool registered above; the tool
    // re-reads `out` at CALL time (we pass a thunk into createCodeModeTool)
    // so MCP tools / other late registrations are visible too. Default off:
    // requires explicit cfg.code_mode and at least one whitelisted tool
    // already in the registry.
    if (cfg.code_mode) {
      const cmCfg = typeof cfg.code_mode === "object" ? cfg.code_mode : {};
      out.push(
        createCodeModeTool({
          tools: () => this.tools,
          ...(this.workspace ? { workspace: this.workspace } : {}),
          ...(cmCfg.allowWrite ? { allowWrite: true } : {}),
          ...(cmCfg.allowBash ? { allowBash: true } : {}),
          ...(cmCfg.extraAllowedTools
            ? { extraAllowedTools: cmCfg.extraAllowedTools }
            : {}),
          ...(typeof cmCfg.memoryLimitBytes === "number"
            ? { memoryLimitBytes: cmCfg.memoryLimitBytes }
            : {}),
          ...(typeof cmCfg.timeoutMs === "number"
            ? { timeoutMs: cmCfg.timeoutMs }
            : {}),
        }),
      );
    }
    return out;
  }

  /**
   * Hooks v1 (`src/core/hooks/v1/`) — wrap a tool dispatch with PreToolUse /
   * PostToolUse. Single insertion point for v1 tool-side hooks: PreToolUse may
   * BLOCK (short-circuit with `ok: false`) or REWRITE the input; PostToolUse
   * fires after execute (cannot block, additionalContext fed back as system).
   * No-op when no v1 runner is attached.
   */
  private async *executeWithV1Hooks(
    tool: ToolSpec,
    call: { id: string; name: string },
    parsed: Record<string, unknown>,
    callCtx: ToolExecuteContext,
  ): AsyncGenerator<ChatEvent, { ok: boolean; content: string }, void> {
    const v1 = this.hookInvoker?.v1;
    if (!v1 || (!v1.has("PreToolUse") && !v1.has("PostToolUse"))) {
      return yield* this.executeWithApproval(tool, call, parsed, callCtx);
    }
    let effectiveParsed = parsed;
    if (v1.has("PreToolUse")) {
      const pre = await v1.preToolUse({
        toolName: call.name,
        toolInput: parsed,
        toolUseId: call.id,
      });
      for (const ctxText of pre.additionalContexts) {
        this.messages.push({ role: "system", content: ctxText });
      }
      if (pre.blocked) {
        return { ok: false, content: `⛔ ${pre.blockReason ?? "tool call blocked by PreToolUse hook"}` };
      }
      if (pre.updatedInput) effectiveParsed = pre.updatedInput;
    }
    const result = yield* this.executeWithApproval(tool, call, effectiveParsed, callCtx);
    if (v1.has("PostToolUse")) {
      const post = await v1.postToolUse({
        toolName: call.name,
        toolInput: effectiveParsed,
        toolResult: result,
        toolUseId: call.id,
      });
      for (const ctxText of post.additionalContexts) {
        this.messages.push({ role: "system", content: ctxText });
      }
    }
    return result;
  }

  /**
   * Hooks v1 — fire SessionStart exactly once per session (idempotent). Hooks'
   * `additionalContext` strings get pre-loaded as system messages.
   */
  private sessionStartV1Fired = false;
  private async maybeFireSessionStartV1(): Promise<void> {
    if (this.sessionStartV1Fired) return;
    this.sessionStartV1Fired = true;
    const v1 = this.hookInvoker?.v1;
    if (!v1 || !v1.has("SessionStart")) return;
    try {
      const out = await v1.sessionStart({ source: "startup" });
      for (const ctxText of out.additionalContexts) {
        this.messages.push({ role: "system", content: ctxText });
      }
    } catch {
      // SessionStart failures are surfaced inside `out.results[*]` only; never throw.
    }
  }

  /**
   * Run a tool through the approval broker (Approval Policy 矩阵), then execute
   * it (or not) per the verdict. An async generator: it yields `approval_request`
   * / `approval_resolved` events around any user prompt and **returns** the tool
   * result the loop feeds back to the model (consume via `yield*`). When no
   * broker is wired, or the tool carries no `riskClass`, this is a thin
   * pass-through to `tool.execute` (legacy zero-approval behaviour).
   *
   * Prompts are driven by the session-level {@link approvalResolver} when set
   * (yield-based, keeps serve's SSE stream open); otherwise the broker's own
   * resolver drives them (CLI/tests). With neither, prompts fail safe to deny.
   */
  private async *executeWithApproval(
    tool: ToolSpec,
    call: { id: string; name: string },
    parsed: Record<string, unknown>,
    callCtx: ToolExecuteContext,
  ): AsyncGenerator<ChatEvent, { ok: boolean; content: string }, void> {
    // Part B1 — Plan mode HARD gate. Runs BEFORE permission profiles +
    // approval broker so even an approved tool cannot run while the
    // session is in plan mode. Caught by `runRounds` / loop and surfaced
    // back to the model as an `ok: false` tool result.
    //
    // A tool passes the gate when EITHER:
    //   • it opts in via `ToolSpec.readOnly === true` (the conservative
    //     default — unknown / un-classified tools are blocked), OR
    //   • its name is in `PLAN_MODE_TOOL_WHITELIST` (meta-tools like
    //     `complete_plan` / `ask_user` / `todo_write` that the LLM still
    //     needs while planning, see the whitelist definition above for
    //     rationale).
    //
    // Everything else (`write_file`, `edit_file`, `bash`, `run_python`,
    // `run_latex`, `dispatch_subagent`, `propose_goal`, `propose_plan`,
    // …) is hard-rejected with `PlanModeBlockedError`.
    if (
      this.planMode &&
      tool.readOnly !== true &&
      !PLAN_MODE_TOOL_WHITELIST.has(call.name)
    ) {
      throw new PlanModeBlockedError(call.name);
    }

    // Permission Profiles (#2): HARD reject at the dispatch entry — before the
    // approval broker, so the user can never override it. Applies to:
    //   - any tool the active profile explicitly denies (denylistTools), and
    //   - mutating tool calls under a read-only (ci) or hard-reject (review)
    //     profile.
    const profile = this.profile;
    if (profile) {
      if (profile.denylistTools.includes(call.name)) {
        return {
          ok: false,
          content: `⛔ tool '${call.name}' is blocked by permission profile '${profile.name}'`,
        };
      }
      if (profile.readOnlyMode || profile.hardRejectMutations) {
        const riskClass = tool.riskClass ?? "read";
        if (isMutatingCall(call.name, riskClass, parsed)) {
          const reason = profile.readOnlyMode
            ? `read-only mode (profile '${profile.name}') forbids mutating tool '${call.name}'`
            : `profile '${profile.name}' forbids mutation — '${call.name}' is rejected even with approval`;
          return { ok: false, content: `⛔ ${reason}` };
        }
      }
    }

    const broker = this.approvalBroker;
    if (!broker || !tool.riskClass) {
      return await tool.execute(parsed, callCtx);
    }
    const authCall = {
      tool: call.name,
      riskClass: tool.riskClass,
      args: parsed,
      id: call.id,
    };

    // When no session-level resolver is wired, defer entirely to the broker's
    // own resolver (CLI/tests) — no event yielding needed.
    if (!this.approvalResolver) {
      const auth = await broker.authorize(authCall);
      if (auth.kind === "deny") {
        return {
          ok: false,
          content: `⛔ tool call denied by approval policy: ${auth.reason}`,
        };
      }
      if (auth.kind === "allow") {
        return yield* this.maybePreviewThenExecute(tool, call, parsed, callCtx);
      }
      return yield* this.runDeferOnFailure(tool, authCall, parsed, callCtx, null);
    }

    // Session-driven (yield-based) prompt flow.
    const resolver = this.approvalResolver;
    const pre = await broker.preCheck(authCall);
    if (pre.kind === "deny") {
      return {
        ok: false,
        content: `⛔ tool call denied by approval policy: ${pre.reason}`,
      };
    }
    if (pre.kind === "allow") {
      return yield* this.maybePreviewThenExecute(tool, call, parsed, callCtx);
    }
    if (pre.kind === "defer-on-failure") {
      return yield* this.runDeferOnFailure(tool, authCall, parsed, callCtx, resolver);
    }
    // pre.kind === "ask": surface the request, await the decision, continue.
    yield { type: "approval_request", request: pre.request };
    const decision = await resolver(pre.request);
    yield { type: "approval_resolved", id: pre.request.id, decision };
    const verdict = await broker.resolveDecision(authCall, decision);
    if (verdict.kind === "deny") {
      return {
        ok: false,
        content: `⛔ tool call denied by approval policy: ${verdict.reason}`,
      };
    }
    if (verdict.kind === "defer-on-failure") {
      return yield* this.runDeferOnFailure(tool, authCall, parsed, callCtx, resolver);
    }
    return yield* this.maybePreviewThenExecute(tool, call, parsed, callCtx);
  }

  /**
   * UX gap A — Diff preview gate around an already-AUTHORISED write. Called at
   * every `allow` exit of {@link executeWithApproval}. When the call is a
   * write-style tool whose matching `allow` rule set `requireDiffPreview` AND a
   * {@link writeProposalResolver} is wired, it:
   *
   *   1. reads the existing file content (if any),
   *   2. builds a {@link WriteProposal} (unified diff + truncated contents),
   *   3. yields a `propose-write` event and BLOCKS on the resolver,
   *   4. yields `propose-write-resolved`, then either runs the write (optionally
   *      with the user's edited whole-file content) or returns a rejection.
   *
   * In every other case (no resolver, rule doesn't require preview, non-write
   * tool, or a proposal that can't be derived) it is a thin pass-through to
   * `tool.execute` — preserving the legacy behaviour exactly.
   */
  private async *maybePreviewThenExecute(
    tool: ToolSpec,
    call: { id: string; name: string },
    parsed: Record<string, unknown>,
    callCtx: ToolExecuteContext,
  ): AsyncGenerator<ChatEvent, { ok: boolean; content: string }, void> {
    const broker = this.approvalBroker;
    if (
      !this.writeProposalResolver ||
      !broker ||
      tool.riskClass !== "write" ||
      typeof parsed.path !== "string" ||
      !parsed.path
    ) {
      return await tool.execute(parsed, callCtx);
    }
    const needPreview = await broker.requiresDiffPreview({
      tool: call.name,
      args: parsed,
    });
    if (!needPreview) {
      return await tool.execute(parsed, callCtx);
    }

    const rawPath = parsed.path;
    const workspace = callCtx.workspace ?? this.workspace ?? null;
    const resolved = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(workspace ?? process.cwd(), rawPath);

    // Workspace-escape boundary: mirror the write tools' own containment check
    // (write-file.ts / edit-file.ts `resolvePath`). A path that escapes the
    // workspace must NOT be previewed-then-written directly here — fall through
    // to `tool.execute`, which rejects it with the canonical "escapes
    // workspace" error. This keeps the boundary intact on the
    // accept-with-edited-content path (which writes `resolved` directly).
    if (workspace) {
      const rel = path.relative(workspace, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return await tool.execute(parsed, callCtx);
      }
    }

    const fs = await import("node:fs/promises");
    let oldContent: string | null = null;
    let exists = false;
    try {
      oldContent = await fs.readFile(resolved, "utf-8");
      exists = true;
    } catch {
      oldContent = null;
      exists = false;
    }

    const proposal = buildWriteProposal({
      toolCallId: call.id,
      tool: call.name,
      args: parsed,
      path: rawPath,
      oldContent,
      exists,
    });
    // No derivable preview (unknown tool / ambiguous edit match) — let the tool
    // run and fail loudly on its own terms rather than silently swallow it.
    if (!proposal) {
      return await tool.execute(parsed, callCtx);
    }

    yield { type: "propose-write", proposal };
    const decision = await this.writeProposalResolver(proposal);
    yield { type: "propose-write-resolved", toolCallId: call.id, decision };

    if (decision.outcome === "decline") {
      return {
        ok: false,
        content:
          "⛔ write rejected by user (diff preview declined) — revise the change or pick a different approach",
      };
    }

    // Accept. When the user edited the content in the modal, that edited string
    // is the FULL new file. For write_file we just swap the `content` arg and
    // reuse the tool (keeping its hooks / read-tracking). For other write tools
    // (edit_file) the edited whole-file content can't round-trip through the
    // tool's own diff-apply, so we write it directly.
    if (typeof decision.editedContent === "string") {
      if (call.name === "write_file") {
        return await tool.execute(
          { ...parsed, content: decision.editedContent },
          callCtx,
        );
      }
      return await this.applyEditedWrite(
        resolved,
        rawPath,
        decision.editedContent,
        callCtx,
      );
    }

    return await tool.execute(parsed, callCtx);
  }

  /**
   * Write `content` directly to `resolved`, honouring pre/post-edit hooks and
   * read-tracking. Used only on a diff-preview "accept with edits" for a tool
   * (edit_file) whose own execute path can't take a whole-file replacement.
   */
  private async applyEditedWrite(
    resolved: string,
    rawPath: string,
    content: string,
    callCtx: ToolExecuteContext,
  ): Promise<{ ok: boolean; content: string }> {
    const fs = await import("node:fs/promises");
    try {
      if (callCtx.hooks) {
        const pre = await callCtx.hooks.run("pre-edit", { filePath: resolved });
        if (pre.blocked) {
          return { ok: false, content: formatHookBlock("edit_file", pre) };
        }
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      // 2026-06-25 audit M2 — atomic write so a crash mid-edit can't
      // truncate the user's source file. fs.writeFile alone leaves a
      // half-written file on the filesystem if the process dies between
      // the open and the final flush.
      await atomicWriteFile(resolved, content);
    } catch (err: any) {
      return {
        ok: false,
        content: `edit_file error: ${err?.message ?? String(err)}`,
      };
    }
    callCtx.recordRead?.(resolved);
    const bytes = Buffer.byteLength(content, "utf-8");
    let result = `wrote ${bytes} bytes to ${rawPath} (user-edited via diff preview)`;
    if (callCtx.hooks) {
      const post = await callCtx.hooks.run("post-edit", { filePath: resolved });
      if (post.summary) result += `\n\n${post.summary}`;
    }
    return { ok: true, content: result };
  }

  /**
   * `on-failure` policy: run the tool, then on failure ask retry/abandon. When
   * `resolver` is set, prompts are yield-based (serve); otherwise the broker's
   * own resolver drives them (CLI/tests).
   */
  private async *runDeferOnFailure(
    tool: ToolSpec,
    authCall: {
      tool: string;
      riskClass: RiskClass;
      args: Record<string, unknown>;
      id: string;
    },
    parsed: Record<string, unknown>,
    callCtx: ToolExecuteContext,
    resolver: ApprovalResolver | null,
  ): AsyncGenerator<ChatEvent, { ok: boolean; content: string }, void> {
    const broker = this.approvalBroker!;
    let result = await tool.execute(parsed, callCtx);
    let guard = 0;
    const MAX_RETRIES = 5;
    while (!result.ok && guard < MAX_RETRIES) {
      let failure;
      if (resolver) {
        const request = broker.buildFailureRequest(authCall, result.content);
        yield { type: "approval_request", request };
        const decision = await resolver(request);
        yield { type: "approval_resolved", id: request.id, decision };
        failure = broker.applyFailureDecision(decision);
      } else {
        failure = await broker.onFailure(authCall, result.content);
      }
      if (failure.kind === "retry") {
        result = await tool.execute(parsed, callCtx);
        guard++;
        continue;
      }
      return {
        ok: false,
        content: `⛔ tool failed and the user abandoned it: ${failure.reason}\n\n--- original failure ---\n${result.content}`,
      };
    }
    return result;
  }

  private makeSearchTool(): ToolSpec {
    const self = this;
    return {
      name: "search",
      riskClass: "read",
      description:
        "Search the workspace for a pattern. Use this when looking for code, text, or files. Returns top files and counts; full results are stored in an artifact.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Pattern to search for (literal text).",
          },
          glob: {
            type: "string",
            description: "Optional file glob, e.g. **/*.ts",
          },
          caseInsensitive: {
            type: "boolean",
            description: "If true, the match is case-insensitive.",
          },
        },
        required: ["query"],
      },
      async execute(args: Record<string, unknown>) {
        const query = typeof args.query === "string" ? args.query : "";
        const glob = typeof args.glob === "string" ? args.glob : undefined;
        const caseInsensitive =
          typeof args.caseInsensitive === "boolean" ? args.caseInsensitive : undefined;
        try {
          const sched = self.getOrBuildScheduler();
          const result = await sched.dispatch({
            type: "search",
            input: {
              query,
              ...(glob !== undefined ? { globPattern: glob } : {}),
              ...(caseInsensitive !== undefined ? { caseInsensitive } : {}),
            },
            hardCapBytes: 2048,
          });
          if (result.status === "error" || result.status === "timeout") {
            return {
              ok: false,
              content: `search failed (${result.status}): ${result.errorMessage ?? "unknown error"}`,
            };
          }
          return { ok: true, content: result.summary };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, content: `search error: ${msg}` };
        }
      },
    };
  }

  /**
   * Construct the `read_file_summary` ToolSpec. The closure captures `this`
   * so the tool can lazily resolve `getOrBuildScheduler()` at call time —
   * matches the compact lazy-init pattern.
   */
  private makeReadFileSummaryTool(): ToolSpec {
    const self = this;
    return {
      name: "read_file_summary",
      riskClass: "read",
      description:
        "Read a file and get a focused summary answering your question. " +
        "Use this for long files where you only need specific information. " +
        "Returns summary text and a link to the cached source.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to workspace",
          },
          question: {
            type: "string",
            description: "What you want to know from the file",
          },
        },
        required: ["path", "question"],
      },
      async execute(args: Record<string, unknown>) {
        const filePath = typeof args.path === "string" ? args.path : "";
        const question = typeof args.question === "string" ? args.question : "";
        if (!filePath) {
          return { ok: false, content: "error: read_file_summary requires 'path'" };
        }
        if (!question) {
          return {
            ok: false,
            content: "error: read_file_summary requires 'question'",
          };
        }
        try {
          const sched = self.getOrBuildScheduler();
          const result = await sched.dispatch({
            type: "read_summarize",
            input: {
              path: filePath,
              question,
              llm: self.llm,
              modelHint: self.model,
            } as unknown as Record<string, unknown>,
            hardCapBytes: 2048,
          });
          if (result.status !== "ok") {
            // Surface the error text directly to the model so it can recover
            // (try a different path, ask for help, etc.). Don't throw.
            const reason =
              result.summary || result.errorMessage || `status=${result.status}`;
            return { ok: false, content: `read_file_summary error: ${reason}` };
          }
          const link = result.artifactPath
            ? `\n\nFull source cached at: ${result.artifactPath}`
            : "";
          return { ok: true, content: result.summary + link };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, content: `read_file_summary error: ${msg}` };
        }
      },
    };
  }

  /** Resolve (or lazily build) the scheduler used for compact dispatch. */
  private getOrBuildScheduler(): SubagentScheduler {
    if (this.subagentScheduler) return this.subagentScheduler;
    const registry = new SubagentRegistry();
    registry.register(compactRunner);
    registry.register(searchRunner);
    registry.register(readSummarizeRunner);
    // Workspace: prefer user-provided; otherwise use process.cwd() as a sane
    // default (artifacts land under <cwd>/.mathran/subagents/<runId>/).
    const ws = this.workspace ?? process.cwd();
    return new SubagentScheduler({ workspace: ws, registry });
  }

  /**
   * Compact the current history via the `compact` subagent runner. Always
   * preserves the leading system message; drops the middle chunk in favor of
   * a single summary `role:"system"` message; keeps the last
   * `keepRecentRounds` user-rooted rounds verbatim.
   *
   * Concurrent calls await the first in-flight compaction.
   */
  async compact(opts?: { keepRecentRounds?: number }): Promise<CompactStats> {
    if (this.compactInFlight) return this.compactInFlight;
    this.compactInFlight = this.compactImpl(opts).finally(() => {
      this.compactInFlight = null;
    });
    return this.compactInFlight;
  }

  private async compactImpl(opts?: { keepRecentRounds?: number }): Promise<CompactStats> {
    const sched = this.getOrBuildScheduler();
    const cfg = this.autoCompactCfg;
    const keepRecentRounds =
      opts?.keepRecentRounds ??
      cfg?.keepRecentRounds ??
      DEFAULT_KEEP_RECENT_ROUNDS;
    const contextWindow = cfg?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

    const input: CompactRunnerInput = {
      messages: this.messages.map((m) => ({ ...m })),
      contextWindow,
      keepRecentRounds,
      modelHint: this.model,
      llm: this.llm,
    };

    const result = await sched.dispatch({
      type: "compact",
      input: input as unknown as Record<string, unknown>,
    });

    if (result.status !== "ok" || !result.artifactPath) {
      throw new Error(
        `compact failed: ${result.status}${
          result.errorMessage ? ": " + result.errorMessage : ""
        }`,
      );
    }

    // Read the artifact and swap messages.
    const ws = this.workspace ?? process.cwd();
    const relative = result.artifactPath;
    // artifactPath is POSIX-style relative to workspace, of the form
    // `.mathran/subagents/<runId>/compacted.json`. Recover runId + filename to
    // call readArtifact (which already knows the layout).
    const segs = relative.split("/");
    const filename = segs[segs.length - 1];
    const runId = segs[segs.length - 2];
    let raw: string;
    try {
      raw = await readArtifact(ws, runId, filename);
    } catch {
      // Fallback: read directly via path.join.
      raw = await (await import("node:fs/promises")).readFile(
        path.join(ws, relative),
        "utf8",
      );
    }
    const artifact = JSON.parse(raw) as CompactedArtifact;

    if (!artifact.noop) {
      this.messages = artifact.newMessages.map((m) => ({ ...m }));
    }

    const stats: CompactStats = {
      originalTokenCount: artifact.originalTokenCount,
      newTokenCount: artifact.newTokenCount,
      droppedRoundCount: artifact.droppedRoundCount,
      noop: artifact.noop,
    };
    // Surface a warning if we still exceed the threshold after compaction,
    // so the caller / auto-compact loop doesn't infinitely re-trigger.
    if (cfg && !artifact.noop) {
      const thresholdPct = cfg.thresholdPct ?? 0.75;
      const limit = contextWindow * thresholdPct;
      if (artifact.newTokenCount > limit) {
        stats.warning = `compacted history (${artifact.newTokenCount} tok) still exceeds threshold (${Math.round(
          limit,
        )} tok); will not re-compact this turn`;
      }
    }
    return stats;
  }

  /**
   * Auto-compact pre-turn check (v0.2 §5 + TODO-2 §3.2). Called once at
   * the start of {@link send} when `autoCompact.enabled` is true. Silent
   * no-op when the provider can't count tokens, or when the count is
   * under the configured threshold. Routes through `compactV2({
   * phase: "pre_turn", policy: "do_not_inject" })`.
   */
  private async maybeAutoCompactPreTurn(): Promise<void> {
    const cfg = this.autoCompactCfg;
    if (!cfg?.enabled) return;
    const llm = this.llm as LLMProvider & { countTokens?: (m: LLMMessage[]) => number };
    if (typeof llm.countTokens !== "function") return;
    let count: number;
    try {
      count = llm.countTokens(this.messages);
    } catch {
      return; // never crash the send path due to counting errors
    }
    if (typeof count !== "number" || !Number.isFinite(count)) return;
    // 2026-06-29 (codex-parity) — if `absoluteThresholdTokens` is set, it
    // takes precedence over thresholdPct*contextWindow. Aligns with
    // codex's `model_auto_compact_token_limit` semantics
    // (codex-rs/core/src/session/turn.rs::auto_compact_token_status).
    const window = cfg.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const threshold =
      cfg.absoluteThresholdTokens && cfg.absoluteThresholdTokens > 0
        ? cfg.absoluteThresholdTokens
        : window * (cfg.thresholdPct ?? 0.75);
    if (count <= threshold) return;
    try {
      // Reset mid-turn accumulator on every pre-turn boundary — the
      // counter restarts cleanly each user-initiated send.
      this.cumulativeInputTokens = 0;
      const out = await this.compactV2({
        reason: "budget_exceeded",
        phase: "pre_turn",
        trigger: "auto",
      });
      // After a successful compact, the mid-turn precheck shouldn't
      // immediately re-trigger off pre-compaction token measurements.
      if (out.ok) this.cumulativeInputTokens = 0;
    } catch {
      // Swallow: auto-compact must never block the user's send.
    }
  }

  /**
   * TODO-2 §3.2 — Auto-compact mid-turn check. Invoked from the inner
   * LLM round-trip loop AFTER each provider-reported `usage` event.
   * Tallies the cumulative input tokens spent inside this send() and
   * triggers `compactV2({ phase: "mid_turn", policy: "before_last_user_message" })`
   * when the cumulative tally exceeds `midTurnThresholdPct * contextWindow`.
   *
   * The default `midTurnThresholdPct = thresholdPct + 0.05` is slightly
   * above the pre-turn threshold so a single high-usage round inside a
   * conversation that's already close to the limit doesn't double-fire
   * pre-turn + mid-turn compaction back-to-back.
   *
   * Mid-turn compaction is OPT-IN via `autoCompact.enableMidTurnPrecheck`.
   * For the default chat-mode case (off), this is a zero-cost no-op.
   */
  private async maybeAutoCompactMidTurn(args: {
    realPromptTokens?: number;
  }): Promise<void> {
    const cfg = this.autoCompactCfg;
    if (!cfg?.enabled || !cfg.enableMidTurnPrecheck) return;
    if (typeof args.realPromptTokens !== "number" || !Number.isFinite(args.realPromptTokens)) return;
    // Accumulate. mid-turn precheck uses *provider-reported* tokens
    // rather than countTokens — the provider's count IS the truth.
    this.cumulativeInputTokens += args.realPromptTokens;
    // 2026-06-29 (codex-parity) — mid-turn absolute threshold takes
    // precedence over midTurnThresholdPct*contextWindow.
    const window = cfg.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const threshold =
      cfg.midTurnAbsoluteThresholdTokens && cfg.midTurnAbsoluteThresholdTokens > 0
        ? cfg.midTurnAbsoluteThresholdTokens
        : window * (cfg.midTurnThresholdPct ?? ((cfg.thresholdPct ?? 0.75) + 0.05));
    if (this.cumulativeInputTokens <= threshold) return;
    try {
      const out = await this.compactV2({
        reason: "token_limit",
        phase: "mid_turn",
        trigger: "auto",
      });
      // Successful mid-turn compaction → reset accumulator so the next
      // few rounds don't immediately re-trigger.
      if (out.ok) this.cumulativeInputTokens = 0;
    } catch {
      // Swallow — mid-turn compaction must NEVER break the send loop.
    }
  }

  /**
   * TODO-2 §3.2 — V2 compaction entry. Routes through the multi-strategy
   * dispatcher (compact-strategies.ts) so plugins can register alternate
   * strategies. The built-in `LocalCompactionStrategy` is lazily
   * registered on first call.
   *
   * Concurrent calls are deduped (second caller awaits the first).
   *
   * Callers pass only the request-specific fields (reason, phase, trigger,
   * optional hooks); this method fills in messages / llm / model /
   * contextWindow / keepRecentRounds from the session state and resolves
   * the appropriate SummaryInjectionPolicy via injectionPolicyForPhase().
   *
   * On ok=true the new history is swapped into `this.messages`. On
   * ok=false (cancelled / skipped / failed), `this.messages` is left
   * untouched — the original prompt will be sent to the LLM unchanged,
   * which may then throw context-overflow itself. Compaction is a
   * best-effort optimization, NOT a correctness invariant.
   */
  async compactV2(req: {
    reason: CompactionReason;
    phase: CompactionPhase;
    trigger: CompactionTrigger;
    policy?: import("../subagent/runners/compact-types.js").SummaryInjectionPolicy;
    hooks?: CompactionHooks;
    signal?: AbortSignal;
  }): Promise<CompactionOutcome> {
    if (this.compactInFlightV2) return this.compactInFlightV2;
    this.compactInFlightV2 = this.compactV2Impl(req).finally(() => {
      this.compactInFlightV2 = null;
    });
    return this.compactInFlightV2;
  }

  private async compactV2Impl(req: {
    reason: CompactionReason;
    phase: CompactionPhase;
    trigger: CompactionTrigger;
    policy?: import("../subagent/runners/compact-types.js").SummaryInjectionPolicy;
    hooks?: CompactionHooks;
    signal?: AbortSignal;
  }): Promise<CompactionOutcome> {
    // Lazy register built-in strategies on first call.
    ensureBuiltInsRegistered(() => new LocalCompactionStrategy());

    const cfg = this.autoCompactCfg;
    const fullReq: CompactionRequest = {
      messages: this.messages.map((m) => ({ ...m })),
      reason: req.reason,
      phase: req.phase,
      trigger: req.trigger,
      policy: req.policy ?? injectionPolicyForPhase(req.phase),
      keepRecentRounds: cfg?.keepRecentRounds ?? DEFAULT_KEEP_RECENT_ROUNDS,
      contextWindow: cfg?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      modelHint: this.model,
      llm: this.llm,
      signal: req.signal,
      hooks: req.hooks,
    };

    // Hooks v1 — PreCompact may block this attempt entirely. The compact's
    // own caller-supplied `req.hooks.pre` runs AFTER v1 (so v1 acts as a
    // shared cross-call gate, then per-call hooks fine-tune).
    const v1Pre = this.hookInvoker?.v1;
    if (v1Pre?.has("PreCompact")) {
      const pre = await v1Pre.preCompact({ phase: req.phase, reason: req.reason });
      if (pre.blocked) {
        const now = Date.now();
        const skipped: CompactionOutcome = {
          ok: false,
          status: "skipped",
          error: pre.blockReason ?? "v1 PreCompact hook blocked compaction",
          telemetry: {
            reason: fullReq.reason,
            phase: fullReq.phase,
            trigger: fullReq.trigger,
            policy: fullReq.policy,
            strategy: "local",
            startedAtMs: now,
            endedAtMs: now,
            durationMs: 0,
            status: "skipped",
            originalTokens: 0,
            newTokens: 0,
            droppedRoundCount: 0,
            retryAttempts: 0,
            hookOutcomes: { pre: "stopped" },
          },
        };
        this.emitCompactionToObserver(skipped);
        return skipped;
      }
    }

    // Optional PreCompact hook: caller can veto.
    if (fullReq.hooks?.pre) {
      try {
        const pre = await fullReq.hooks.pre(fullReq);
        if (pre.kind === "stopped") {
          const now = Date.now();
          const skipped: CompactionOutcome = {
            ok: false,
            status: "skipped",
            error: pre.reason,
            telemetry: {
              reason: fullReq.reason,
              phase: fullReq.phase,
              trigger: fullReq.trigger,
              policy: fullReq.policy,
              strategy: "local",
              startedAtMs: now,
              endedAtMs: now,
              durationMs: 0,
              status: "skipped",
              originalTokens: 0,
              newTokens: 0,
              droppedRoundCount: 0,
              retryAttempts: 0,
              hookOutcomes: { pre: "stopped" },
            },
          };
          this.emitCompactionToObserver(skipped);
          return skipped;
        }
      } catch {
        // Hook crashes are non-fatal — proceed with compaction.
      }
    }

    const strategy = pickStrategy(fullReq);
    const outcome = await strategy.run(fullReq);

    // Swap messages on success ONLY. Failure / cancel / skip leaves
    // this.messages intact (best-effort contract).
    if (outcome.ok && outcome.newMessages) {
      this.messages = outcome.newMessages.map((m) => ({ ...m }));
    }

    // Optional PostCompact hook.
    if (outcome.ok && fullReq.hooks?.post) {
      try {
        await fullReq.hooks.post(outcome.telemetry);
      } catch {
        // Hook crashes are non-fatal.
      }
    }

    // Hooks v1 — PostCompact fires after every compaction attempt (regardless
    // of ok/skipped/failed). Cannot block (already done); used for telemetry
    // or external alerts. Hook crashes are swallowed (see invoker).
    const v1Post = this.hookInvoker?.v1;
    if (v1Post?.has("PostCompact")) {
      await v1Post.postCompact({
        phase: req.phase,
        reason: req.reason,
        status: outcome.telemetry.status,
        droppedRoundCount: outcome.telemetry.droppedRoundCount,
      });
    }

    // TODO-2 §3.2 / C8 — emit a 'compaction' ChatEvent to the configured
    // observer (goal-mode runner forwards this to SSE + bumps Goal.stats).
    // Skip the noop case (droppedRoundCount=0) to avoid noise; only
    // actual compactions OR explicit failures are surfaced.
    this.emitCompactionToObserver(outcome);

    return outcome;
  }

  /**
   * TODO-2 §3.2 / C8 — push a compaction outcome to the optional
   * onCompactionEvent observer. Filters noop (status=ok with no rounds
   * dropped); reports actual compactions AND failure/cancel/skip
   * statuses. Listener exceptions are swallowed.
   */
  private emitCompactionToObserver(outcome: CompactionOutcome): void {
    if (!this.onCompactionEvent) return;
    const isNoop = outcome.ok && outcome.telemetry.droppedRoundCount === 0;
    if (isNoop) return;
    try {
      this.onCompactionEvent({
        type: "compaction",
        outcome: outcome.status,
        reason: outcome.telemetry.reason,
        phase: outcome.telemetry.phase,
        trigger: outcome.telemetry.trigger,
        policy: outcome.telemetry.policy,
        originalTokens: outcome.telemetry.originalTokens,
        newTokens: outcome.telemetry.newTokens,
        droppedRoundCount: outcome.telemetry.droppedRoundCount,
        durationMs: outcome.telemetry.durationMs,
        ...(outcome.telemetry.summaryTokens !== undefined
          ? { summaryTokens: outcome.telemetry.summaryTokens }
          : {}),
      });
    } catch {
      // Listener crashes never escape compactV2.
    }
  }

  /**
   * Run one user turn. Streams text/tool events; resolves the conversation by
   * looping through tool calls until the model stops requesting them.
   */
  async *send(
    userText: MessageContent,
    opts: SendOpts = {},
  ): AsyncIterable<ChatEvent> {
    const signal = opts.signal;
    // Abort before we touch history: leave `messages` untouched and bail.
    if (signal?.aborted) throw abortError();

    // Hooks v1 — fire SessionStart exactly once per session (idempotent).
    // Any `additionalContext` strings the hooks emit are pre-loaded as
    // system messages so the model sees them before the first user turn.
    await this.maybeFireSessionStartV1();

    // Reset mid-turn token accumulator for this fresh user-initiated send().
    this.cumulativeInputTokens = 0;

    // Auto-compact pre-check (v0.2 §5 + TODO-2 §3.2): compact BEFORE we
    // push the new user message, so we don't immediately discard it.
    // Silent on failure.
    await this.maybeAutoCompactPreTurn();

    // Skills/Plugins 二层 §B.2: match trigger-bearing skills against this
    // message and inject their rendered prompt as a TRANSIENT system message
    // (removed after the turn so a long chat doesn't accumulate stale skill
    // fragments). Matched skills also register their `allowedTools` as
    // temporary approval rules for the rest of the session.
    //
    // Skill matching is text-based: when we receive a ContentPart[] (vision)
    // we collapse to the leading text part for trigger matching only — the
    // image parts pass through unchanged into the persisted message.
    const triggerText =
      typeof userText === "string" ? userText : contentToString(userText);
    const skillMessage = this.activateTriggeredSkills(triggerText);

    this.messages.push(
      opts.attachments && opts.attachments.length > 0
        ? { role: "user", content: userText, attachments: opts.attachments }
        : { role: "user", content: userText },
    );

    try {
      yield* this.runRounds(opts);
    } finally {
      // Drop the transient skill fragment from history (keep the user turn).
      if (skillMessage) {
        const idx = this.messages.indexOf(skillMessage);
        if (idx >= 0) this.messages.splice(idx, 1);
      }
    }
  }

  /**
   * Match the session's trigger-bearing skills against `userText`. For each
   * match: register its `allowedTools` as temporary approval rules and collect
   * its rendered prompt. When any skill matched, push a single combined
   * system message and RETURN it so the caller can remove it after the turn
   * (per-turn injection — decision F.2). Returns `null` when nothing matched.
   *
   * Never throws: skill activation must not break a user turn.
   */
  private activateTriggeredSkills(userText: string): LLMMessage | null {
    if (this.triggerSkills.length === 0) return null;
    try {
      const matches = matchSkillTriggers({
        skills: this.triggerSkills,
        userMessage: userText,
      });
      if (matches.length === 0) return null;
      const fragments: string[] = [];
      for (const m of matches) {
        registerSkillToolRules(this.approvalBroker, m.skill);
        const rendered = renderSkillPrompt(m.skill, userText);
        if (rendered.trim().length > 0) fragments.push(rendered.trim());
      }
      if (fragments.length === 0) return null;
      const message: LLMMessage = {
        role: "system",
        content: fragments.join("\n\n"),
      };
      this.messages.push(message);
      return message;
    } catch {
      return null;
    }
  }

  /**
   * Resume the LLM loop *without* pushing a new user message (v0.16 §11).
   *
   * Use this after the caller has mutated `messages` in place — the
   * canonical case is the serve `/answer-ask` endpoint patching the
   * placeholder tool result for a pending `ask_user` call to the user's
   * reply, then resuming the same round.
   *
   * Skips both auto-compact (the in-place mutation just happened; we'd
   * lose the freshly-patched tool result) and the user-message push
   * (resume callers continue mid-round, not at a turn boundary).
   * Otherwise identical to `send` — same tool-call loop, same event
   * stream, same abort handling.
   */
  async *resume(opts: SendOpts = {}): AsyncIterable<ChatEvent> {
    const signal = opts.signal;
    if (signal?.aborted) throw abortError();
    yield* this.runRounds(opts);
  }

  /**
   * Internal shared loop body used by both `send` and `resume`. Keeping
   * the tool-call round-trip + provider-validation invariants in one
   * place means adding new entry points (resume, slash-command-driven
   * LLM call, …) doesn't drift on history bookkeeping.
   */
  /** The text of the most recent user message (for on-goal-complete). */
  private lastUserText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "user" && typeof m.content === "string") return m.content;
    }
    return "";
  }

  private async *runRounds(opts: SendOpts): AsyncIterable<ChatEvent> {
    const signal = opts.signal;
    const steerProbe = opts.steerProbe;

    for (let round = 0; round <= this.maxToolRounds; round++) {
      // Abort between rounds (history is well-formed here: every prior
      // assistant tool-call has a paired tool result).
      if (signal?.aborted) throw abortError();

      // v0.17 mathub parity W9 — Live Steering. Probe BEFORE we build
      // the LLM request so the steered user message is part of `messages`
      // when we ship the next request, AND so the persisted history
      // (history() = this.messages) shows the steer between rounds. The
      // probe is consume-on-read: if it returns a non-empty string, we
      // own it. The synthetic user message is intentionally a plain
      // text turn (no tool_calls) so provider validation stays happy at
      // any round-boundary (after an assistant message with no tool
      // calls, or after a tool result from the previous round). Errors
      // from the probe propagate — a misbehaving server callback should
      // fail loudly, not silently swallow user input.
      if (steerProbe) {
        const steered = steerProbe();
        if (typeof steered === "string" && steered.length > 0) {
          this.messages.push({
            role: "user",
            content: `[Steer from user: ${steered}]`,
          });
          yield { type: "steer-received", text: steered };
        }
      }

      // 2026-06-30 plan-tracker bug fix — inject a compact snapshot of the
      // current TODO list as a transient system message so the LLM actually
      // sees its in-flight plan when deciding the next action. Without this,
      // the only signal after writing a plan is the one-line tool result
      // buried deep in history, and the model reliably forgets to mark items
      // `done` (audited 2026-06-30 across alpha + my own workspace: 2/5
      // conversations finished with stale `in_progress` items).
      //
      // The reminder is round-local: we record the message handle in
      // `todoReminderMessage` and splice it back out at the end of the round
      // (after the assistant reply is recorded) so history doesn't accumulate
      // stale snapshots. We deliberately splice BEFORE recording the
      // assistant turn so the persisted jsonl shape matches the pre-fix
      // layout and replay / compaction code paths don't see a foreign
      // system message they have to special-case.
      let todoReminderMessage: LLMMessage | null = null;
      if (this.todoSnapshot) {
        try {
          const list = await this.todoSnapshot();
          const rendered = renderTodoSnapshot(list);
          if (rendered) {
            todoReminderMessage = { role: "system", content: rendered };
            this.messages.push(todoReminderMessage);
          }
        } catch {
          // Snapshot loading must never break a turn — log-via-skip and move
          // on. The model proceeds without the reminder this round.
        }
      }

      const req: LLMRequest = {
        messages: this.messages.map((m) => ({ ...m })),
        model: this.model ?? "",
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
        ...(this.currentEffort !== undefined ? { effort: this.currentEffort } : {}),
        ...(signal ? { signal } : {}),
        ...(this.tools.length > 0
          ? {
              tools: this.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            }
          : {}),
      };

      const response = await this.llm.chat(req);

      let text = "";
      let reasoning = "";
      let finishReason: Extract<LLMStreamChunk, { type: "done" }>["finishReason"] = "stop";
      let usage: { promptTokens: number; completionTokens: number } | undefined;
      const callOrder: string[] = [];
      const calls = new Map<string, PendingToolCall>();

      try {
        for await (const chunk of iterateWithAbort(response.stream(), signal)) {
          if (chunk.type === "text") {
            text += chunk.delta;
            yield { type: "text", delta: chunk.delta };
          } else if (chunk.type === "reasoning") {
            // UX gap B — accumulate the chain-of-thought for persistence and
            // pass each delta through so the SPA can stream the panel live.
            reasoning += chunk.delta;
            yield { type: "reasoning", delta: chunk.delta };
          } else if (chunk.type === "tool-call") {
            const key = chunk.id || chunk.name || `call_${callOrder.length}`;
            let pending = calls.get(key);
            if (!pending) {
              pending = { id: chunk.id || key, name: chunk.name, args: "" };
              calls.set(key, pending);
              callOrder.push(key);
            }
            if (chunk.name) pending.name = chunk.name;
            if (chunk.id) pending.id = chunk.id;
            pending.args += chunk.argsDelta;
          } else if (chunk.type === "done") {
            finishReason = chunk.finishReason;
            if (chunk.usage) usage = chunk.usage;
          }
        }
      } catch (err) {
        if (isAbortError(err)) {
          // 2026-06-30 plan-tracker bug fix — strip the transient TODO
          // reminder BEFORE recording the aborted assistant turn so the
          // persisted history doesn't carry a stray system message that
          // wasn't part of the original prompt design.
          if (todoReminderMessage) {
            const idx = this.messages.indexOf(todoReminderMessage);
            if (idx >= 0) this.messages.splice(idx, 1);
            todoReminderMessage = null;
          }
          // Commit the partial assistant text so the user/goal can see how far
          // we got. We deliberately drop any half-streamed tool calls: the
          // assistant message carries no `toolCalls`, so history stays
          // well-formed (no dangling tool_call awaiting a tool result).
          const aborted: LLMMessage = {
            role: "assistant",
            content: text.length > 0 ? `${text} [aborted]` : "[aborted]",
          };
          // UX gap B — preserve whatever reasoning streamed before the abort
          // so the partial chain-of-thought stays visible on reload.
          if (reasoning.length > 0) aborted.reasoning = reasoning;
          this.messages.push(aborted);
        } else if (todoReminderMessage) {
          // Non-abort error path (provider 5xx, validation reject, …):
          // the assistant turn is NOT committed, so just drop the
          // reminder and let the caller decide whether to retry. Leaving
          // it in history would re-trigger the LLM with a duplicate
          // reminder next round.
          const idx = this.messages.indexOf(todoReminderMessage);
          if (idx >= 0) this.messages.splice(idx, 1);
          todoReminderMessage = null;
        }
        throw err;
      }

      const toolCalls = callOrder
        .map((k) => calls.get(k)!)
        .filter((c) => c.name && c.name.length > 0);

      // Record the assistant turn. We must persist `toolCalls` alongside the
      // text so the next request to the LLM can echo them back in the
      // provider-specific shape (OpenAI `tool_calls`, Anthropic `tool_use`,
      // …). Without this the assistant message paired with the tool result
      // looks malformed and OpenAI / Anthropic / Azure will reject it.
      const assistantMessage: LLMMessage = { role: "assistant", content: text };
      if (reasoning.length > 0) {
        // UX gap B — persist the chain-of-thought on the assistant turn so the
        // jsonl carries it and the SPA can re-render the panel after reload.
        assistantMessage.reasoning = reasoning;
      }
      if (toolCalls.length > 0) {
        assistantMessage.toolCalls = toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.args,
        }));
      }
      // 2026-06-30 plan-tracker bug fix — remove the transient TODO
      // reminder BEFORE the assistant turn is recorded so history (and the
      // persisted jsonl) stays clean. The next round will re-inject a
      // fresh snapshot reflecting any updates the model just made. We
      // splice rather than pop because an abort path above may already
      // have pushed an `[aborted]` assistant message between the reminder
      // and here; pop()-by-position would corrupt history in that case.
      if (todoReminderMessage) {
        const idx = this.messages.indexOf(todoReminderMessage);
        if (idx >= 0) this.messages.splice(idx, 1);
        todoReminderMessage = null;
      }
      this.messages.push(assistantMessage);

      // Defect #1 — surface this round's real token usage (and the fact
      // that an LLM call happened) so the goal runner can sum actual
      // consumption + count assistant turns. Emitted once per `llm.chat()`
      // call regardless of whether the provider reported a `usage` block.
      yield {
        type: "usage",
        ...(usage ? { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens } : {}),
      };

      // TODO-2 §3.2 — mid-turn auto-compact precheck. Opt-in via
      // autoCompact.enableMidTurnPrecheck. Uses the provider-reported
      // promptTokens (truth, not estimate) and accumulates across rounds.
      // Triggers an extra compactV2({ phase: "mid_turn", ... }) when
      // cumulative tally exceeds midTurnThresholdPct * contextWindow.
      // Silent no-op when feature is off OR provider didn't report usage.
      if (this.autoCompactCfg?.enableMidTurnPrecheck && usage) {
        await this.maybeAutoCompactMidTurn({ realPromptTokens: usage.promptTokens });
      }

      if (toolCalls.length === 0) {
        // on-goal-complete hooks — the model finished the user's request this
        // turn. Only fired when such hooks exist (zero-cost otherwise) so a
        // plain chat turn doesn't spawn processes. Non-blocking.
        if (this.hookInvoker && this.hookInvoker.hooksForType("on-goal-complete").length > 0) {
          const done = await this.hookInvoker.run("on-goal-complete", {
            goalText: this.lastUserText(),
          });
          if (done.summary) {
            this.messages.push({ role: "system", content: done.summary });
          }
        }
        yield { type: "done", finishReason };
        return;
      }

      if (round === this.maxToolRounds) {
        // Out of tool budget: emit the calls + a synthetic tool result for
        // each so the conversation history stays well-formed (every assistant
        // tool_call must be paired with a tool message). This way a future
        // `send()` on the same session will not blow up provider validation.
        for (const call of toolCalls) {
          yield { type: "tool-call", id: call.id, name: call.name, args: call.args };
          const message =
            "error: tool-call budget exhausted (maxToolRounds=" + this.maxToolRounds + ")";
          this.messages.push({
            role: "tool",
            content: message,
            toolCallId: call.id,
            name: call.name,
          });
          yield {
            type: "tool-result",
            id: call.id,
            name: call.name,
            ok: false,
            content: message,
          };
        }
        yield { type: "done", finishReason };
        return;
      }

      for (let ci = 0; ci < toolCalls.length; ci++) {
        const call = toolCalls[ci];
        // Abort between tool calls: keep history well-formed by closing every
        // remaining (un-executed) call with a synthetic `[aborted]` tool
        // result, then surface the AbortError to the caller.
        if (signal?.aborted) {
          for (let ri = ci; ri < toolCalls.length; ri++) {
            const pending = toolCalls[ri];
            this.messages.push({
              role: "tool",
              content: "[aborted]",
              toolCallId: pending.id,
              name: pending.name,
            });
          }
          throw abortError();
        }

        yield { type: "tool-call", id: call.id, name: call.name, args: call.args };

        const tool = this.toolByName.get(call.name);
        let result: { ok: boolean; content: string };
        if (!tool) {
          result = { ok: false, content: `error: unknown tool "${call.name}"` };
        } else {
          let parsed: Record<string, unknown> = {};
          let parseFailed = false;
          try {
            parsed = call.args.trim().length > 0 ? JSON.parse(call.args) : {};
          } catch {
            parseFailed = true;
            result = {
              ok: false,
              content: `error: invalid JSON arguments for tool "${call.name}": ${call.args}`,
            };
          }
          if (!parseFailed) {
            try {
              const callCtx: ToolExecuteContext = {
                ...this.toolContext,
                toolCallId: call.id,
                ...(this.hookInvoker ? { hooks: this.hookInvoker } : {}),
                recordRead: (p: string) =>
                  this.readPaths.add(
                    path.isAbsolute(p)
                      ? p
                      : path.resolve(this.workspace ?? "", p),
                  ),
                hasRead: (p: string) =>
                  this.readPaths.has(
                    path.isAbsolute(p)
                      ? p
                      : path.resolve(this.workspace ?? "", p),
                  ),
              };
              result = yield* this.executeWithV1Hooks(
                tool,
                call,
                parsed,
                callCtx,
              );
            } catch (err: any) {
              if (isAskUserPending(err)) {
                // v0.16 §11: bail out of the LLM loop so the serve route can
                // persist a `pendingAsk` annotation and end the SSE stream.
                // Before re-throwing we must keep history well-formed: every
                // assistant `tool_call` MUST be paired with a tool message,
                // otherwise the next provider call rejects the conversation.
                // Push a placeholder tool message for this call (the resume
                // endpoint patches its content to the user's reply) AND for
                // any not-yet-executed tool calls in the same batch — closing
                // the batch is the only way to satisfy provider validation
                // when we abort mid-loop.
                this.messages.push({
                  role: "tool",
                  content: ASK_USER_PENDING_PLACEHOLDER,
                  toolCallId: call.id,
                  name: call.name,
                });
                for (let ri = ci + 1; ri < toolCalls.length; ri++) {
                  const pending = toolCalls[ri];
                  this.messages.push({
                    role: "tool",
                    content: "[skipped: prior ask_user pending]",
                    toolCallId: pending.id,
                    name: pending.name,
                  });
                }
                yield {
                  type: "ask_user",
                  id: call.id,
                  name: call.name,
                  question: (err as AskUserPending).question,
                  // v0.19 Codex parity — forward the structured payload
                  // (only if the AskUserPending carried it) so the SPA's
                  // SSE handler can populate askPending.options / default /
                  // timeoutSeconds / allowCustom on the matching tool
                  // bubble. Older serve resolvers that don't pass these
                  // fields stay 100% compatible — the consumer just sees
                  // `undefined` for each absent slot.
                  ...(((err as AskUserPending).options !== undefined)
                    ? { options: (err as AskUserPending).options }
                    : {}),
                  ...(((err as AskUserPending).default !== undefined)
                    ? { default: (err as AskUserPending).default }
                    : {}),
                  ...(((err as AskUserPending).timeoutSeconds !== undefined)
                    ? { timeoutSeconds: (err as AskUserPending).timeoutSeconds }
                    : {}),
                  ...(((err as AskUserPending).allowCustom !== undefined)
                    ? { allowCustom: (err as AskUserPending).allowCustom }
                    : {}),
                };
                throw err;
              }
              if (err instanceof PlanModeBlockedError) {
                // Part B1 — plan-mode hard gate. Surface a uniform `ok: false`
                // tool result so the model keeps reasoning in plan mode
                // without thinking the tool actually ran.
                //
                // The phrasing is LLM-actionable on purpose: it names the
                // tool, names plan mode, and tells the model exactly how
                // to recover (complete_plan to exit, or use read-only
                // investigation tools).
                result = {
                  ok: false,
                  content:
                    `refused in plan mode: '${err.toolName}' is a mutating tool. ` +
                    `Use 'complete_plan' to exit plan mode first, or call ` +
                    `read-only tools (search/read_file/grep/glob) for investigation.`,
                };
              } else {
                result = { ok: false, content: `error: ${err?.message ?? String(err)}` };
              }
            }
          } else {
            result = result!;
          }
        }

        let inlineContent = result.content;
        if (this.toolOutputCap) {
          const capped = await capToolOutput(call.id, result.content, {
            maxInlineBytes: this.toolOutputCap.maxInlineBytes ?? 4096,
            workspace: this.toolOutputCap.workspace ?? null,
            sessionId: this.sessionId,
          });
          inlineContent = capped.inlineContent;
        }

        this.messages.push({
          role: "tool",
          content: inlineContent,
          toolCallId: call.id,
          name: call.name,
        });
        yield {
          type: "tool-result",
          id: call.id,
          name: call.name,
          ok: result.ok,
          content: result.content,
        };

        // 2026-06-25 — file-written side-channel event for write_file /
        // edit_file. Only fires on success. We re-parse the original
        // call args here because `parsed` from the dispatch block is
        // already out of scope. The `path` field is required by both
        // tools' schemas; we re-stat the file to get authoritative bytes.
        if (
          result.ok &&
          (call.name === "write_file" || call.name === "edit_file") &&
          this.workspace
        ) {
          let argPath = "";
          try {
            const argsObj = JSON.parse(call.args || "{}") as Record<string, unknown>;
            if (typeof argsObj.path === "string") argPath = argsObj.path;
          } catch {
            // ignore parse errors; tool already succeeded with these args
          }
          if (argPath) {
            const ev = await this.buildFileWrittenEvent(call.id, argPath);
            if (ev) yield ev;
          }
        }

        // post-tool hooks — fire after every tool call (non-blocking). Their
        // output is injected as a system message so the model sees what the
        // hook did without polluting the tool_call/tool_result pairing.
        if (this.hookInvoker) {
          const post = await this.hookInvoker.run("post-tool", {
            toolName: call.name,
          });
          if (post.summary) {
            this.messages.push({ role: "system", content: post.summary });
          }
        }
      }
      // Loop again so the model can react to the tool results.
    }
  }

  /**
   * Build a `file-written` ChatEvent for a successful write_file / edit_file
   * call. Returns null if the path can't be resolved or stat'd (in which
   * case we silently skip the side-channel event — the tool-result text
   * still tells the model + user what happened).
   *
   * The MIME hint comes from a small extension lookup; the SPA uses it
   * for icon selection and the Download Content-Disposition shape.
   */
  private async buildFileWrittenEvent(
    toolCallId: string,
    argPath: string,
  ): Promise<{
    type: "file-written";
    toolCallId: string;
    path: string;
    relPath: string;
    filename: string;
    bytes: number;
    mime: string;
  } | null> {
    const ws = this.workspace;
    if (!ws) return null;
    const abs = path.isAbsolute(argPath) ? argPath : path.resolve(ws, argPath);
    // Stay inside workspace — never emit a chip for a path the model
    // somehow wrote outside it. (write_file already has its own escape
    // check, but defence in depth.)
    const rel = path.relative(ws, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    let bytes = 0;
    try {
      const st = await fs.stat(abs);
      bytes = st.size;
    } catch {
      return null;
    }
    const filename = path.basename(abs);
    const ext = path.extname(filename).toLowerCase();
    const mime =
      ext === ".md" ? "text/markdown"
      : ext === ".txt" ? "text/plain"
      : ext === ".json" ? "application/json"
      : ext === ".pdf" ? "application/pdf"
      : ext === ".tex" ? "application/x-tex"
      : ext === ".csv" ? "text/csv"
      : ext === ".html" ? "text/html"
      : ext === ".xml" ? "application/xml"
      : ext === ".yaml" || ext === ".yml" ? "application/x-yaml"
      : ext === ".toml" ? "application/toml"
      : ext === ".py" ? "text/x-python"
      : ext === ".ts" || ext === ".tsx" ? "application/typescript"
      : ext === ".js" || ext === ".jsx" ? "application/javascript"
      : ext === ".bib" ? "application/x-bibtex"
      : ext === ".lean" ? "text/plain"
      : "application/octet-stream";
    return {
      type: "file-written",
      toolCallId,
      path: abs,
      relPath: rel,
      filename,
      bytes,
      mime,
    };
  }
}
