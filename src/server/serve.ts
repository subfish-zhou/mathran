/**
 * `mathran serve` — local-only HTTP backend (Hono + @hono/node-server).
 *
 * PRD §3a: a workstation server that binds **127.0.0.1 only** (never 0.0.0.0)
 * and exposes:
 *   - a REST surface for project / wiki / provider management (JSON), and
 *   - an SSE endpoint that streams the shared `ChatSession` kernel.
 *
 * This module is backend + static-hosting mount point only; the SPA frontend
 * is produced by the sibling `d2-serve-frontend` task and dropped into
 * `dist/web/`. When that build is absent we serve a small placeholder page.
 *
 * Security red lines:
 *   - API keys are NEVER returned in plaintext (`/api/providers`, `/api/config`
 *     report only `set` / `missing`).
 *   - The listen address is hard-pinned to 127.0.0.1 unless an explicit host is
 *     passed, and the default IS 127.0.0.1.
 */

import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  embeddedAssetCount,
  makeEmbeddedAssetHandler,
} from "./static-assets.js";
import { registerUploadRoutes } from "./upload-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerSlashRoutes } from "./slash-routes.js";
import {
  buildUserMessageWithAttachments,
  BadAttachmentError,
  type AttachmentRef,
} from "./chat-attachments.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import YAML from "yaml";
import { createTwoFilesPatch } from "diff";

import { resolveWorkspaceRoot, initProject } from "../cli/commands/project.js";
import { registerInitProjectRoutes } from "./init-project-routes.js";
import { resolveScopeRoot } from "../cli/commands/scope-paths.js";
import { loadConfig } from "../core/config.js";
import {
  BUILTIN_EFFORT_TYPES,
  EFFORT_STATUSES,
  VALID_TRANSITIONS,
  isBuiltinEffortType,
  isEffortStatus,
} from "../core/effort/types.js";
import {
  initEffort,
  listEfforts,
  readEffortMetadata,
  updateEffortMetadata,
  readEffortDocument,
  writeEffortDocument,
  listEffortFiles,
  readEffortFile,
  writeEffortFile,
  snapshotEffort,
  listSnapshots,
  transitionEffortStatus,
  addRelation,
  listAllRelations,
  listEffortRelations,
  listEffortDependents,
  removeRelation,
  VALID_RELATION_TYPES,
  type RelationType,
} from "../core/effort/store.js";
import {
  ChatSession,
  createLeanCheckTool,
  AskUserPending,
  isAskUserPending,
  ASK_USER_PENDING_PLACEHOLDER,
  ASK_USER_GOAL_AUTO_REPLY,
  createTodoWriteTool,
  loadTodos,
  ApprovalBroker,
  type ChatEvent,
} from "../core/chat/index.js";
import {
  resolveApprovalConfig,
  historyFor,
} from "../core/approval/index.js";
import {
  ApprovalRegistry,
  sharedApprovalRegistry,
  registerApprovalRoute,
} from "./approval-routes.js";
import {
  SubagentScheduler,
  defaultSubagentRegistry,
  globalBackgroundRegistry,
} from "../core/subagent/index.js";
import { getGlobalMcpRegistry } from "../core/mcp/registry.js";
import { registerMcpConfigRoutes } from "./mcp-config-routes.js";
import {
  resolveProfile,
  readSettingsDefaultProfile,
  UnknownProfileError,
  type ProfileEffects,
} from "../core/profiles/index.js";
import {
  createOpenAITokenCounter,
  createAnthropicTokenCounter,
  createFallbackTokenCounter,
  type TokenCounter,
} from "../core/chat/token-counter.js";
import { contextWindowForModel } from "../providers/llm/copilot-models-cache.js";
import type { LLMMessage, MessageContent } from "../core/providers/llm.js";
import {
  ScopedChatSessionStore,
  type ChatScope,
  type ScopedChatSessionFactory,
  loadAnnotations,
  saveAnnotations,
  pruneAnnotationsFrom,
  loadConversationHistory,
  type MessageAnnotation,
  type ConversationUiState,
  type ConversationAnnotations,
  type PendingAskAnnotation,
} from "../core/chat/store.js";
import {
  clearGoalAbortRequest,
  createGoal,
  endGoal,
  listGoals,
  readGoal,
  requestGoalAbort,
  writeGoal,
  type Goal,
} from "../core/goal/store.js";
import { runGoalRound, runOneIteration, type RunRoundResult } from "../core/goal/runner.js";
import { computeCostUsd } from "../providers/llm/model-pricing.js";
import {
  GoalDaemon,
  GoalTurnRunner,
  type DaemonEvent,
  type DaemonIterationResult,
  type GoalDaemonOptions,
  type IterationFn,
} from "../core/goal/daemon.js";
import {
  DEFAULT_GOAL_AUTONOMY,
  deleteGoalAutonomyLayer,
  loadGoalAutonomy,
  saveGoalAutonomy,
  validateGoalAutonomyPatch,
  type GoalAutonomyLayer,
} from "../core/config/goal-autonomy.js";
import {
  readGoalPlan,
  parsePlanSteps,
  goalPlanRelPath,
} from "../core/goal/plan.js";
import { PlanStore, type Plan } from "../core/plan/store.js";
import { runPlan } from "../core/plan/runner.js";
import type { LLMProvider } from "../core/providers/llm.js";
import { randomUUID } from "node:crypto";
import {
  ModelRouter,
  LocalLeanProvider,
  resolveApiKey,
} from "../providers/index.js";
import {
  consumePendingSteer,
  hasActiveStream,
  markStreamActive,
  setPendingSteer,
} from "./steer-registry.js";
import {
  subscribeOutcomeGraded,
  type OutcomeGradedEvent,
} from "../core/outcomes/events.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7878;
const DEFAULT_MODEL = "copilot/gpt-5.5";

import { buildBaseSystemPrompt } from "../core/prompts/index.js";

const SYSTEM_PROMPT = buildBaseSystemPrompt();

// ---------------------------------------------------------------------------
// v0.19 Codex parity — ask_user server-side timeout registry.
//
// When the model emits `ask_user({ timeoutSeconds })`, the chat round
// handler persists a `pendingAsk` annotation with a `timeoutAt` deadline
// and schedules a setTimeout via `scheduleAskTimeout`. If the user POSTs
// /answer-ask before the timer fires, `cancelAskTimeout(callId)` clears
// the pending timer so we don't double-resolve.
//
// On fire, the timer (registered via `scheduleAskTimeout`) reloads the
// sidecar, confirms the slot still points at the same callId (race
// guard: the user may have answered between fire and tick), patches the
// placeholder tool message to `default` (or the canned fallback when
// `default` was omitted), clears the slot, and drains a `session.resume()`
// so the next round runs. No SSE stream exists at this point — the next
// time the SPA refetches the conversation it sees the new tail; live
// tabs subscribed to a SSE notifier (out of scope here) would need a
// separate notification path.
//
// Keyed by callId since it's globally unique per pending ask. Storing
// the NodeJS.Timeout lets us clear it cleanly; the resolver itself is
// closure-bound to (scope, conversationId, callId, default).
const askTimeoutRegistry = new Map<string, NodeJS.Timeout>();

/**
 * Phase ζ (cost meter) — dollar cost of a goal's lifetime LLM usage.
 *
 * Prefers the exact provider-reported input/output split
 * (`stats.inputTokensUsed` / `stats.outputTokensUsed`, Phase ζ Option A).
 * When that split is unavailable but a combined `tokensUsed` exists — i.e.
 * pre-Phase-ζ goals on disk, or iterations where the provider reported no
 * usage and we fell back to `countTokens` — we APPROXIMATE the split with a
 * 30% input / 70% output heuristic (Option B). The ratio varies (50/50 to
 * 90/10 depending on tool-call density); the approximated figure is a rough
 * indicator only. Returns `null` for unpriced/unknown models so the UI shows
 * "—" rather than a fake $0.00. DESIGN-REFERENCE.md §5.E.
 */
function computeGoalCostUsd(g: Goal): number | null {
  const inSplit = g.stats.inputTokensUsed ?? 0;
  const outSplit = g.stats.outputTokensUsed ?? 0;
  if (inSplit > 0 || outSplit > 0) {
    return computeCostUsd(g.model, inSplit, outSplit);
  }
  const total = g.stats.tokensUsed ?? 0;
  if (total > 0) {
    // Option B fallback: approximate 30% input / 70% output.
    return computeCostUsd(g.model, total * 0.3, total * 0.7);
  }
  return computeCostUsd(g.model, 0, 0);
}

/** Escape a Prometheus label value per the text exposition spec
 *  (backslash, double-quote, newline). Phase ζ — used for the `model`
 *  label on mathran_cost_usd_total. */
function promLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function cancelAskTimeout(callId: string): void {
  const t = askTimeoutRegistry.get(callId);
  if (t !== undefined) {
    clearTimeout(t);
    askTimeoutRegistry.delete(callId);
  }
}

function scheduleAskTimeout(
  callId: string,
  delayMs: number,
  onFire: () => Promise<void>,
): void {
  // Reschedule wipes any prior timer for the same callId so a resume
  // that immediately re-pauses on the same id can't leak handles.
  cancelAskTimeout(callId);
  const timer = setTimeout(() => {
    askTimeoutRegistry.delete(callId);
    // Run the resolver in its own microtask so an exception inside it
    // can't take down the libuv timer thread; we log + swallow.
    Promise.resolve(onFire()).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[mathran] ask_user timeout resolver failed for ${callId}:`,
        err,
      );
    });
  }, delayMs);
  // Keep the registry from holding the process alive past natural exit —
  // a forgotten pending ask shouldn't pin the server up.
  if (typeof timer.unref === "function") timer.unref();
  askTimeoutRegistry.set(callId, timer);
}

/**
 * Build the auto-resolver fn the timer fires. Exposed (closure factory)
 * so the call sites that persist `pendingAsk` can wire scope + store +
 * conversationId without us importing the chat scope type here.
 */
function makeAskTimeoutResolver(args: {
  store: ScopedChatSessionStore;
  scope: ChatScope;
  conversationId: string;
  callId: string;
  fallback: string;
}): () => Promise<void> {
  const { store, scope, conversationId, callId, fallback } = args;
  return async () => {
    // Reload the sidecar fresh — the user may have answered in the
    // interim (we clear the timer in that path but a microtask race is
    // theoretically possible).
    let sidecar: ConversationAnnotations;
    try {
      sidecar = await loadAnnotations(store.getWorkspace(), scope, conversationId);
    } catch {
      return;
    }
    const pending = sidecar.pendingAsk;
    if (!pending || pending.callId !== callId) {
      // Already answered, truncated, or replaced. Nothing to do.
      return;
    }
    // Patch the placeholder — same logic as the /answer-ask handler.
    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, conversationId, undefined);
    } catch {
      return;
    }
    const history = session.history();
    let patched = false;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (
        msg.role === "tool" &&
        msg.toolCallId === pending.callId &&
        msg.content === ASK_USER_PENDING_PLACEHOLDER
      ) {
        history[i] = { ...msg, content: fallback };
        patched = true;
        break;
      }
    }
    if (!patched) {
      // History rewound under us — drop the slot and bail.
      const cleared: ConversationAnnotations = { ...sidecar };
      delete (cleared as { pendingAsk?: unknown }).pendingAsk;
      try {
        await saveAnnotations(store.getWorkspace(), scope, conversationId, cleared);
      } catch {
        /* best-effort */
      }
      return;
    }
    session.replaceHistory(history);
    // Clear the slot BEFORE resuming so a fresh ask_user inside the
    // resumed round can persist its own pendingAsk on top.
    const cleared: ConversationAnnotations = { ...sidecar };
    delete (cleared as { pendingAsk?: unknown }).pendingAsk;
    try {
      await saveAnnotations(store.getWorkspace(), scope, conversationId, cleared);
    } catch {
      /* best-effort */
    }
    // Drain the resume — no SSE consumer; we just want the model to
    // continue. If it pauses on another ask_user, the catch in resume's
    // own handler chain isn't wired here; we just let the error bubble
    // and let the next /answer-ask or refetch see the new history tail.
    try {
      for await (const _ev of session.resume() as AsyncIterable<ChatEvent>) {
        void _ev;
      }
      await store.flush(scope, conversationId);
    } catch (err) {
      // If resume itself paused on a new ask_user, the inner session.send
      // already pushed the placeholder + sidecar fields we need. Just
      // flush and exit — the new pendingAsk will already have been
      // persisted by ChatSession.send's own catch path (after this
      // commit's serve catch wiring — see the makePendingAskRecord
      // call sites). We DO check whether it was AskUserPending so an
      // unrelated thrown error gets logged.
      if (!isAskUserPending(err)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[mathran] resume after ask_user timeout failed for ${conversationId}:`,
          err,
        );
      } else {
        // Persist the nested pendingAsk — normally serve's catch chain
        // handles this, but timer-driven resume runs outside any HTTP
        // request so we do it here ourselves.
        try {
          const next = await loadAnnotations(
            store.getWorkspace(),
            scope,
            conversationId,
          );
          await saveAnnotations(store.getWorkspace(), scope, conversationId, {
            ...next,
            pendingAsk: makePendingAskRecord(err as AskUserPending),
          });
          const nestedTimeout = (err as AskUserPending).timeoutSeconds;
          if (typeof nestedTimeout === "number" && nestedTimeout >= 1) {
            scheduleAskTimeout(
              (err as AskUserPending).callId,
              nestedTimeout * 1000,
              makeAskTimeoutResolver({
                store,
                scope,
                conversationId,
                callId: (err as AskUserPending).callId,
                fallback:
                  (err as AskUserPending).default ?? fallback,
              }),
            );
          }
        } catch {
          /* best-effort */
        }
      }
      try {
        await store.flush(scope, conversationId);
      } catch {
        /* best-effort */
      }
    }
  };
}

/**
 * Build the serializable `pendingAsk` record we persist on the
 * conversation sidecar, copying every structured Codex-parity field
 * that's actually set on the AskUserPending. Single source of truth for
 * the three call sites that need to record a fresh pending ask
 * (initial POST chat, rerun, nested resume).
 */
function makePendingAskRecord(err: AskUserPending): PendingAskAnnotation {
  const record: PendingAskAnnotation = {
    question: err.question,
    callId: err.callId,
    toolCallId: err.callId,
    ts: Date.now(),
  };
  if (err.options !== undefined) record.options = err.options;
  if (err.default !== undefined) record.default = err.default;
  if (err.timeoutSeconds !== undefined) {
    record.timeoutSeconds = err.timeoutSeconds;
    // Record the absolute deadline so the SPA can render a countdown
    // without knowing when the question was posed; the SPA receives
    // both `ts` and `timeoutAt` and uses whichever it prefers.
    record.timeoutAt = record.ts + err.timeoutSeconds * 1000;
  }
  if (err.allowCustom !== undefined) record.allowCustom = err.allowCustom;
  return record;
}

/**
 * Orphan-pendingAsk cancellation (TODO-3).
 *
 * Symptom we're fixing: a chat round emits an `ask_user` tool call; the
 * SPA persists a `pendingAsk` annotation + a placeholder tool message in
 * history (see {@link ASK_USER_PENDING_PLACEHOLDER}); the user navigates
 * away or just sends a new chat message instead of answering. Without
 * intervention, the placeholder + sidecar slot live forever, the next
 * `session.send` sees a tool-result placeholder it never wrote and the
 * conversation gets stuck or the model gets confused.
 *
 * Fix: when the user sends a new message (or rerun, or any other entry
 * that's NOT /answer-ask), patch the placeholder tool message with a
 * structured cancellation result so the model knows the prior ask was
 * superseded, then clear the sidecar slot + cancel any pending timeout.
 *
 * Idempotent: returns false ("nothing to do") when there's no
 * pendingAsk, or when the placeholder is already gone from history
 * (which happens if the round was truncated under us). All failures are
 * best-effort — a chat send must not 500 because a cleanup couldn't
 * write a sidecar file.
 *
 * Returns true when at least one of {history patch, sidecar clear,
 * timer cancel} succeeded.
 *
 * Exported so server-route tests can verify the cleanup contract
 * without standing up a real LLM provider.
 */
export async function cancelOrphanPendingAsk(args: {
  store: ScopedChatSessionStore;
  scope: ChatScope;
  conversationId: string;
  session: ChatSession;
  reason: string;
}): Promise<boolean> {
  const { store, scope, conversationId, session, reason } = args;
  let sidecar: ConversationAnnotations;
  try {
    sidecar = await loadAnnotations(store.getWorkspace(), scope, conversationId);
  } catch {
    return false;
  }
  const pending = sidecar.pendingAsk;
  if (!pending) return false;

  // Build the structured cancellation payload. Use JSON so the model
  // can pattern-match on `cancelled:true` reliably (the placeholder is
  // a plain marker string; a free-text reason would confuse the model
  // into thinking it was the user's actual answer).
  const cancellationContent = JSON.stringify({
    cancelled: true,
    reason,
    callId: pending.callId,
    cancelledAt: new Date().toISOString(),
  });

  // Patch the placeholder tool message in the session's live history.
  // Match on toolCallId (the only race-free key — see /answer-ask).
  const history = session.history();
  let patched = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (
      msg.role === "tool" &&
      msg.toolCallId === pending.callId &&
      msg.content === ASK_USER_PENDING_PLACEHOLDER
    ) {
      history[i] = { ...msg, content: cancellationContent };
      patched = true;
      break;
    }
  }
  if (patched) session.replaceHistory(history);

  // Clear the sidecar slot whether or not we patched — a missing
  // placeholder means the round was rewound, but the dangling sidecar
  // would still confuse the SPA's pending-ask UI.
  const cleared: ConversationAnnotations = { ...sidecar };
  delete (cleared as { pendingAsk?: unknown }).pendingAsk;
  try {
    await saveAnnotations(store.getWorkspace(), scope, conversationId, cleared);
  } catch {
    /* best-effort */
  }

  // Cancel any pending auto-resolve timer so it doesn't fire after we
  // already wrote a cancellation tool-result.
  cancelAskTimeout(pending.callId);

  // Best-effort log so operators can grep for orphan cancellations when
  // debugging a stuck conversation.
  // eslint-disable-next-line no-console
  console.warn(
    `[mathran] cancelled orphan pendingAsk for ${conversationId} ` +
      `(callId=${pending.callId}, patched=${patched}, reason="${reason}")`,
  );
  return true;
}


/**
 * outcomes 收尾 C-2 — subscribe an active SSE stream to background `goal-graded`
 * notifications and multicast each as a `goal-graded` frame. Self-grade runs
 * fire-and-forget after the goal's own stream closes, so this lets whatever
 * stream is open when grading lands relay the result. The SPA filters on
 * `goalId`. Returns the unsubscribe fn the caller MUST call in its `finally`.
 *
 * Writes are fire-and-forget: the sync emitter callback can't await, and a
 * dead/closing stream's rejected write is swallowed so it can't crash the
 * publisher or leak an unhandled rejection.
 */
function pipeGoalGradedFrames(stream: {
  writeSSE: (m: { event: string; data: string }) => Promise<void>;
}): () => void {
  return subscribeOutcomeGraded((ev: OutcomeGradedEvent) => {
    void stream
      .writeSSE({
        event: "goal-graded",
        data: JSON.stringify({
          type: "goal-graded",
          goalId: ev.goalId,
          outcome: ev.outcome,
        }),
      })
      .catch(() => {
        /* stream already closed — nothing to do */
      });
  });
}

/**
 * Background Agents (#3) — subscribe an active SSE stream to background
 * `subagent-completed` notifications and multicast each (scoped to this
 * conversation) as a `subagent-completed` frame. Background subagents settle
 * after their dispatch tool call already returned, so this relays the terminal
 * result to whatever stream is open. Returns the unsubscribe fn the caller
 * MUST call in its `finally`.
 *
 * Writes are fire-and-forget: a dead/closing stream's rejected write is
 * swallowed so it can't crash the publisher or leak an unhandled rejection.
 */
function pipeSubagentCompletedFrames(
  stream: { writeSSE: (m: { event: string; data: string }) => Promise<void> },
  conversationId: string,
): () => void {
  return globalBackgroundRegistry().onCompleted((ev) => {
    if (ev.parentConversationId !== conversationId) return;
    const result = ev.result;
    void stream
      .writeSSE({
        event: "subagent-completed",
        data: JSON.stringify({
          type: "subagent-completed",
          subagentId: ev.subagentId,
          status: ev.status,
          durationMs: ev.durationMs,
          ...(result
            ? {
                result: {
                  status: result.status,
                  summary: result.summary,
                  artifactPath: result.artifactPath,
                  durationMs: result.stats?.durationMs,
                },
              }
            : {}),
        }),
      })
      .catch(() => {
        /* stream already closed — nothing to do */
      });
  });
}

/**
 * Factory the chat endpoints use to build a session.
 *
 * `scope` lets handlers thread the parent context (global / project / effort)
 * through to the kernel — T1-D will hook this into tool ctx (BUG #7 fix).
 * Injectable for tests; default factory ignores scope for now.
 */
export type ChatSessionFactory = (opts: {
  model?: string;
  scope?: ChatScope;
  /** v0.17 W12 — conversation id so per-conversation tools (e.g.
   *  `todo_write`) can persist to a file keyed by it. Optional for
   *  back-compat with existing tests; the default factory wires the
   *  TODO tool only when present. */
  conversationId?: string;
  /**
   * v0.17 follow-up P2 — fire-and-forget background goal kickoff after
   * `propose_goal` confirmation. The serve host owns `runGoalRound` +
   * deps (LLM, scheduler, lean, inflightGoals) inside its closure and
   * passes this lambda so the tool can trigger a goal run without
   * pulling those deps through five interfaces. Optional: when omitted
   * the propose_goal tool ships in seed-only mode and the user must
   * click "Run" in the goal panel manually.
   */
  autoRunGoal?: (goalId: string, userMessage: string) => void;
  /**
   * v0.17 P2 — see ScopedChatSessionFactory.autoRunPlan. Forwarded to
   * the `propose_plan` builtin tool by the default factory.
   */
  autoRunPlan?: (planId: string, objective: string) => void;
}) => ChatSession;

/**
 * Factory the goal-run endpoint uses to build the LLM provider for a round.
 * Injectable for tests so an in-flight round can be driven by a controllable
 * (e.g. slow) provider; the default wires a `ModelRouter` from config.
 */
export type GoalLLMFactory = (opts: { model?: string }) => LLMProvider;

export interface StartServerOptions {
  host?: string;
  port?: number;
  workspace?: string;
  /**
   * Test seam: override how a `ChatSession` is built per chat request. When
   * omitted the server wires a `ModelRouter` from `<workspace>/config.toml`.
   */
  chatSessionFactory?: ChatSessionFactory;
  /**
   * Test seam: override the LLM provider used to drive goal rounds. When
   * omitted the server wires a `ModelRouter` from `<workspace>/config.toml`.
   */
  goalLlmFactory?: GoalLLMFactory;
  /**
   * Permission profile name applied to EVERY chat session this server creates
   * (C-1). Falls back to `settings.json#profile` when omitted. Unknown profile
   * names are logged and ignored (no profile applied), matching
   * `mathran chat --profile` behaviour.
   */
  profile?: string;
}

export interface RunningServer {
  close(): Promise<void>;
  url: string;
  host: string;
  port: number;
  workspace: string;
  /** Active permission profile name (when one resolved successfully). */
  profile?: string;
}

// ─── Small fs / parsing helpers ──────────────────────────────────────────────

function repoRoot(): string {
  // src/server/serve.ts (or dist/server/serve.js) → repo root is two levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(repoRoot(), "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
}

/** Split a markdown document into its YAML front-matter and body. */
function parseFrontMatter(raw: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { data: {}, body: raw };
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(match[1]);
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { data, body: raw.slice(match[0].length) };
}

const PROJECTS_DIR = "projects";
const WIKI_DIR = "wiki";
const WIKI_HISTORY_DIR = ".history";

/**
 * Wiki frontmatter shape (canonical). Backward compatible with the legacy
 * `LocalFsArtifactSink` frontmatter (id/slug/title/authorId/createdAt/updatedAt).
 *
 * Extra v0.1.0 fields:
 *   parent?: string     — slug of parent page (for tree-style navigation)
 *   sortOrder?: number  — stable display order within parent
 *   version: number     — monotonically increasing, starts at 1
 */
interface WikiFrontmatter {
  id?: string;
  title?: string;
  slug?: string;
  authorId?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  parent?: string;
  sortOrder?: number;
  version?: number;
}

/** Serialize a frontmatter object to YAML between `---` fences. */
function stringifyFrontmatter(fm: WikiFrontmatter): string {
  const lines: string[] = ["---"];
  if (fm.id !== undefined) lines.push(`id: ${fm.id}`);
  if (fm.title !== undefined) lines.push(`title: ${JSON.stringify(fm.title)}`);
  if (fm.slug !== undefined) lines.push(`slug: ${fm.slug}`);
  if (fm.parent !== undefined) lines.push(`parent: ${fm.parent}`);
  if (fm.sortOrder !== undefined) lines.push(`sortOrder: ${fm.sortOrder}`);
  if (fm.authorId !== undefined) lines.push(`authorId: ${fm.authorId}`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  }
  if (fm.createdAt !== undefined) lines.push(`createdAt: ${fm.createdAt}`);
  if (fm.updatedAt !== undefined) lines.push(`updatedAt: ${fm.updatedAt}`);
  if (fm.version !== undefined) lines.push(`version: ${fm.version}`);
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Slug allow-list. Project slugs and wiki page slugs are restricted to
 * lowercase alphanumerics + `-`/`_`/`.` so a malicious caller cannot smuggle
 * `..` segments or path separators through `/api/projects/:slug/wiki/:page`.
 *
 * `path.join` does NOT prevent traversal when the caller controls one of the
 * inputs; we must validate before joining.
 */
const SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const MAX_SLUG_LENGTH = 128;

function isSafeSlug(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SLUG_LENGTH &&
    SAFE_SLUG_PATTERN.test(value)
  );
}

function projectDirFor(workspace: string, slug: string): string {
  return path.join(workspace, PROJECTS_DIR, slug);
}

// ─── REST handlers (workspace-bound) ─────────────────────────────────────────

async function listProjects(workspace: string): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(workspace, PROJECTS_DIR);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    const meta: Record<string, unknown> = { slug };
    try {
      const toml = parseToml(await fs.readFile(path.join(dir, slug, "project.toml"), "utf-8")) as any;
      const project = toml?.project ?? {};
      meta.name = project.name ?? slug;
      if (project.created_at !== undefined) meta.created_at = project.created_at;
      if (project.mathran_version !== undefined) meta.mathran_version = project.mathran_version;
    } catch {
      meta.name = slug;
    }
    out.push(meta);
  }
  out.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return out;
}

async function readProject(workspace: string, slug: string): Promise<Record<string, unknown> | null> {
  const projectDir = projectDirFor(workspace, slug);
  if (!(await pathExists(projectDir))) return null;
  let project: Record<string, unknown> = {};
  try {
    const toml = parseToml(await fs.readFile(path.join(projectDir, "project.toml"), "utf-8")) as any;
    project = toml ?? {};
  } catch {
    project = {};
  }
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(projectDir, { withFileTypes: true });
    entries = dirents
      .filter((d) => !d.name.startsWith("."))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort();
  } catch {
    entries = [];
  }
  return { slug, project, entries };
}

async function listWiki(workspace: string, slug: string): Promise<Array<Record<string, unknown>> | null> {
  const projectDir = projectDirFor(workspace, slug);
  if (!(await pathExists(projectDir))) return null;
  const wikiDir = path.join(projectDir, WIKI_DIR);
  let files: string[];
  try {
    files = (await fs.readdir(wikiDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const pages: Array<Record<string, unknown>> = [];
  for (const file of files.sort()) {
    const page = file.replace(/\.md$/, "");
    let data: WikiFrontmatter = {};
    try {
      const fm = parseFrontMatter(await fs.readFile(path.join(wikiDir, file), "utf-8"));
      data = fm.data as WikiFrontmatter;
    } catch {
      data = {};
    }
    pages.push({
      page,
      title: data.title ?? page,
      tags: data.tags ?? [],
      // v0.1.0: surface tree + version metadata so the UI can render a sidebar tree.
      ...(data.parent !== undefined ? { parent: data.parent } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      version: data.version ?? 1,
      ...(data.createdAt !== undefined ? { created_at: data.createdAt } : {}),
      ...(data.updatedAt !== undefined ? { updated_at: data.updatedAt } : {}),
    });
  }
  // Stable order: sortOrder if present, then slug.
  pages.sort((a, b) => {
    const sa = typeof a.sortOrder === "number" ? a.sortOrder : 0;
    const sb = typeof b.sortOrder === "number" ? b.sortOrder : 0;
    if (sa !== sb) return sa - sb;
    return String(a.page).localeCompare(String(b.page));
  });
  return pages;
}

async function readWikiPage(
  workspace: string,
  slug: string,
  page: string,
): Promise<Record<string, unknown> | null> {
  const file = path.join(projectDirFor(workspace, slug), WIKI_DIR, `${page}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  const fm = parseFrontMatter(raw);
  const data = fm.data as WikiFrontmatter;
  return {
    page,
    frontmatter: data,
    body: fm.body,
    raw,
    version: data.version ?? 1,
  };
}

/** Write a wiki page; v0.1.0 adds versioning + parent/sortOrder, keeps history on disk. */
async function writeWikiPage(
  workspace: string,
  slug: string,
  page: string,
  body: string,
  opts: { parent?: string; sortOrder?: number; title?: string } = {},
): Promise<Record<string, unknown>> {
  const projectDir = projectDirFor(workspace, slug);
  const wikiDir = path.join(projectDir, WIKI_DIR);
  await fs.mkdir(wikiDir, { recursive: true });
  const file = path.join(wikiDir, `${page}.md`);

  // Snapshot existing version (if any) into `.history/<page>/v<N>.md`.
  let existingFm: WikiFrontmatter = {};
  let existingRaw: string | null = null;
  try {
    existingRaw = await fs.readFile(file, "utf-8");
    existingFm = parseFrontMatter(existingRaw).data as WikiFrontmatter;
  } catch {
    /* page is new — nothing to snapshot. */
  }
  const oldVersion = existingFm.version ?? (existingRaw ? 1 : 0);
  if (existingRaw && oldVersion > 0) {
    const histDir = path.join(wikiDir, WIKI_HISTORY_DIR, page);
    await fs.mkdir(histDir, { recursive: true });
    await fs.writeFile(path.join(histDir, `v${oldVersion}.md`), existingRaw, "utf-8");
  }

  const now = new Date().toISOString();
  const next: WikiFrontmatter = {
    // Preserve id / createdAt / authorId across writes.
    id: existingFm.id ?? randomUUID(),
    title: opts.title ?? existingFm.title ?? page,
    slug: page,
    parent: opts.parent ?? existingFm.parent,
    sortOrder: opts.sortOrder ?? existingFm.sortOrder,
    authorId: existingFm.authorId ?? "user",
    tags: existingFm.tags ?? ["wiki"],
    createdAt: existingFm.createdAt ?? now,
    updatedAt: now,
    version: oldVersion + 1,
  };
  await fs.writeFile(file, stringifyFrontmatter(next) + body, "utf-8");
  const result = await readWikiPage(workspace, slug, page);
  return result ?? { page, body };
}

/** List all historical versions of a wiki page. */
async function listWikiHistory(
  workspace: string,
  slug: string,
  page: string,
): Promise<Array<Record<string, unknown>> | null> {
  const histDir = path.join(projectDirFor(workspace, slug), WIKI_DIR, WIKI_HISTORY_DIR, page);
  let files: string[];
  try {
    files = (await fs.readdir(histDir)).filter((f) => /^v\d+\.md$/.test(f));
  } catch {
    return [];
  }
  const versions: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const m = /^v(\d+)\.md$/.exec(file);
    if (!m) continue;
    const version = Number(m[1]);
    try {
      const fm = parseFrontMatter(await fs.readFile(path.join(histDir, file), "utf-8"));
      const data = fm.data as WikiFrontmatter;
      versions.push({
        version,
        updated_at: data.updatedAt ?? null,
        title: data.title ?? page,
      });
    } catch {
      versions.push({ version, updated_at: null });
    }
  }
  versions.sort((a, b) => (b.version as number) - (a.version as number));
  return versions;
}

/** Read a specific historical version of a wiki page. */
async function readWikiPageVersion(
  workspace: string,
  slug: string,
  page: string,
  version: number,
): Promise<Record<string, unknown> | null> {
  const file = path.join(
    projectDirFor(workspace, slug),
    WIKI_DIR,
    WIKI_HISTORY_DIR,
    page,
    `v${version}.md`,
  );
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  const fm = parseFrontMatter(raw);
  return {
    page,
    version,
    frontmatter: fm.data,
    body: fm.body,
    raw,
  };
}

/**
 * Read the body of one wiki version. `version` is either a positive integer
 * (read from `.history/<page>/v<N>.md`) or the string "current" (read the
 * live page file). Returns `null` when the version does not exist.
 *
 * Used by the wiki diff endpoint (GAP #10).
 */
async function readWikiVersionBody(
  workspace: string,
  slug: string,
  page: string,
  version: number | "current",
): Promise<{ version: number | "current"; body: string; label: string } | null> {
  if (version === "current") {
    const current = await readWikiPage(workspace, slug, page);
    if (!current) return null;
    const liveVersion = (current.version as number | undefined) ?? 1;
    return { version: "current", body: String(current.body ?? ""), label: `current (v${liveVersion})` };
  }
  const past = await readWikiPageVersion(workspace, slug, page, version);
  if (!past) return null;
  return { version, body: String(past.body ?? ""), label: `v${version}` };
}

// ─── Provider / config handlers (key-masked) ─────────────────────────────────

function configPathFor(workspace: string): string {
  return path.join(workspace, "config.toml");
}

function maskProviders(workspace: string): Record<string, unknown> {
  const config = loadConfig(configPathFor(workspace));
  const providers: Record<string, unknown> = {};
  for (const [key, cfg] of Object.entries(config.providers)) {
    providers[key] = {
      kind: cfg.kind,
      model: cfg.defaultModel ?? null,
      baseUrl: cfg.baseUrl ?? null,
      endpoint: cfg.endpoint ?? null,
      deployment: cfg.deployment ?? null,
      apiVersion: cfg.apiVersion ?? null,
      // NEVER return the raw key — only whether one is resolvable.
      key: resolveApiKey(cfg) ? "set" : "missing",
    };
  }
  return { providers, defaultModel: config.defaultModel ?? null };
}

function safeConfig(workspace: string): Record<string, unknown> {
  const config = loadConfig(configPathFor(workspace));
  const providers: Record<string, unknown> = {};
  for (const [key, cfg] of Object.entries(config.providers)) {
    providers[key] = { kind: cfg.kind, model: cfg.defaultModel ?? null };
  }
  return { defaultModel: config.defaultModel ?? null, providers };
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "azure",
  "copilot",
  "ollama",
]);

const PROVIDER_FIELDS = [
  "kind",
  "apiKey",
  "baseUrl",
  "endpoint",
  "deployment",
  "apiVersion",
  "defaultModel",
] as const;

/**
 * Merge user-submitted provider fields into config.toml, preserving every other
 * section and any provider fields the caller did not send.
 */
async function writeProviders(workspace: string, payload: any): Promise<Record<string, unknown>> {
  const cfgPath = configPathFor(workspace);
  let raw: any = {};
  try {
    raw = parseToml(await fs.readFile(cfgPath, "utf-8")) as any;
  } catch {
    raw = {};
  }
  if (!raw || typeof raw !== "object") raw = {};
  if (!raw.providers || typeof raw.providers !== "object") raw.providers = {};

  const submitted = payload?.providers;
  if (submitted && typeof submitted === "object") {
    for (const [key, value] of Object.entries(submitted)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      if (v.kind !== undefined && !VALID_KINDS.has(String(v.kind))) {
        throw new Error(`invalid provider kind "${String(v.kind)}" for "${key}"`);
      }
      const existing =
        raw.providers[key] && typeof raw.providers[key] === "object"
          ? raw.providers[key]
          : {};
      const merged: Record<string, unknown> = { ...existing };
      for (const field of PROVIDER_FIELDS) {
        if (v[field] !== undefined) merged[field] = v[field];
      }
      raw.providers[key] = merged;
    }
  }

  if (payload?.defaultModel !== undefined) {
    raw.defaultModel = String(payload.defaultModel);
  }

  await fs.mkdir(path.dirname(cfgPath), { recursive: true });
  await fs.writeFile(cfgPath, stringifyToml(raw) + "\n", "utf-8");
  return maskProviders(workspace);
}

// ─── Chat (SSE) ──────────────────────────────────────────────────────────────

export function defaultSessionFactory(
  workspace: string,
  approvalRegistry: ApprovalRegistry = sharedApprovalRegistry,
  profile?: ProfileEffects,
  mcpRegistry?: { toolSpecs(): import("../core/chat/session.js").ToolSpec[] },
): ChatSessionFactory {
  return ({ model, scope, conversationId, autoRunGoal, autoRunPlan }) => {
    const config = loadConfig(configPathFor(workspace));
    const resolvedModel = model ?? config.defaultModel ?? DEFAULT_MODEL;
    const router = new ModelRouter(config);
    const lean = new LocalLeanProvider();
    // v0.5 §2 / Gap #6: scope-aware workspace + full builtin toolkit for web UI.
    //
    // Scope mapping (matches `mathran chat` / `mathran goal` via
    // `resolveScopeRoot`):
    //   - global               → workspace root
    //   - project:<p>          → <workspace>/projects/<p>
    //   - effort:<p>/<e>       → <workspace>/projects/<p>/efforts/<e>
    //
    // The web UI gets the SAME 6-builtin toolkit as CLI chat/goal
    // (bash/read/write/edit + search/read_file_summary). The v0.11 audit
    // explicitly answered "no, full set" to the "should we limit web tools?"
    // question — `mathran serve` is local-only (127.0.0.1) and is meant to
    // behave like a workspace-attached REPL with a browser UI. Anyone who
    // can reach the loopback socket already has shell access on this
    // machine; there is no auth boundary to add value to a tool-set cut.
    const scopedWorkspace = scope ? resolveScopeRoot(workspace, scope) : workspace;
    // v0.5 wire-up Gap #4 + #5: scoped scheduler with all 5 runners so the
    // web UI's `dispatch_subagent` builtin tool can fan out to research /
    // lean_explore / etc. Mirrors the CLI chat scheduler wiring.
    const scheduler = new SubagentScheduler({
      workspace: scopedWorkspace,
      registry: defaultSubagentRegistry(),
    });
    // Approval Policy 矩阵 — build the broker from the layered config and wire a
    // session-level resolver that parks each prompt in the shared registry. The
    // SSE pump forwards the `approval_request` event to the SPA; the parked
    // Promise resolves when the SPA `POST`s the decision (see approval-routes).
    // No broker-internal resolver in serve mode (the session drives prompts);
    // no rule-proposal resolver either (no second modal — a follow-up).
    const approvalCfg = resolveApprovalConfig({ workspace: scopedWorkspace });
    for (const w of approvalCfg.warnings) {
      // eslint-disable-next-line no-console
      console.warn(`[mathran] ${w}`);
    }
    // Permission profile (C-1): when supplied by `startServer`, the profile
    // overrides the settings policy, adds denylistTools on top of the settings
    // denylist, and supplies autoApprovePatterns to the broker. The profile
    // ALSO threads into ChatSession so the dispatch-level hard reject
    // (readOnlyMode / hardRejectMutations) fires BEFORE the broker is asked.
    const effectivePolicy = profile?.policy ?? approvalCfg.policy;
    const effectiveDenylist = profile
      ? [
          ...approvalCfg.denylist,
          ...profile.denylistTools.map((t) => `${t}:*`),
        ]
      : approvalCfg.denylist;
    const effectiveAutoApprovePatterns = profile?.autoApprovePatterns ?? [];
    const approvalBroker = new ApprovalBroker({
      policy: effectivePolicy,
      workspace: scopedWorkspace,
      learning: approvalCfg.learning,
      proposeAfter: approvalCfg.proposeAfter,
      inlineRules: approvalCfg.inlineRules,
      denylist: effectiveDenylist,
      rulesFiles: approvalCfg.rulesFiles,
      persistentRuleFile: approvalCfg.persistentRuleFile,
      autoApprovePatterns: effectiveAutoApprovePatterns,
      history: historyFor(approvalCfg),
    });
    const approvalResolver = conversationId
      ? (request: Parameters<typeof approvalRegistry.register>[1]) =>
          approvalRegistry.register(conversationId, request)
      : undefined;
    return new ChatSession({
      llm: router,
      model: resolvedModel,
      approvalBroker,
      ...(approvalResolver ? { approvalResolver } : {}),
      // C-1: when a profile is active, thread it into the session so the
      // dispatch-level hard reject (readOnlyMode / hardRejectMutations /
      // denylistTools) fires BEFORE the broker is consulted — i.e. even a
      // user `allow` decision cannot override it.
      ...(profile ? { profile } : {}),
      ...(mcpRegistry ? { mcpRegistry } : {}),
      // T1-D: thread workspace + scope into tools so lean_check (and future
      // wiki/effort tools) can resolve project-relative paths. BUG #7 fix.
      // v0.5 §2: workspace is now scope-narrowed so fs tools land inside the
      // project / effort dir, not at workspace root.
      workspace: scopedWorkspace,
      toolContext: { workspace: scopedWorkspace, scope },
      // /diff + checkpoint/rewind: snapshot write_file / edit_file mutations
      // under the scoped workspace so the SPA `/diff` + `/rewind` endpoints can
      // inspect / roll them back. Keyed by the SPA conversation id.
      ...(conversationId
        ? { checkpoints: { conversationId, workspace: scopedWorkspace } }
        : {}),
      systemPrompt: buildScopedSystemPrompt(scope, scopedWorkspace),
      // v0.17 W12 — wire `todo_write` per-conversation so each thread has
      // its own persisted plan file. The factory closes over the scope +
      // conversation id so the SSE pump can find the same file after each
      // tool result and emit a `todos` event for the SPA panel.
      tools: conversationId
        ? [
            createLeanCheckTool(lean),
            createTodoWriteTool({
              workspace: scopedWorkspace,
              scope: scope ?? { kind: "global" },
              conversationId,
            }),
          ]
        : [createLeanCheckTool(lean)],
      subagentScheduler: scheduler,
      scheduler,
      builtinTools: {
        search: true,
        read_file_summary: true,
        bash: true,
        read_file: true,
        write_file: true,
        edit_file: true,
        // #3 Background Agents: when this session belongs to a conversation,
        // wire the shared process-local background registry + a companion
        // get_subagent_result tool so `mode: "background"` is available and the
        // run is tracked / cancellable / SSE-notified. Conversation-less
        // sessions (rare) get sync-only dispatch.
        dispatch_subagent: conversationId
          ? {
              background: {
                registry: globalBackgroundRegistry(),
                parentConversationId: conversationId,
              },
            }
          : true,
        // v0.16 §11: the serve resolver throws `AskUserPending` to escape
        // the LLM loop. The chat round handler catches it, persists the
        // `pendingAsk` annotation against the conversation sidecar, and
        // closes the SSE stream cleanly so the SPA can render the inline
        // answer box. `POST <chatBase>/:id/answer-ask` patches the
        // placeholder tool message with the reply and resumes the round.
        ask_user: {
          resolver: async (question, ctx) => {
            // v0.19 Codex parity — forward the structured fields from the
            // tool's parsed args into the pending payload so the SSE
            // event + sidecar + SPA UI all see the same options/default/
            // timeoutSeconds/allowCustom the model emitted.
            throw new AskUserPending({
              question,
              callId: ctx.callId,
              ...(ctx.options !== undefined ? { options: ctx.options } : {}),
              ...(ctx.default !== undefined ? { default: ctx.default } : {}),
              ...(ctx.timeoutSeconds !== undefined
                ? { timeoutSeconds: ctx.timeoutSeconds }
                : {}),
              ...(ctx.allowCustom !== undefined
                ? { allowCustom: ctx.allowCustom }
                : {}),
            });
          },
        },
        // v0.17 follow-up — chat-mode goal proposal. Same `AskUserPending`
        // resolver pattern as ask_user so the SPA's existing inline
        // confirmation UI is reused. The tool itself creates the Goal
        // record on confirm; SSE pump (below) emits a `goal-proposed`
        // frame on the tool-result so the SPA can render an "open goal"
        // notification without a follow-up GET.
        propose_goal: {
          resolver: async (question, { callId }) => {
            throw new AskUserPending({ question, callId });
          },
          workspace: scopedWorkspace,
          scope: scope ?? { kind: "global" },
          model: resolvedModel,
          autoRunner: autoRunGoal,
        },
        // v0.18 — chat-mode steer for an existing long-running goal.
        // Same workspace + autoRunner the propose_goal binding uses;
        // see createGoalSendMessageTool for full rationale.
        goal_send_message: {
          workspace: scopedWorkspace,
          autoRunner: autoRunGoal,
        },
        propose_plan: {
          resolver: async (question, { callId }) => {
            throw new AskUserPending({ question, callId });
          },
          workspace: scopedWorkspace,
          model: resolvedModel,
          autoRunner: autoRunPlan,
        },
      },
    });
  };
}

/**
 * Goal-mode builtin tool set. Goal mode runs unattended, so the LLM
 * needs the same filesystem/search/exec capabilities as chat mode to
 * actually accomplish a research task (read papers, write .tex,
 * compile pdf, grep workspace). We deliberately exclude:
 *
 *  - dispatch_subagent / propose_goal / propose_plan: goal mode already
 *    has spawn_sub_goal, and the propose_* tools throw AskUserPending
 *    which goal mode's runner can't handle (no UI to render).
 *  - ask_user is NOT listed here because goal mode's runner installs its
 *    own auto-resolver via runner.ts builtinTools.ask_user (overrides any
 *    base config). We leave it off the base set so callers can opt in via
 *    the runner's spread without us double-registering.
 *
 * Bug exp-1894 fix: previously goal mode shipped with ONLY lean_check,
 * leaving the LLM unable to read its own workspace files. See
 * `_tasks/exp-1894-bugs/REPORT.md` Bug A.
 */
export const GOAL_MODE_BUILTIN_TOOLS = {
  search: true,
  read_file_summary: true,
  bash: true,
  read_file: true,
  write_file: true,
  edit_file: true,
} as const;

/** Append a short scope hint to the system prompt so the model knows where it is. */
export function buildScopedSystemPrompt(
  scope: ChatScope | undefined,
  workspace: string,
): string {
  const base =
    !scope || scope.kind === "global"
      ? SYSTEM_PROMPT
      : scope.kind === "project"
        ? `${SYSTEM_PROMPT}\n\nYou are chatting inside project "${scope.projectSlug}".`
        : `${SYSTEM_PROMPT}\n\nYou are chatting inside effort "${scope.effortSlug}" of project "${scope.projectSlug}".`;
  return appendPersistentContext(base, workspace, scope);
}

/**
 * Read MEMORY.md / AGENTS.md style files from the workspace and append them
 * to the system prompt. v0.15 §1.
 *
 * Why both a global and a scoped layer: a user typically wants the same
 * "who I am, what conventions matter" preamble on every chat (MEMORY.md
 * at workspace root), plus an optional project-/effort-specific note that
 * only applies inside that scope (`<scope>/MEMORY.md`).
 *
 * Failure modes (file missing, unreadable, too large) are silent — the
 * chat must keep working even with no persistent context. We cap each
 * file at ~64 KiB so a runaway MEMORY.md can't blow up every prompt.
 */
const PERSISTENT_CONTEXT_MAX_BYTES = 64 * 1024;
const PERSISTENT_CONTEXT_FILES = ["MEMORY.md", "AGENTS.md"] as const;

function readPersistentFile(dir: string, name: string): string | null {
  try {
    const full = path.join(dir, name);
    const stat = fssync.statSync(full);
    if (!stat.isFile()) return null;
    const buf = fssync.readFileSync(full);
    if (buf.byteLength === 0) return null;
    if (buf.byteLength <= PERSISTENT_CONTEXT_MAX_BYTES) return buf.toString("utf8");
    // Soft cap — keep the head, append a marker so the model knows it's truncated.
    return (
      buf.subarray(0, PERSISTENT_CONTEXT_MAX_BYTES).toString("utf8") +
      `\n\n... [truncated at ${PERSISTENT_CONTEXT_MAX_BYTES} bytes] ...`
    );
  } catch {
    return null;
  }
}

export function appendPersistentContext(
  base: string,
  workspace: string,
  scope: ChatScope | undefined,
): string {
  const sections: string[] = [];
  // Global layer: <workspace root>/MEMORY.md and AGENTS.md
  for (const name of PERSISTENT_CONTEXT_FILES) {
    const content = readPersistentFile(workspace, name);
    if (content) {
      sections.push(`## ${name} (workspace root)\n\n${content.trim()}`);
    }
  }
  // Scoped layer: project- or effort-specific notes (mathran already scopes
  // `workspace` per chat, so for scoped chats the loop above already covers
  // the scoped dir; nothing extra needed here).
  if (sections.length === 0) return base;
  return `${base}\n\n# Persistent context\n\nThe following files were loaded from your workspace and represent\nlong-lived preferences, conventions, and notes. Treat them as authoritative\nunless a more specific instruction overrides them.\n\n${sections.join("\n\n")}`;
}

// ─── Chat session store (disk-backed; see src/core/chat/store.ts) ────────────

// ─── App assembly ────────────────────────────────────────────────────────────

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>mathran</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
<h1>mathran</h1>
<p>Frontend not built yet. Run the <code>d2-serve-frontend</code> build to populate <code>dist/web/</code>.</p>
<p>The REST + SSE API is live under <code>/api</code> (e.g. <a href="/api/health">/api/health</a>).</p>
</body>
</html>
`;

// ─── Chat route helpers ───────────────────────────────────────────────────────────

/**
 * Wire one chat scope (global / project / effort) into the Hono app.
 *
 * `basePath` is the URL prefix for the scope (e.g. `/api/global-chat`,
 * `/api/projects/:slug/chat`, or `/api/projects/:slug/effort/:effortSlug/chat`).
 * `getScope` derives the `ChatScope` from the request context (and is the
 * place we run slug-safety / project-exists checks).
 */
// Helper functions for the usage endpoint (Task 19).
// We reuse the Task 4 token counters and the Task 5 default context window.
// Per-model context-window resolution (TODO-2 §5.6 / C7): delegate to the
// copilot models cache so we use REAL caps from the /models endpoint
// (refreshed each session token cycle) instead of guessed values.
// Hardcoded snapshot fallback for cold start. Unknown models → 200K default.
function resolveContextWindow(model: string | undefined): number {
  if (!model) return 200_000;
  return contextWindowForModel(model);
}

/** Pick the right token counter for a model name (matches Task 4 conventions). */
function pickCounter(model: string | undefined): TokenCounter {
  if (!model) return createOpenAITokenCounter(undefined);
  const m = model.toLowerCase();
  const bare = m.includes("/") ? m.split("/").pop() ?? m : m;
  if (bare.startsWith("claude") || bare.startsWith("anthropic")) {
    return createAnthropicTokenCounter();
  }
  try {
    return createOpenAITokenCounter(bare);
  } catch {
    return createFallbackTokenCounter();
  }
}

/** Find the model hint to use for token counting / context-window resolution. */
function modelHintFromHistory(history: LLMMessage[], fallback?: string): string | undefined {
  // Walk backwards: prefer the most-recent assistant turn's `model` field.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i] as LLMMessage & { model?: string };
    if (m.role === "assistant" && typeof m.model === "string" && m.model.length > 0) {
      return m.model;
    }
  }
  return fallback;
}

export interface UsageStats {
  tokens: number;
  messages: number;
  contextWindow: number;
  percentage: number;
  warning: string | null;
}

/** Build the `/usage` response payload from a conversation history. */
export function computeUsageStats(
  history: LLMMessage[],
  fallbackModel?: string,
): UsageStats {
  const model = modelHintFromHistory(history, fallbackModel);
  const counter = pickCounter(model);
  const tokens = counter.countMessages(history);
  const contextWindow = resolveContextWindow(model);
  const percentage = contextWindow > 0
    ? Math.round((tokens / contextWindow) * 10000) / 100
    : 0;
  let warning: string | null = null;
  if (percentage >= 90) {
    warning = "Context near limit. /compact strongly recommended.";
  } else if (percentage >= 75) {
    warning = "Context approaching limit. Consider /compact.";
  }
  return { tokens, messages: history.length, contextWindow, percentage, warning };
}

function registerChatScope(
  app: Hono,
  store: ScopedChatSessionStore,
  basePath: string,
  getScope: (c: any) => { scope?: ChatScope; error?: string; status?: 400 | 404 },
  approvalRegistry: ApprovalRegistry = sharedApprovalRegistry,
): void {
  // Approval Policy 矩阵 — POST <base>/:cid/approval/:id resolves a parked
  // prompt; GET lists pending prompts for recovery after a page reload.
  registerApprovalRoute(app, basePath, approvalRegistry);
  // POST <base>  — send a message (SSE)
  app.post(basePath, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const message = typeof body?.message === "string" ? body.message : "";
    // v0.17 mathub parity W2: optional attachment refs from the composer
    // upload flow. Each entry is `{ path, filename, mimeType }` as returned
    // by `POST /api/uploads`; we re-validate paths against the workspace
    // sandbox before reading any bytes.
    const rawAttachments = body?.attachments;
    const attachments: AttachmentRef[] = Array.isArray(rawAttachments)
      ? rawAttachments.filter(
          (a: unknown): a is AttachmentRef =>
            !!a &&
            typeof a === "object" &&
            typeof (a as AttachmentRef).path === "string" &&
            typeof (a as AttachmentRef).filename === "string" &&
            typeof (a as AttachmentRef).mimeType === "string",
        )
      : [];
    if (!message && attachments.length === 0) {
      return c.json({ error: "message is required" }, 400);
    }
    // Build the augmented user-message text BEFORE we open the SSE
    // stream: a bad-path attachment must surface as an HTTP 400, not as
    // a half-open SSE that emits an error event. Once the stream is
    // open we can't rewrite the status code.
    //
    // C-round Commit 4: we resolve / construct the chat session FIRST so we
    // can ask the provider whether it supports vision
    // (`session.providerSupportsVision()`). If yes, attachments with
    // `image/*` MIME render as inline base64 `ContentPart` blocks the
    // provider adapter can emit as native image blocks. If no (Ollama,
    // unknown route, etc.) we fall back to the legacy `[Image: ...]` text
    // marker so the model still gets a notice.
    const model = typeof body?.model === "string" ? body.model : undefined;
    // sessionId / conversationId aliases for back-compat.
    const requested = typeof body?.conversationId === "string" && body.conversationId.length > 0
      ? body.conversationId
      : typeof body?.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : null;
    const conversationId = requested ?? ScopedChatSessionStore.newConversationId();

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, conversationId, model);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }

    // TODO-3: if the previous round left a pending `ask_user` (placeholder
    // tool message + sidecar slot), and the user sent a fresh message
    // instead of POSTing /answer-ask, cancel the orphan first. Otherwise
    // the placeholder lives in history forever and the model sees an
    // unanswered tool-call slot every subsequent round, which has been
    // observed to block follow-up rounds (e.g. propose_goal call
    // call_hHeDrux1BJHcPhjWAnkBmiZF in c-a9c24f1d-mqlb9nqk). Best-effort:
    // never fails the send.
    try {
      await cancelOrphanPendingAsk({
        store,
        scope,
        conversationId,
        session,
        reason: "user sent a new message instead of answering",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mathran] cancelOrphanPendingAsk threw for ${conversationId}; proceeding with send:`,
        err,
      );
    }

    let augmentedMessage: MessageContent;
    try {
      augmentedMessage = await buildUserMessageWithAttachments(
        store.getWorkspace(),
        message,
        attachments,
        { enableVision: session.providerSupportsVision() },
      );
    } catch (err: unknown) {
      if (err instanceof BadAttachmentError) {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: (err as Error)?.message ?? String(err) }, 500);
    }

    return streamSSE(c, async (stream) => {
      // v0.17 mathub parity W9 — register this conversation as having an
      // in-flight stream so `POST .../:cid/steer` knows where to queue.
      // Paired with the `finally` release below; ref-counted so a
      // concurrent rerun on the same conversationId still releases
      // cleanly when one of them ends.
      const releaseSteerSlot = markStreamActive(conversationId);
      const releaseGoalGraded = pipeGoalGradedFrames(stream);
      const releaseSubagentCompleted = pipeSubagentCompletedFrames(
        stream,
        conversationId,
      );
      try {
        await stream.writeSSE({
          event: "session",
          data: JSON.stringify({ sessionId: conversationId, conversationId, scope }),
        });
        for await (const ev of session.send(augmentedMessage, {
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          steerProbe: () => consumePendingSteer(conversationId),
        }) as AsyncIterable<ChatEvent>) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
          // v0.17 W12 — after a successful `todo_write` tool result, ship
          // the freshly persisted TODO list so the SPA can render the
          // ActivePlanPanel without a follow-up GET. We synthesise the
          // frame in the host layer (not the kernel) because ChatSession
          // can't yield arbitrary events from inside a tool.
          if (
            ev.type === "tool-result" &&
            ev.name === "todo_write" &&
            ev.ok
          ) {
            try {
              const list = await loadTodos(store.getWorkspace(), scope, conversationId);
              await stream.writeSSE({
                event: "todos",
                data: JSON.stringify({ type: "todos", list }),
              });
            } catch {
              /* best-effort — a missing file shouldn't break the stream */
            }
          }
          // v0.17 follow-up: after a successful `propose_goal` tool result,
          // the chat tool already wrote the Goal record (createGoal) and
          // returned `{ ok, goalId, objective, maxRounds, tokensCap }`
          // serialized as JSON in `content`. Surface that to the SPA as a
          // `goal-proposed` event so the panel can show an "open goal"
          // notification without a follow-up GET.
          if (
            ev.type === "tool-result" &&
            ev.name === "propose_goal" &&
            ev.ok
          ) {
            try {
              const payload = JSON.parse((ev as { content?: string }).content ?? "{}");
              if (payload && payload.ok && payload.goalId) {
                await stream.writeSSE({
                  event: "goal-proposed",
                  data: JSON.stringify({
                    type: "goal-proposed",
                    goalId: payload.goalId,
                    objective: payload.objective,
                    maxRounds: payload.maxRounds,
                    tokensCap: payload.tokensCap,
                    scope: payload.scope ?? scope,
                    autoRun: Boolean(payload.autoRun),
                  }),
                });
              }
            } catch {
              /* best-effort — a malformed payload shouldn't break the stream */
            }
          }
          // v0.17 P2 sibling — propose_plan emits plan-proposed on confirm.
          if (
            ev.type === "tool-result" &&
            ev.name === "propose_plan" &&
            ev.ok
          ) {
            try {
              const payload = JSON.parse((ev as { content?: string }).content ?? "{}");
              if (payload && payload.ok && payload.planId) {
                await stream.writeSSE({
                  event: "plan-proposed",
                  data: JSON.stringify({
                    type: "plan-proposed",
                    planId: payload.planId,
                    objective: payload.objective,
                    autoRun: Boolean(payload.autoRun),
                  }),
                });
              }
            } catch {
              /* best-effort */
            }
          }
        }
        // Flush the freshly-augmented history to disk before closing the stream.
        await store.flush(scope, conversationId);
        await store.flush(scope, conversationId);
      } catch (err: any) {
        // v0.16 §11: an `ask_user` round paused itself — not an error,
        // intentional escape. The session has already (a) yielded the
        // `ask_user` ChatEvent (so the SPA saw it on the wire) and
        // (b) pushed a placeholder `tool` message keyed by `err.callId`.
        // Persist `pendingAsk` against the conversation sidecar so a
        // tab reload after this stream closes can still render the
        // answer box, flush history, and close the stream cleanly
        // instead of surfacing a misleading `event:error`.
        if (isAskUserPending(err)) {
          await store.flush(scope, conversationId);
          try {
            const sidecar = await loadAnnotations(
              store.getWorkspace(),
              scope,
              conversationId,
            );
            const pendingAsk = makePendingAskRecord(err as AskUserPending);
            await saveAnnotations(store.getWorkspace(), scope, conversationId, {
              ...sidecar,
              pendingAsk,
            });
            // v0.19 Codex parity — schedule the server-side timeout if the
            // model supplied one. The timer is cancelled by the
            // /answer-ask handler when the user replies first.
            if (
              typeof pendingAsk.timeoutSeconds === "number" &&
              pendingAsk.timeoutSeconds >= 1
            ) {
              scheduleAskTimeout(
                pendingAsk.callId,
                pendingAsk.timeoutSeconds * 1000,
                makeAskTimeoutResolver({
                  store,
                  scope,
                  conversationId,
                  callId: pendingAsk.callId,
                  fallback: pendingAsk.default ?? ASK_USER_GOAL_AUTO_REPLY,
                }),
              );
            }
          } catch (annotErr) {
            // Annotation failure is non-fatal; the SPA already has the
            // question via the live `ask_user` SSE event. Logging is
            // enough — we don't want to convert this into a 500 that
            // would mask the real (intentional) pause.
            // eslint-disable-next-line no-console
            console.warn(
              `[mathran] failed to persist pendingAsk for ${conversationId}:`,
              annotErr,
            );
          }
          return;
        }
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err?.message ?? String(err) }),
        });
      } finally {
        // v0.17 mathub parity W9 — always release the steer slot so a
        // future POST .../steer for this conversation doesn't 200 into
        // the void (the registry refuses with 409 once the slot is
        // gone). Also clears any unread steer on the way out so a fresh
        // stream on the same conversationId doesn't pick up a stale one.
        releaseSteerSlot();
        // outcomes 收尾 C-2 — stop relaying background goal-graded frames once
        // this stream is done.
        releaseGoalGraded();
        // #3 — stop relaying background subagent-completed frames too.
        releaseSubagentCompleted();
        // Approval Policy 矩阵 — fail-safe: settle any prompt still awaiting a
        // decision (browser closed mid-approval) as a deny so the session never
        // hangs on a dead Promise.
        approvalRegistry.rejectPending(conversationId);
      }
    });
  });

  // GET <base>  — list conversations in this scope
  app.get(basePath, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const conversations = await store.listConversations(resolved.scope!);
    return c.json({ conversations });
  });

  // v0.18 — POST <base>/:parentConversationId/threads
  // Discord-style child thread on a parent conversation. Body:
  //   {
  //     anchorBubbleIdx?: number,    // bubble in the parent to fork off of
  //     title?: string,              // initial sidebar label (default derived)
  //     threadDescription?: string,  // optional hover tooltip text
  //   }
  // Response: { conversation: ConversationMeta }
  //
  // The new thread's .jsonl is NOT created server-side; it appears on the
  // first send() to the thread (same as every other new conversation).
  // We immediately bump the parent's lastUsedAt so the SPA sidebar's
  // sort order surfaces the new activity.
  app.post(`${basePath}/:parentConversationId/threads`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const parentId = c.req.param("parentConversationId");
    if (!isSafeSlug(parentId)) {
      return c.json({ error: "invalid parent conversation id" }, 400);
    }
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is allowed — caller may just want a generic child thread.
      body = {};
    }
    const b = (body ?? {}) as {
      anchorBubbleIdx?: unknown;
      title?: unknown;
      threadDescription?: unknown;
    };
    const anchorBubbleIdx =
      typeof b.anchorBubbleIdx === "number" &&
      Number.isInteger(b.anchorBubbleIdx) &&
      b.anchorBubbleIdx >= 0
        ? b.anchorBubbleIdx
        : undefined;
    const title = typeof b.title === "string" ? b.title : undefined;
    const threadDescription =
      typeof b.threadDescription === "string" ? b.threadDescription : undefined;

    try {
      const meta = await store.createThread(resolved.scope!, parentId, {
        anchorBubbleIdx,
        title,
        threadDescription,
      });
      return c.json({ conversation: meta });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Parent not found is the only checked failure mode today; surface as 404.
      if (msg.includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      return c.json({ error: msg }, 500);
    }
  });

  // GET <base>/:conversationId  — read history of one conversation
  app.get(`${basePath}/:conversationId`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const history = await store.readHistory(resolved.scope!, id);
    if (history === null) return c.json({ error: "conversation not found" }, 404);
    return c.json({ conversationId: id, history });
  });

  // DELETE <base>/:conversationId  — drop a conversation
  app.delete(`${basePath}/:conversationId`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const ok = await store.drop(resolved.scope!, id);
    return c.json({ dropped: ok });
  });

  // POST <base>/:conversationId/compact  — compact this conversation (v0.2 §5)
  app.post(`${basePath}/:conversationId/compact`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    // 404 unless the conversation is already on disk (we don't lazy-create here).
    const history = await store.readHistory(scope, id);
    if (history === null) return c.json({ error: "conversation not found" }, 404);

    let body: any = {};
    try {
      const raw = await c.req.text();
      if (raw && raw.trim().length > 0) body = JSON.parse(raw);
    } catch {
      // Ignore malformed body; treat as no opts.
    }
    const keep =
      typeof body?.keepRecentRounds === "number" && body.keepRecentRounds > 0
        ? body.keepRecentRounds
        : undefined;

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, id, undefined);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }

    try {
      const stats = await session.compact(keep ? { keepRecentRounds: keep } : undefined);
      // Persist the freshly-shortened history.
      await store.flush(scope, id);
      return c.json({ ok: true, stats });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }
  });

  // POST <base>/:conversationId/rerun  — re-run from a prior user prompt (v0.16 §1).
  //
  // Body: `{ userMessageIndex: number, model?: string }`.
  //
  // `userMessageIndex` is the 0-based ordinal of the target user message *among
  // user messages only* (system / assistant / tool messages are skipped when
  // counting). The server truncates history to everything **before** that user
  // message (so the kernel's own `session.send(text)` re-pushes it), replays
  // the history into the session, then streams the new assistant turn over SSE
  // using the exact same envelope as `POST <base>` so the SPA can reuse its
  // existing stream parser.
  //
  // Why an explicit endpoint instead of "client deletes + resends"?
  //   - One atomic flush, one disk write, one transcript rewrite.
  //   - The truncate logic lives next to the store so we never split a
  //     tool-call/tool-result pair (would otherwise break the next LLM call).
  //   - The client doesn't need messageIds (LLMMessage has none), and the
  //     user-ordinal protocol is symmetric between SPA and server.
  app.post(`${basePath}/:conversationId/rerun`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const userMessageIndex = body?.userMessageIndex;
    if (!Number.isInteger(userMessageIndex) || userMessageIndex < 0) {
      return c.json({ error: "userMessageIndex must be a non-negative integer" }, 400);
    }
    const model = typeof body?.model === "string" ? body.model : undefined;
    // Optional `overrideText`: when set, the streamed turn uses this string
    // instead of the original prompt content. This is how the SPA implements
    // "edit and resend" without needing a second endpoint -- semantically
    // identical to rerun, just with a different prompt body.
    const overrideText =
      typeof body?.overrideText === "string" ? body.overrideText : undefined;
    if (overrideText !== undefined && overrideText.length === 0) {
      return c.json({ error: "overrideText must be non-empty when provided" }, 400);
    }

    // Prefer the live in-memory history (mirrors /usage) so re-running right
    // after a stream ends sees the latest turn, even before the LRU flush.
    const live = store.peekLiveHistory(scope, id);
    const history = live ?? (await store.readHistory(scope, id));
    if (history === null) return c.json({ error: "conversation not found" }, 404);

    // Walk the on-disk history to find the Nth user message (0-based).
    let seen = 0;
    let targetIdx = -1;
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === "user") {
        if (seen === userMessageIndex) { targetIdx = i; break; }
        seen++;
      }
    }
    if (targetIdx === -1) {
      return c.json({ error: `user message #${userMessageIndex} not found (only ${seen} user message${seen === 1 ? "" : "s"} exist)` }, 400);
    }
    const promptText = overrideText ?? history[targetIdx].content;
    if (!promptText) return c.json({ error: "target user message is empty" }, 400);

    // Truncate to everything strictly before the target user message. The
    // kernel's `session.send(text)` will push the user message back in, so we
    // must *not* include it ourselves — that would duplicate it. (Also applies
    // to the override-text case: send() pushes the *new* prompt.)
    const truncated = history.slice(0, targetIdx);

    // Wipe annotations on bubbles that are about to be regenerated. The SPA
    // sends `pruneFromBubbleIdx` = the bubble index of the user message
    // being re-run; annotations on the anchor user bubble *and* everything
    // after are dropped (the user prompt content may be edited via
    // overrideText, and any assistant reply will be replaced wholesale).
    const pruneFromBubbleIdx = body?.pruneFromBubbleIdx;
    if (Number.isInteger(pruneFromBubbleIdx) && pruneFromBubbleIdx >= 0) {
      await pruneAnnotationsFrom(store.getWorkspace(), scope, id, pruneFromBubbleIdx);
    }

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, id, model);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }
    // Overwrite the live session history before we stream the new turn. The
    // store's `replaceHistory` preserves leading system messages, so the user
    // never loses memory/persona injections from /context.
    session.replaceHistory(truncated);

    return streamSSE(c, async (stream) => {
      // v0.17 mathub parity W9 — same active-stream tracking as POST <base>
      // so the user can steer a rerun mid-flight.
      const releaseSteerSlot = markStreamActive(id);
      const releaseGoalGraded = pipeGoalGradedFrames(stream);
      try {
        // Mirror the POST <base> envelope exactly so the SPA's existing SSE
        // reader handles re-run identically to a fresh send.
        await stream.writeSSE({
          event: "session",
          data: JSON.stringify({ sessionId: id, conversationId: id, scope }),
        });
        for await (const ev of session.send(promptText, {
          steerProbe: () => consumePendingSteer(id),
        }) as AsyncIterable<ChatEvent>) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
          // v0.17 W12 — mirror the new-message pump: emit a `todos`
          // frame after every successful `todo_write` so the rerun path
          // updates the SPA panel just like an initial send.
          if (
            ev.type === "tool-result" &&
            ev.name === "todo_write" &&
            ev.ok
          ) {
            try {
              const list = await loadTodos(store.getWorkspace(), scope, id);
              await stream.writeSSE({
                event: "todos",
                data: JSON.stringify({ type: "todos", list }),
              });
            } catch {
              /* best-effort */
            }
          }
          // v0.17 follow-up: propose_goal mirror in rerun path.
          if (
            ev.type === "tool-result" &&
            ev.name === "propose_goal" &&
            ev.ok
          ) {
            try {
              const payload = JSON.parse((ev as { content?: string }).content ?? "{}");
              if (payload && payload.ok && payload.goalId) {
                await stream.writeSSE({
                  event: "goal-proposed",
                  data: JSON.stringify({
                    type: "goal-proposed",
                    goalId: payload.goalId,
                    objective: payload.objective,
                    maxRounds: payload.maxRounds,
                    tokensCap: payload.tokensCap,
                    scope: payload.scope ?? scope,
                    autoRun: Boolean(payload.autoRun),
                  }),
                });
              }
            } catch {
              /* best-effort */
            }
          }
          // v0.17 P2 sibling — propose_plan mirror in rerun path.
          if (
            ev.type === "tool-result" &&
            ev.name === "propose_plan" &&
            ev.ok
          ) {
            try {
              const payload = JSON.parse((ev as { content?: string }).content ?? "{}");
              if (payload && payload.ok && payload.planId) {
                await stream.writeSSE({
                  event: "plan-proposed",
                  data: JSON.stringify({
                    type: "plan-proposed",
                    planId: payload.planId,
                    objective: payload.objective,
                    autoRun: Boolean(payload.autoRun),
                  }),
                });
              }
            } catch {
              /* best-effort */
            }
          }
        }
        await store.flush(scope, id);
      } catch (err: any) {
        if (isAskUserPending(err)) {
          // v0.16 §11: re-run paused on `ask_user`. Same handling as the
          // initial POST <base> route — persist pendingAsk, flush, close
          // cleanly. See that handler for the rationale.
          await store.flush(scope, id);
          try {
            const sidecar = await loadAnnotations(
              store.getWorkspace(),
              scope,
              id,
            );
            const pendingAsk = makePendingAskRecord(err as AskUserPending);
            await saveAnnotations(store.getWorkspace(), scope, id, {
              ...sidecar,
              pendingAsk,
            });
            if (
              typeof pendingAsk.timeoutSeconds === "number" &&
              pendingAsk.timeoutSeconds >= 1
            ) {
              scheduleAskTimeout(
                pendingAsk.callId,
                pendingAsk.timeoutSeconds * 1000,
                makeAskTimeoutResolver({
                  store,
                  scope,
                  conversationId: id,
                  callId: pendingAsk.callId,
                  fallback: pendingAsk.default ?? ASK_USER_GOAL_AUTO_REPLY,
                }),
              );
            }
          } catch (annotErr) {
            // eslint-disable-next-line no-console
            console.warn(
              `[mathran] failed to persist pendingAsk for ${id} during rerun:`,
              annotErr,
            );
          }
          return;
        }
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err?.message ?? String(err) }),
        });
      } finally {
        releaseSteerSlot();
        releaseGoalGraded();
        approvalRegistry.rejectPending(id);
      }
    });
  });

  // POST <base>/:conversationId/steer  — v0.17 mathub parity W9 (Live
  // Steering). Queue a free-form steer text against an in-flight stream
  // for this conversation. The currently-running `ChatSession.runRounds`
  // loop probes `steer-registry.consumePendingSteer` at every round
  // boundary (before issuing the next LLM request); on a hit it injects
  // a synthetic `[Steer from user: …]` user message into history AND
  // yields a `{ type: "steer-received" }` SSE event so the SPA can
  // dismiss its "queued" toast.
  //
  // Contract:
  //   - Body: `{ text: string }`. Empty or whitespace-only → 400.
  //   - If no stream is in-flight for this conversation → 409. Steers
  //     are tied to the round they steer; we refuse to queue them into
  //     the void where they'd be picked up by a later (possibly
  //     unrelated) stream on the same conversationId.
  //   - Otherwise: 200 `{ ok: true, queued: true, conversationId }`.
  //     Last-write-wins — a second POST overwrites the first.
  //
  // Designed to be safe under the same scope-resolver as every other
  // chat route, so e.g. an effort-scoped steer can't bleed into global
  // chat: `getScope(c)` runs first, and we 404 on an unknown
  // `effortSlug` before touching the registry.
  app.post(`${basePath}/:conversationId/steer`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const raw = typeof body?.text === "string" ? body.text : "";
    const text = raw.trim();
    if (text.length === 0) return c.json({ error: "text is required" }, 400);

    // Refuse to queue when no stream is in flight — the steer would
    // never be read. The SPA also gates its Steer button on the local
    // `busy` flag, but we double-check on the server because tabs can
    // drift and clients shouldn't be the trust boundary.
    if (!hasActiveStream(id)) {
      return c.json(
        { error: "no in-flight stream to steer", conversationId: id, scope },
        409,
      );
    }
    setPendingSteer(id, text);
    return c.json({ ok: true, queued: true, conversationId: id, scope });
  });

  // POST <base>/:conversationId/truncate  — drop a tail of the conversation
  // history (v0.16 §1). Body: `{ userMessageIndex, mode }`.
  //
  // `userMessageIndex` uses the same 0-based ordinal as /rerun (counted
  // among user messages only). `mode` controls what survives:
  //   - "include" (default): drop the target user message *and* everything
  //     after it. Used by "Delete from here" on a user bubble — wipes a
  //     whole turn (and any follow-up turns) in one shot.
  //   - "after": keep the target user message, drop only what comes after
  //     it (the stale assistant reply, tool bubbles, later turns). Used by
  //     "Delete reply" so the user can edit/rerun without re-typing.
  //
  // Synchronous: writes the new history to disk and returns the new length.
  // No SSE, no new turn — the SPA's `setBubbles` reflects the truncation
  // optimistically and a usage refresh follows.
  app.post(`${basePath}/:conversationId/truncate`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const userMessageIndex = body?.userMessageIndex;
    if (!Number.isInteger(userMessageIndex) || userMessageIndex < 0) {
      return c.json({ error: "userMessageIndex must be a non-negative integer" }, 400);
    }
    const mode = body?.mode === "after" ? "after" : "include";

    const live = store.peekLiveHistory(scope, id);
    const history = live ?? (await store.readHistory(scope, id));
    if (history === null) return c.json({ error: "conversation not found" }, 404);

    let seen = 0;
    let targetIdx = -1;
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === "user") {
        if (seen === userMessageIndex) { targetIdx = i; break; }
        seen++;
      }
    }
    if (targetIdx === -1) {
      return c.json({ error: `user message #${userMessageIndex} not found (only ${seen} user message${seen === 1 ? "" : "s"} exist)` }, 400);
    }

    const newHistory = mode === "after"
      ? history.slice(0, targetIdx + 1)
      : history.slice(0, targetIdx);

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, id, undefined);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }
    session.replaceHistory(newHistory);
    await store.flush(scope, id);

    // Wipe annotations whose bubbles no longer exist. The SPA passes
    // bubble-coordinate `pruneFromBubbleIdx`; if omitted, we skip the
    // prune (safe because over-pruning the SPA bubble list locally on
    // truncate handles the common case). Annotation keys are SPA bubble
    // indices, not server history indices — the server doesn't need to
    // know the mapping, only how far to wipe.
    const pruneFromBubbleIdx = body?.pruneFromBubbleIdx;
    if (Number.isInteger(pruneFromBubbleIdx) && pruneFromBubbleIdx >= 0) {
      await pruneAnnotationsFrom(store.getWorkspace(), scope, id, pruneFromBubbleIdx);
    }
    return c.json({ ok: true, length: newHistory.length, mode });
  });

  // POST <base>/:conversationId/answer-ask  — reply to a pending `ask_user`
  // (v0.16 §11). Body: `{ answer: string, callId?: string }`.
  //
  // Flow:
  //   1. Load the conversation's pendingAsk sidecar slot. 404 if missing.
  //   2. (If `callId` supplied) validate it matches the recorded one to
  //      guard against a stale tab posting an answer for a question the
  //      user already answered from a different tab.
  //   3. Patch the placeholder `tool` message in history (matched by
  //      `toolCallId`) to contain the user's reply. The placeholder was
  //      pushed by ChatSession when `AskUserPending` propagated; without
  //      this patch the next provider call would replay a useless
  //      `"[pending: …]"` content for the answer.
  //   4. Clear the pendingAsk annotation slot.
  //   5. Stream `session.resume()` over SSE — same envelope as POST <base>
  //      so the SPA can pump events through its existing reader.
  app.post(`${basePath}/:conversationId/answer-ask`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const answer = typeof body?.answer === "string" ? body.answer : "";
    if (!answer || answer.trim().length === 0) {
      return c.json({ error: "answer must be a non-empty string" }, 400);
    }
    const claimedCallId =
      typeof body?.callId === "string" && body.callId.length > 0
        ? body.callId
        : undefined;

    const sidecar = await loadAnnotations(store.getWorkspace(), scope, id);
    const pending = sidecar.pendingAsk;
    if (!pending) {
      // v0.17 W14 fix: goal-mode runner auto-resolves `ask_user`, so a
      // 404 here is almost always a stale sidecar slot from a previous
      // (pre-goal) chat round whose pending was cleared as the round
      // advanced. Returning a hard 404 surfaces "no pending ask_user"
      // as an error in the SPA; instead we 200 with `ignored: true`
      // so the answer-ask client can silently drop the inline answer
      // box without showing a toast.
      console.warn(
        `[mathran] /answer-ask for ${id}: no pending ask_user; ignoring (likely stale sidecar)`,
      );
      return c.json(
        { ok: true, ignored: true, reason: "no pending ask_user" },
        200,
      );
    }
    if (claimedCallId && claimedCallId !== pending.callId) {
      // A tab opened to a stale question; the user has already moved on.
      // 409 (not 404) so the SPA can show "this question was answered
      // from another tab" rather than treating it as a missing slot.
      return c.json(
        {
          error: "pending ask_user has a different callId",
          expectedCallId: pending.callId,
          gotCallId: claimedCallId,
        },
        409,
      );
    }

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, id, undefined);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }

    // Patch the placeholder tool message to contain the user's reply.
    // The session's history is the authoritative copy; the on-disk jsonl
    // is rewritten on the next `store.flush`. Match on `toolCallId` because
    // the placeholder content string is also a valid (if odd) reply users
    // could send; matching the id is the only race-free key.
    const history = session.history();
    let patched = false;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (
        msg.role === "tool" &&
        msg.toolCallId === pending.callId &&
        msg.content === ASK_USER_PENDING_PLACEHOLDER
      ) {
        history[i] = { ...msg, content: answer };
        patched = true;
        break;
      }
    }
    if (!patched) {
      // History was rewound (truncate / rerun) under us; clear the slot
      // and surface a 409 so the SPA can drop its inline answer UI
      // gracefully. The annotation's `pruneAnnotationsFrom` already
      // drops `pendingAsk` on prune, but a concurrent in-memory mutation
      // can leave a brief window where history changes without the
      // sidecar being rewritten yet — this is the defensive guard.
      const cleared: ConversationAnnotations = {
        ...sidecar,
        pendingAsk: undefined,
      };
      delete (cleared as { pendingAsk?: unknown }).pendingAsk;
      await saveAnnotations(store.getWorkspace(), scope, id, cleared);
      return c.json(
        { error: "placeholder tool message no longer in history" },
        409,
      );
    }
    // Replace the session's live history so the resume sees the patch.
    session.replaceHistory(history);

    // Clear the pendingAsk slot BEFORE streaming — if the resume itself
    // hits a *new* `ask_user`, the chat round handler's catch will write
    // a fresh pendingAsk on top.
    const cleared: ConversationAnnotations = { ...sidecar };
    delete (cleared as { pendingAsk?: unknown }).pendingAsk;
    await saveAnnotations(store.getWorkspace(), scope, id, cleared);
    // v0.19 Codex parity — cancel any server-side timeout that was scheduled
    // for this pending ask so the user's reply wins the race against a
    // delayed auto-resolve. Idempotent: harmless when no timer was set.
    cancelAskTimeout(pending.callId);

    return streamSSE(c, async (stream) => {
      // v0.17 mathub parity W9 — the user can steer a resumed-from-ask
      // round mid-flight too. Track active stream + pipe the probe into
      // `resume`, which forwards it straight into `runRounds`.
      const releaseSteerSlot = markStreamActive(id);
      const releaseGoalGraded = pipeGoalGradedFrames(stream);
      try {
        await stream.writeSSE({
          event: "session",
          data: JSON.stringify({
            sessionId: id,
            conversationId: id,
            scope,
            resumedFromAsk: true,
          }),
        });
        for await (const ev of session.resume({
          steerProbe: () => consumePendingSteer(id),
        }) as AsyncIterable<ChatEvent>) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
          // v0.17 W12 — same `todos` synthesis as the regular send pump,
          // mirrored here so a resumed-from-ask round that calls
          // `todo_write` still pushes the latest list to the SPA panel.
          if (
            ev.type === "tool-result" &&
            ev.name === "todo_write" &&
            ev.ok
          ) {
            try {
              const list = await loadTodos(store.getWorkspace(), scope, id);
              await stream.writeSSE({
                event: "todos",
                data: JSON.stringify({ type: "todos", list }),
              });
            } catch {
              /* best-effort */
            }
          }
          // v0.17 follow-up: propose_goal mirror in resume-from-ask path.
          if (
            ev.type === "tool-result" &&
            ev.name === "propose_goal" &&
            ev.ok
          ) {
            try {
              const payload = JSON.parse((ev as { content?: string }).content ?? "{}");
              if (payload && payload.ok && payload.goalId) {
                await stream.writeSSE({
                  event: "goal-proposed",
                  data: JSON.stringify({
                    type: "goal-proposed",
                    goalId: payload.goalId,
                    objective: payload.objective,
                    maxRounds: payload.maxRounds,
                    tokensCap: payload.tokensCap,
                    scope: payload.scope ?? scope,
                    autoRun: Boolean(payload.autoRun),
                  }),
                });
              }
            } catch {
              /* best-effort */
            }
          }
          // v0.17 P2 sibling — propose_plan mirror in resume-from-ask path.
          if (
            ev.type === "tool-result" &&
            ev.name === "propose_plan" &&
            ev.ok
          ) {
            try {
              const payload = JSON.parse((ev as { content?: string }).content ?? "{}");
              if (payload && payload.ok && payload.planId) {
                await stream.writeSSE({
                  event: "plan-proposed",
                  data: JSON.stringify({
                    type: "plan-proposed",
                    planId: payload.planId,
                    objective: payload.objective,
                    autoRun: Boolean(payload.autoRun),
                  }),
                });
              }
            } catch {
              /* best-effort */
            }
          }
        }
        await store.flush(scope, id);
      } catch (err: any) {
        if (isAskUserPending(err)) {
          // Resume hit a second `ask_user` — same handling as the initial
          // POST handler. Persist the new pendingAsk and close cleanly.
          await store.flush(scope, id);
          try {
            const next = await loadAnnotations(
              store.getWorkspace(),
              scope,
              id,
            );
            const pendingAsk = makePendingAskRecord(err as AskUserPending);
            await saveAnnotations(store.getWorkspace(), scope, id, {
              ...next,
              pendingAsk,
            });
            if (
              typeof pendingAsk.timeoutSeconds === "number" &&
              pendingAsk.timeoutSeconds >= 1
            ) {
              scheduleAskTimeout(
                pendingAsk.callId,
                pendingAsk.timeoutSeconds * 1000,
                makeAskTimeoutResolver({
                  store,
                  scope,
                  conversationId: id,
                  callId: pendingAsk.callId,
                  fallback: pendingAsk.default ?? ASK_USER_GOAL_AUTO_REPLY,
                }),
              );
            }
          } catch (annotErr) {
            // eslint-disable-next-line no-console
            console.warn(
              `[mathran] failed to persist nested pendingAsk for ${id}:`,
              annotErr,
            );
          }
          return;
        }
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err?.message ?? String(err) }),
        });
      } finally {
        releaseSteerSlot();
        releaseGoalGraded();
        // Approval Policy 矩阵 — fail-safe: a resumed round can raise a fresh
        // approval prompt too; settle any still pending if the stream dies.
        approvalRegistry.rejectPending(id);
      }
    });
  });

  // ─── Annotations sidecar (v0.16 §2) ────────────────────────────────────────
  // React / pin / note / reply-target lives in <scope>/annotations/<id>.json,
  // separately from the LLM-protocol jsonl. Keys are bubble indices (SPA
  // renderer coords), so the server doesn't need to understand bubble
  // construction — it just stores keyed records. /rerun and /truncate
  // accept `pruneFromBubbleIdx` to keep this sidecar in sync.

  // GET annotations for a conversation. Returns the whole sidecar so the
  // SPA can render with one round trip on load. Missing file -> empty.
  app.get(`${basePath}/:conversationId/annotations`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const data = await loadAnnotations(store.getWorkspace(), scope, id);
    return c.json(data);
  });

  // PATCH a single bubble's annotation. Body is a partial MessageAnnotation;
  // fields are merged into the existing record. Pass `null` to clear a
  // field (e.g. `pinned: null` to unpin). Returns the post-merge record.
  app.patch(`${basePath}/:conversationId/annotations/:bubbleIdx`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const bubbleIdxStr = c.req.param("bubbleIdx");
    const bubbleIdx = Number(bubbleIdxStr);
    if (!Number.isInteger(bubbleIdx) || bubbleIdx < 0) {
      return c.json({ error: "bubbleIdx must be a non-negative integer" }, 400);
    }

    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (!body || typeof body !== "object") {
      return c.json({ error: "body must be an object" }, 400);
    }

    const current = await loadAnnotations(store.getWorkspace(), scope, id);
    const existing: MessageAnnotation = current.byBubbleIdx[String(bubbleIdx)] ?? {};
    const merged: MessageAnnotation = { ...existing };

    // Merge each known field. null clears, undefined leaves alone, any
    // other value overwrites. Whitelist what we accept so a typo doesn't
    // pollute the sidecar.
    if ("reactions" in body) {
      if (body.reactions === null) delete merged.reactions;
      else if (body.reactions && typeof body.reactions === "object") {
        merged.reactions = body.reactions;
      }
    }
    if ("pinned" in body) {
      if (body.pinned === null || body.pinned === false) delete merged.pinned;
      else if (body.pinned === true) merged.pinned = true;
    }
    if ("note" in body) {
      if (body.note === null || body.note === "") delete merged.note;
      else if (typeof body.note === "string") merged.note = body.note;
    }
    if ("replyTo" in body) {
      if (body.replyTo === null) delete merged.replyTo;
      else if (
        body.replyTo &&
        typeof body.replyTo === "object" &&
        Number.isInteger(body.replyTo.bubbleIdx) &&
        typeof body.replyTo.snippet === "string"
      ) {
        merged.replyTo = {
          bubbleIdx: body.replyTo.bubbleIdx,
          snippet: body.replyTo.snippet,
        };
      }
    }

    // If the record went empty (everything cleared) drop the key so the
    // sidecar stays tidy.
    const next = { ...current.byBubbleIdx };
    if (Object.keys(merged).length === 0) {
      delete next[String(bubbleIdx)];
    } else {
      next[String(bubbleIdx)] = merged;
    }
    await saveAnnotations(store.getWorkspace(), scope, id, {
      version: 1,
      byBubbleIdx: next,
    });
    return c.json({ ok: true, bubbleIdx, annotation: merged });
  });

  // ─── UI state PATCH (v0.16 §4) ─────────────────────────────────────
  // Persist per-conversation UI scalars (scroll pos, expanded tool ids,
  // pinned-only filter) so a reload restores where the user was. Lives
  // in the same annotations sidecar to keep "things to remember about
  // this conversation" in one file. Body fields are merged — omitted
  // fields keep their previous value, `null` clears a field.
  app.patch(`${basePath}/:conversationId/uistate`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }

    const current = await loadAnnotations(store.getWorkspace(), scope, id);
    const prev: ConversationUiState = current.uiState ?? {};
    const next: ConversationUiState = { ...prev };

    // Whitelist + light validation. Anything else is silently ignored
    // so a hostile/typo'd field can't trash the sidecar.
    if ("scrollTop" in body) {
      if (body.scrollTop === null) delete next.scrollTop;
      else if (typeof body.scrollTop === "number" && Number.isFinite(body.scrollTop) && body.scrollTop >= 0) {
        next.scrollTop = Math.floor(body.scrollTop);
      }
    }
    if ("expandedToolCallIds" in body) {
      if (body.expandedToolCallIds === null) delete next.expandedToolCallIds;
      else if (Array.isArray(body.expandedToolCallIds)) {
        // Cap list size; tool-call ids are short. 500 covers any realistic
        // research session, and bounds the sidecar growth.
        const ids = body.expandedToolCallIds
          .filter((x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 128)
          .slice(0, 500);
        next.expandedToolCallIds = ids;
      }
    }
    if ("showPinnedOnly" in body) {
      if (body.showPinnedOnly === null) delete next.showPinnedOnly;
      else if (typeof body.showPinnedOnly === "boolean") next.showPinnedOnly = body.showPinnedOnly;
    }

    await saveAnnotations(store.getWorkspace(), scope, id, {
      version: 1,
      byBubbleIdx: current.byBubbleIdx,
      uiState: Object.keys(next).length === 0 ? undefined : next,
    });
    return c.json({ ok: true, uiState: next });
  });

  // Toggle reaction (convenience: avoids the SPA having to read-modify-write
  // the reactions object). Body: `{ emoji: string }`. Single-user, so
  // count is 0 or 1 — we just flip it.
  app.post(`${basePath}/:conversationId/annotations/:bubbleIdx/react`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const bubbleIdx = Number(c.req.param("bubbleIdx"));
    if (!Number.isInteger(bubbleIdx) || bubbleIdx < 0) {
      return c.json({ error: "bubbleIdx must be a non-negative integer" }, 400);
    }
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const emoji = typeof body?.emoji === "string" ? body.emoji.trim() : "";
    if (!emoji) return c.json({ error: "emoji required" }, 400);
    // v0.16 §4: reactions narrowed to 👍/👎. The sidecar shape still supports
    // arbitrary emoji (so old data round-trips), but new writes are
    // gated to keep the personal-research-log UX simple.
    const ALLOWED = new Set(["👍", "👎"]);
    if (!ALLOWED.has(emoji)) {
      return c.json({ error: "emoji must be 👍 or 👎" }, 400);
    }

    const current = await loadAnnotations(store.getWorkspace(), scope, id);
    const existing: MessageAnnotation = current.byBubbleIdx[String(bubbleIdx)] ?? {};
    const reactions = { ...(existing.reactions ?? {}) };
    if (reactions[emoji]) delete reactions[emoji];
    else reactions[emoji] = 1;
    const merged: MessageAnnotation = { ...existing };
    if (Object.keys(reactions).length === 0) delete merged.reactions;
    else merged.reactions = reactions;

    const next = { ...current.byBubbleIdx };
    if (Object.keys(merged).length === 0) delete next[String(bubbleIdx)];
    else next[String(bubbleIdx)] = merged;
    await saveAnnotations(store.getWorkspace(), scope, id, {
      version: 1,
      byBubbleIdx: next,
    });
    return c.json({ ok: true, bubbleIdx, reactions: merged.reactions ?? {} });
  });

  // GET <base>/:conversationId/usage  — token + context-window stats (v0.3 §19)
  app.get(`${basePath}/:conversationId/usage`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    // Prefer the *live* in-memory history so the meter updates during SSE
    // streams (disk flush only happens after the stream ends). Fall back to
    // disk for sessions that have been evicted from the LRU cache.
    const live = store.peekLiveHistory(scope, id);
    const history = live ?? (await store.readHistory(scope, id));
    if (history === null) {
      // Fresh / unknown conversation — report a zeroed usage so the SPA can
      // render the meter even before the first turn lands on disk.
      const fallbackModel = c.req.query("model") ?? undefined;
      const stats = computeUsageStats([], fallbackModel);
      return c.json(stats);
    }
    const fallbackModel = c.req.query("model") ?? undefined;
    const stats = computeUsageStats(history, fallbackModel);
    return c.json(stats);
  });

  // ─── v0.17 W12 (mathub parity): TODO tracker routes ─────────────────
  //
  // The `todo_write` built-in tool persists a per-conversation TODO list to
  // `<scopeDir>/<conversationId>.todos.json`. The SSE pump above emits a
  // `todos` event after each successful tool call so live streams stay in
  // sync; this GET endpoint covers the cold-start case (tab reload, switch
  // conversation) where the SPA needs to seed the panel before any stream
  // is running. A missing file returns an empty list — same semantics as
  // the rest of the chat surface.
  app.get(`${basePath}/:conversationId/todos`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    try {
      const list = await loadTodos(store.getWorkspace(), scope, id);
      return c.json(list);
    } catch (err: any) {
      return c.json({ error: String(err?.message ?? err) }, 500);
    }
  });
}

/** Register all three chat scopes + the legacy `/api/chat` alias. */
function registerChatRoutes(
  app: Hono,
  workspace: string,
  store: ScopedChatSessionStore,
): void {
  // global
  registerChatScope(app, store, "/api/global-chat", () => ({
    scope: { kind: "global" } as ChatScope,
  }));

  // project
  registerChatScope(app, store, "/api/projects/:slug/chat", (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return { error: "invalid project slug" };
    if (!fssync.existsSync(projectDirFor(workspace, slug))) {
      return { error: "project not found", status: 404 };
    }
    return { scope: { kind: "project", projectSlug: slug } as ChatScope };
  });

  // effort
  registerChatScope(app, store, "/api/projects/:slug/effort/:effortSlug/chat", (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug)) return { error: "invalid project slug" };
    if (!isSafeSlug(eff)) return { error: "invalid effort slug" };
    if (!fssync.existsSync(projectDirFor(workspace, slug))) {
      return { error: "project not found", status: 404 };
    }
    return {
      scope: { kind: "effort", projectSlug: slug, effortSlug: eff } as ChatScope,
    };
  });

  // ─── Legacy alias /api/chat ──→ redirected to /api/global-chat semantics.
  // We keep the SSE behavior wholesale to preserve v0.1.0-alpha SPA clients.
  registerChatScope(app, store, "/api/chat", () => ({
    scope: { kind: "global" } as ChatScope,
  }));
  // `/api/chat-sessions` alias too — returns global conversations.
  app.get("/api/chat-sessions", async (c) => {
    const conversations = await store.listConversations({ kind: "global" });
    return c.json({
      conversations,
      sessions: conversations.map((cv) => ({
        id: cv.id,
        lastUsedMs: Date.parse(cv.lastUsedAt),
        messageCount: cv.messageCount,
      })),
    });
  });
  app.delete("/api/chat-sessions/:id", async (c) => {
    const ok = await store.drop({ kind: "global" }, c.req.param("id"));
    return c.json({ dropped: ok });
  });
}

function buildApp(
  workspace: string,
  factory: ChatSessionFactory,
  goalLlmFactory?: GoalLLMFactory,
  mcpRegistry?: import("../core/mcp/registry.js").McpRegistry,
): { app: Hono; daemon: GoalDaemon | null } {
  // ── C3: Goal-daemon backend switch. ────────────────────────────────────
  //
  // Setting MATHRAN_DISABLE_GOAL_DAEMON=1 makes every goal HTTP endpoint
  // route through the v0.17 inline-runGoalRound code path that's lived
  // here for months — the daemon is constructed `null`, all
  // `daemon?.kickGoal(…)` branches short-circuit, and observable
  // behaviour is byte-identical to pre-C3 (this is the explicit opt-out
  // for production goals that were running mid-deploy).
  //
  // Unset / any other value enables the daemon path: each
  // /api/goals/:id/run* endpoint asks the daemon to manage the loop and
  // subscribes to its eventBus to forward frames onto SSE. The legacy
  // `inflightGoals` map is STILL maintained inside the runner factory
  // so /interrupt + /abort continue to work transparently regardless of
  // which path drove the round.
  const daemonDisabled = process.env.MATHRAN_DISABLE_GOAL_DAEMON === "1";
  // The actual GoalDaemon is constructed BELOW (after `inflightGoals`
  // exists and `buildProductionRunnerFactory` is defined) so the factory
  // can capture the closure. We hoist a typed `let` here so endpoint
  // handlers can reference `goalDaemon` symmetrically with the
  // daemonDisabled flag. When disabled, `goalDaemon` stays null and
  // every endpoint short-circuits to its v0.17 inline-runner path.
  let goalDaemon: GoalDaemon | null = null;
  if (daemonDisabled) {
    // eslint-disable-next-line no-console
    console.log("[mathran] goal daemon disabled via MATHRAN_DISABLE_GOAL_DAEMON=1");
  } else {
    // eslint-disable-next-line no-console
    console.log("[mathran] goal daemon enabled (set MATHRAN_DISABLE_GOAL_DAEMON=1 to opt out)");
  }
  const app = new Hono();
  // Adapt the test-friendly `ChatSessionFactory(opts)` to the store's
  // `ScopedChatSessionFactory({ scope, model })` signature. We pre-bind
  // the buildApp-scoped `autoRunGoal` lambda so the propose_goal builtin
  // tool can fire-and-forget a kickoff with all deps wired.
  const scopedFactory: ScopedChatSessionFactory = ({ scope, model, conversationId }) =>
    factory({ scope, model, conversationId, autoRunGoal, autoRunPlan });
  const sessions = new ScopedChatSessionStore(workspace, scopedFactory);

  // Per-goal AbortControllers for in-flight rounds. POST /interrupt aborts the
  // matching controller. Single-process only — a multi-process deployment would
  // need IPC (or the `<id>.stop` file-marker poll) to reach the right worker.
  const inflightGoals = new Map<string, AbortController>();

  // ── C3: Production GoalTurnRunner factory ──────────────────────────
  //
  // Called by `goalDaemon.kickGoal()` when a goal isn't yet running.
  // Constructs a fully-wired GoalTurnRunner whose iterationFn is
  // runOneIteration plus the same LLM / tools / abort / steerProbe /
  // todos-frame plumbing the v0.17 inline endpoints used. Every event
  // emitted by runOneIteration's `onEvent` is forwarded onto
  // `goalDaemon.eventBus` under `goal:<goalId>` so the SSE endpoint can
  // subscribe and pipe frames to the SPA in the legacy wire format.
  //
  // We deliberately re-build the LLM + tools per iteration (matches the
  // inline code path): the LLM provider holds streaming state, and the
  // current production providers are cheap to instantiate. If that
  // changes we'll memoise here.
  const buildProductionRunnerFactory = (): NonNullable<GoalDaemonOptions["runnerFactory"]> => {
    return (goalId, kickOpts) => {
      // Read the goal record once up-front so we know its budget +
      // scope + model. The runner re-reads inside each iteration
      // (runOneIteration does its own readGoal) so a status flip
      // between kick and first iteration is handled gracefully.
      // We swallow async errors here — the runner's pre-iteration
      // `isGoalStillActive` check will short-circuit if the goal
      // disappeared.
      const initialUserMessage =
        typeof kickOpts.userMessage === "string" && kickOpts.userMessage.trim().length > 0
          ? kickOpts.userMessage
          : undefined;

      const iterationFn: IterationFn = async ({ userMessage, steerText, signal, emit }) => {
        // Fresh goal read inside each iteration so budget caps + status
        // flips are honoured. Runner exits via isGoalStillActive below
        // if the goal disappeared between iterations.
        const g = await readGoal(workspace, goalId);
        if (!g) {
          // Goal vanished mid-loop — mark aborted so daemon exits.
          return {
            completed: false,
            failed: false,
            exhausted: false,
            aborted: true,
            endReason: "goal disappeared mid-loop",
          };
        }

        const cfg = loadConfig(configPathFor(workspace));
        const llm: LLMProvider = goalLlmFactory
          ? goalLlmFactory({ model: g.model })
          : new ModelRouter(cfg);
        const lean = new LocalLeanProvider();
        const tools = [createLeanCheckTool(lean)];

        // Per-iteration AbortController. Composed with the daemon's
        // signal (interrupt / abort / forceStop all flow through
        // `signal` already — see GoalTurnRunner.currentAbort). We
        // ALSO register the controller in `inflightGoals` so the
        // existing /interrupt + /abort endpoints can find it through
        // the legacy code path. The signal we pass to runOneIteration
        // is the daemon-supplied one; aborting `inflightGoals` entry
        // ALSO triggers it via the listener below.
        const iterController = new AbortController();
        const onParentAbort = () => iterController.abort();
        if (signal.aborted) iterController.abort();
        else signal.addEventListener("abort", onParentAbort, { once: true });
        inflightGoals.set(goalId, iterController);

        // Steer-probe wiring: register the per-iteration slot so
        // POST /api/goals/:id/steer (legacy chat-side
        // setPendingSteer) keeps working in-flight. Released in the
        // `finally` below.
        const steerConversationId = g.conversationIds[0] ?? null;
        const releaseSteerSlot = steerConversationId
          ? markStreamActive(steerConversationId)
          : () => undefined;

        try {
          // Re-read post-runner so the result reflects the latest
          // budget / status, mirroring the inline path.
          const r = await runOneIteration({
            workspace,
            goalId,
            userMessage,
            ...(steerText ? { steerText } : {}),
            llm,
            tools,
            builtinTools: GOAL_MODE_BUILTIN_TOOLS,
            toolContext: { workspace, scope: g.scope },
            signal: iterController.signal,
            bootstrapPlan: "auto",
            selfGrade: true,
            onEvent: (ev) => {
              // TODO-3 #4.H — feed inner ChatEvent into the daemon's
              // own emit (). That path:
              //   1. updates currentProgress (so the iteration-end
              //      snapshot has non-zero counts — was always 0,0,0,0
              //      before this fix because the eventBus side-channel
              //      skipped daemon.updateProgress entirely),
              //   2. calls daemon.opts.onEvent → eventBus → SSE clients.
              // We deliberately do NOT double-push to the eventBus
              // here; daemon.opts.onEvent already does that, and a
              // direct eventBus.emit would deliver each frame twice.
              emit(ev as DaemonEvent);
              // v0.17 W12: synthesise a `todos` frame after a
              // successful todo_write so the SPA's ActivePlanPanel
              // stays in sync. Same logic as the inline endpoint.
              if (
                (ev as { type?: string }).type === "tool-result" &&
                (ev as { name?: string }).name === "todo_write" &&
                (ev as { ok?: boolean }).ok
              ) {
                void (async () => {
                  try {
                    const fresh = await readGoal(workspace, goalId);
                    const cid =
                      fresh?.conversationIds[0] ?? steerConversationId ?? undefined;
                    if (!cid) return;
                    const list = await loadTodos(workspace, g.scope, cid);
                    if (goalDaemon) {
                      goalDaemon.eventBus.emit(`goal:${goalId}`, {
                        type: "todos",
                        list,
                      });
                    }
                  } catch {
                    /* best-effort */
                  }
                })();
              }
            },
            ...(steerConversationId
              ? { steerProbe: () => consumePendingSteer(steerConversationId) }
              : {}),
          });

          return {
            completed: r.completed,
            failed: r.failed,
            exhausted: r.exhausted,
            aborted: r.aborted,
            ...(r.naturalTurnEnd ? { naturalTurnEnd: true as const } : {}),
            ...(r.endReason ? { endReason: r.endReason } : {}),
          };
        } catch (err: unknown) {
          if (isAskUserPending(err)) {
            // Goal-mode auto-resolves ask_user inside the runner; if
            // we still see it surface here something's wrong with the
            // resolver wiring. Emit the legacy `ask_user` frame and
            // treat the iteration as aborted so the daemon parks.
            const e = err as { callId?: string; question?: string };
            if (goalDaemon) {
              goalDaemon.eventBus.emit(`goal:${goalId}`, {
                type: "ask_user",
                id: e.callId,
                name: "ask_user",
                question: e.question,
              });
            }
            return { completed: false, failed: false, exhausted: false, aborted: true, endReason: "ask_user surfaced (unexpected)" };
          }
          // Real error — mark goal failed (matches v0.17 inline) and
          // emit error frame on the eventBus.
          try {
            await endGoal(workspace, goalId, "failed", String((err as { message?: unknown })?.message ?? err));
          } catch {
            /* swallow */
          }
          if (goalDaemon) {
            goalDaemon.eventBus.emit(`goal:${goalId}`, {
              type: "error",
              message: String((err as { message?: unknown })?.message ?? err),
            });
          }
          return { completed: false, failed: true, exhausted: false, aborted: false, endReason: String((err as { message?: unknown })?.message ?? err) };
        } finally {
          signal.removeEventListener("abort", onParentAbort);
          // Only delete the inflight entry if it's still ours (a
          // concurrent kick may have replaced it on a new iteration).
          if (inflightGoals.get(goalId) === iterController) {
            inflightGoals.delete(goalId);
          }
          releaseSteerSlot();
        }
      };

      const runner = new GoalTurnRunner({
        goalId,
        // Iteration budget = goal.budget.roundsMax when known; the
        // runner re-reads goal each iteration so a CLI hand-edit of
        // budget.roundsMax also takes effect. We hand a generous
        // upper bound here for the daemon's own iteration counter
        // (it's a defence-in-depth against bugs that prevent
        // runOneIteration from ever returning a terminal flag);
        // 1024 is well above the largest production roundsMax.
        iterationBudget: 1024,
        iterIdleMs: 5_000,
        ...(initialUserMessage ? { initialUserMessage } : {}),
        iterationFn,
        onEvent: (ev: DaemonEvent) => {
          if (goalDaemon) {
            goalDaemon.eventBus.emit(`goal:${goalId}`, ev);
          }
        },
        isGoalStillActive: async () => {
          const g = await readGoal(workspace, goalId);
          return !!g && g.status === "active";
        },
      });
      return runner;
    };
  };

  // Construct the daemon now that the factory closure is ready.
  if (!daemonDisabled) {
    // **C6:** route iteration-level observability into
    // `~/.mathran/logs/daemon.log` (append-mode JSONL). Tests / CI can
    // opt out via MATHRAN_DAEMON_LOG=0 (or any falsy non-empty value);
    // a custom path is honoured via MATHRAN_DAEMON_LOG=/abs/path. The
    // file is opened lazily on the first iteration event so we don't
    // create directories during unit tests that never kick a goal.
    const daemonLogEnv = process.env.MATHRAN_DAEMON_LOG;
    const daemonLogDisabled =
      daemonLogEnv === "0" ||
      daemonLogEnv === "false" ||
      daemonLogEnv === "off" ||
      daemonLogEnv === "";
    const iterationLogPath = daemonLogDisabled
      ? undefined
      : daemonLogEnv && daemonLogEnv !== "1"
        ? daemonLogEnv
        : path.join(os.homedir(), ".mathran", "logs", "daemon.log");
    goalDaemon = new GoalDaemon({
      workspace,
      runnerFactory: buildProductionRunnerFactory(),
      ...(iterationLogPath ? { iterationLogPath } : {}),
    });
  }

  /**
   * v0.17 P2 — forward to the same `runGoalRound` machinery POST
   * /api/goals/:id/run uses, but fire-and-forget. Used by the `propose_goal`
   * chat-mode tool to auto-kickoff a goal the moment the user confirms.
   *
   * Captures buildApp's closure deps (config loader, goalLlmFactory,
   * `inflightGoals`, `LocalLeanProvider`, `runGoalRound`) so the
   * propose_goal tool itself can stay dep-light.
   *
   * Errors are swallowed and logged — the goal record IS persisted (the
   * tool wrote it before calling us) so the user can manually re-kick
   * from the goal panel if the background run dies.
   */
  const autoRunGoal = (goalId: string, userMessage: string): void => {
    // Fire the round in a microtask so the current chat tool-result
    // returns first, the SSE pump emits its `goal-proposed` frame, and
    // THEN the goal round starts (so the SPA gets the notification
    // *before* the goal panel starts streaming).
    void (async () => {
      try {
        const g = await readGoal(workspace, goalId);
        if (!g || g.status !== "active") return;
        await clearGoalAbortRequest(workspace, goalId);
        const cfg = loadConfig(configPathFor(workspace));
        const llm: LLMProvider = goalLlmFactory
          ? goalLlmFactory({ model: g.model })
          : new ModelRouter(cfg);
        const lean = new LocalLeanProvider();
        const tools = [createLeanCheckTool(lean)];
        const controller = new AbortController();
        inflightGoals.set(goalId, controller);
        try {
          await runGoalRound({
            workspace,
            goalId,
            userMessage,
            llm,
            tools,
            builtinTools: GOAL_MODE_BUILTIN_TOOLS,
            toolContext: { workspace, scope: g.scope },
            signal: controller.signal,
            bootstrapPlan: "auto",
            selfGrade: true,
          });
        } finally {
          inflightGoals.delete(goalId);
        }
      } catch (err: any) {
        // Best-effort: mark the goal failed so the SPA shows the right state.
        try {
          await endGoal(workspace, goalId, "failed", String(err?.message ?? err));
        } catch {
          /* swallow */
        }
      }
    })();
  };

  /**
   * v0.17 P2 — fire-and-forget plan-run kickoff. The `propose_plan`
   * builtin tool reserved a Plan record on disk and got a stable id;
   * we now drive `runPlan` and push frames into `planRuns` so the SPA
   * GET /api/plans/:planId/stream consumer (opened right after the
   * navigation triggered by the `plan-proposed` SSE frame) drains the
   * same in-memory queue as the manual POST /api/plans path.
   *
   * Best-effort: errors push an `error` frame onto the buffer; the
   * Plan record stays on disk so the panel still renders the draft.
   */
  const autoRunPlan = (planId: string, objective: string): void => {
    void (async () => {
      try {
        const cfg = loadConfig(configPathFor(workspace));
        const llm: LLMProvider = goalLlmFactory
          ? goalLlmFactory({})
          : new ModelRouter(cfg);
        const model = cfg.defaultModel ?? "copilot/gpt-5.5";
        const run = {
          planId,
          abort: new AbortController(),
          buffer: [] as any[],
          finished: false,
          waiters: [] as Array<() => void>,
        };
        planRuns.set(planId, run as any);
        const push = (frame: { event: string; data: any }) => {
          run.buffer.push(frame);
          const w = run.waiters.splice(0);
          for (const fn of w) {
            try { fn(); } catch { /* ignore */ }
          }
        };
        try {
          await runPlan({
            objective,
            workspace,
            llm,
            model,
            planId,
            abortSignal: run.abort.signal,
            onEvent: (ev) => {
              if (ev.type === "token") push({ event: "token", data: { delta: ev.delta } });
              else if (ev.type === "step") push({ event: "step", data: { round: ev.round, finishReason: ev.finishReason } });
              else if (ev.type === "done") push({ event: "done", data: { planId: ev.planId, body: ev.body, turns: ev.turns, truncated: ev.truncated, aborted: ev.aborted } });
              else if (ev.type === "error") push({ event: "error", data: { message: ev.message } });
            },
          });
        } catch (err: any) {
          push({ event: "error", data: { message: String(err?.message ?? err) } });
        } finally {
          run.finished = true;
          const w = run.waiters.splice(0);
          for (const fn of w) { try { fn(); } catch { /* ignore */ } }
        }
      } catch {
        /* best-effort: SPA shows partial body, user can manually rerun */
      }
    })();
  };

  app.get("/api/health", async (c) => {
    return c.json({ ok: true, version: await readPackageVersion(), workspace });
  });

  // MCP (#4): server status for the SPA "MCP Servers" panel (minimal — list +
  // status only, no config editing in v1). `POST …/reload` reconnects a server
  // (or all when `:name` is `all`).
  app.get("/api/mcp/servers", async (c) => {
    const registry = mcpRegistry ?? getGlobalMcpRegistry();
    return c.json({ servers: registry.status(), warnings: registry.getWarnings() });
  });
  app.post("/api/mcp/servers/:name/reload", async (c) => {
    const registry = mcpRegistry ?? getGlobalMcpRegistry();
    const name = c.req.param("name");
    if (name === "all") {
      const servers = await registry.reloadAll();
      return c.json({ ok: true, servers });
    }
    const info = await registry.reload(name);
    if (!info) return c.json({ error: `unknown mcp server "${name}"` }, 404);
    return c.json({ ok: true, server: info });
  });

  // v1.5 #5: MCP config editor — GET/PUT .mathran/mcp.json + POST test-connection.
  registerMcpConfigRoutes(app, {
    workspace,
    ...(mcpRegistry ? { mcpRegistry } : {}),
  });

  // #3 Background Agents — cooperative cancel: set the abort flag on a running
  // background subagent. The runner exits on its next signal checkpoint; status
  // flips to `cancelled` immediately so the next poll reflects it. 404 for an
  // unknown id; 409 if the run already reached a terminal state. (The matching
  // GET /api/subagents/active lives in slash-routes.ts alongside its `kinds`.)
  app.post("/api/subagents/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const registry = globalBackgroundRegistry();
    const record = registry.get(id);
    if (!record) {
      return c.json({ error: `unknown subagent "${id}"` }, 404);
    }
    const cancelled = registry.cancelSubagent(id);
    if (!cancelled) {
      return c.json(
        { error: `subagent "${id}" is not running (status: ${record.status})`, status: record.status },
        409,
      );
    }
    return c.json({ ok: true, id, status: "cancelled" });
  });

  // v0.17 mathub parity: file-upload endpoint for the SPA attachments flow.
  registerUploadRoutes(app, workspace);

  // Layered `.mathran/settings.json` editor surface for the SPA /settings page.
  registerSettingsRoutes(app, workspace);

  app.get("/api/projects", async (c) => {
    return c.json({ projects: await listProjects(workspace) });
  });

  app.post("/api/projects", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    try {
      const result = await initProject(name, { workspace });
      const project = await readProject(workspace, result.slug);
      return c.json(project ?? { slug: result.slug }, 201);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    const project = await readProject(workspace, slug);
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json(project);
  });

  // ─── Init-project agent (fs-only, DB-free) ─────────────────────────────────
  // Reuses the goalLlmFactory seam as the LLM source so tests can inject a fake
  // provider; falls back to a ModelRouter wired from <workspace>/config.toml.
  registerInitProjectRoutes(app, {
    workspace,
    llmFor: (model) =>
      goalLlmFactory
        ? goalLlmFactory({ model })
        : new ModelRouter(loadConfig(configPathFor(workspace))),
  });

  app.get("/api/projects/:slug/wiki", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    const pages = await listWiki(workspace, slug);
    if (pages === null) return c.json({ error: "project not found" }, 404);
    return c.json({ pages });
  });

  app.get("/api/projects/:slug/wiki/:page", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);
    const result = await readWikiPage(workspace, slug, page);
    if (!result) return c.json({ error: "page not found" }, 404);
    return c.json(result);
  });

  app.put("/api/projects/:slug/wiki/:page", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);
    if (!(await pathExists(projectDirFor(workspace, slug)))) {
      return c.json({ error: "project not found" }, 404);
    }
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body?.body !== "string") {
      return c.json({ error: "body (string) is required" }, 400);
    }
    // Optional v0.1.0 fields. Validate `parent` is a safe slug (no traversal).
    const parent = typeof body?.parent === "string" && body.parent.length > 0 ? body.parent : undefined;
    if (parent !== undefined && !isSafeSlug(parent)) {
      return c.json({ error: "invalid parent slug" }, 400);
    }
    const sortOrder = typeof body?.sortOrder === "number" && Number.isFinite(body.sortOrder)
      ? body.sortOrder
      : undefined;
    const title = typeof body?.title === "string" && body.title.length > 0 ? body.title : undefined;
    try {
      const result = await writeWikiPage(workspace, slug, page, body.body, { parent, sortOrder, title });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/wiki/:page/history", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);
    const versions = await listWikiHistory(workspace, slug, page);
    if (versions === null) return c.json({ error: "page not found" }, 404);
    return c.json({ page, versions });
  });

  app.get("/api/projects/:slug/wiki/:page/history/:version", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    const versionStr = c.req.param("version");
    const version = Number(versionStr);
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);
    if (!Number.isInteger(version) || version < 1) {
      return c.json({ error: "invalid version (must be positive integer)" }, 400);
    }
    const result = await readWikiPageVersion(workspace, slug, page, version);
    if (!result) return c.json({ error: "version not found" }, 404);
    return c.json(result);
  });

  /**
   * GAP #10: unified diff between two versions of a wiki page.
   *
   *   GET /api/projects/<slug>/wiki/<page>/diff?from=<v|current>&to=<v|current>
   *
   * Defaults: from=v(latest-history), to=current. Both `from` and `to` accept
   * either a positive integer (a history version) or the literal string
   * "current" (the live page body).
   *
   * Response: { page, from: {version, label}, to: {version, label}, patch }
   *   patch is a unified-diff string produced by `createTwoFilesPatch`. The
   *   client renders this with simple CSS highlighting.
   *
   * If either version cannot be resolved -> 404.
   */
  app.get("/api/projects/:slug/wiki/:page/diff", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);

    function parseVersionParam(raw: string | undefined): number | "current" | null {
      if (raw === undefined || raw === "" || raw === "current") return "current";
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) return null;
      return n;
    }

    const fromParam = c.req.query("from");
    const toParam = c.req.query("to");
    const to = parseVersionParam(toParam);
    if (to === null) return c.json({ error: "invalid 'to' version" }, 400);

    // For `from`, default to the most recent .history snapshot (if any).
    let from: number | "current" | null;
    if (fromParam !== undefined && fromParam !== "") {
      from = parseVersionParam(fromParam);
      if (from === null) return c.json({ error: "invalid 'from' version" }, 400);
    } else {
      const history = await listWikiHistory(workspace, slug, page);
      if (history === null) return c.json({ error: "page not found" }, 404);
      from = history.length > 0 ? (history[0].version as number) : "current";
    }

    const left = await readWikiVersionBody(workspace, slug, page, from);
    if (!left) return c.json({ error: `version not found: ${from}` }, 404);
    const right = await readWikiVersionBody(workspace, slug, page, to);
    if (!right) return c.json({ error: `version not found: ${to}` }, 404);

    const patch = createTwoFilesPatch(
      left.label,
      right.label,
      left.body,
      right.body,
      "",
      "",
      { context: 3 },
    );
    return c.json({
      page,
      from: { version: left.version, label: left.label },
      to: { version: right.version, label: right.label },
      patch,
    });
  });

  // ─── Effort REST (T1-B) ──────────────────────────────────────────────────────────────────
  app.get("/api/projects/:slug/efforts", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!(await pathExists(projectDirFor(workspace, slug)))) {
      return c.json({ error: "project not found" }, 404);
    }
    const efforts = await listEfforts(workspace, slug);
    return c.json({ efforts });
  });

  app.post("/api/projects/:slug/efforts", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const title = typeof body?.title === "string" ? body.title : "";
    const type = typeof body?.type === "string" ? body.type : "";
    if (!title) return c.json({ error: "title is required" }, 400);
    if (!isBuiltinEffortType(type)) {
      return c.json({ error: `type must be one of ${BUILTIN_EFFORT_TYPES.join(", ")}` }, 400);
    }
    const effortSlug = typeof body?.slug === "string" && body.slug.length > 0 ? body.slug : undefined;
    const description = typeof body?.description === "string" ? body.description : undefined;
    const force = body?.force === true;
    try {
      const result = await initEffort(workspace, slug, { title, type, slug: effortSlug, description, force });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/effort/:effortSlug", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    const meta = await readEffortMetadata(workspace, slug, eff);
    if (!meta) return c.json({ error: "effort not found" }, 404);
    return c.json({ effort: meta });
  });

  app.patch("/api/projects/:slug/effort/:effortSlug", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const patch: any = {};
    if (typeof body?.title === "string") patch.title = body.title;
    if (typeof body?.description === "string") patch.description = body.description;
    if (typeof body?.status === "string") patch.status = body.status;
    if (typeof body?.type === "string") patch.type = body.type;
    try {
      const updated = await updateEffortMetadata(workspace, slug, eff, patch);
      return c.json({ effort: updated });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/effort/:effortSlug/document", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    const doc = await readEffortDocument(workspace, slug, eff);
    if (doc === null) return c.json({ error: "effort not found" }, 404);
    return c.json({ effort: eff, document: doc });
  });

  app.put("/api/projects/:slug/effort/:effortSlug/document", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (typeof body?.document !== "string") return c.json({ error: "document (string) is required" }, 400);
    try {
      await writeEffortDocument(workspace, slug, eff, body.document);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/effort/:effortSlug/files", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    try {
      const files = await listEffortFiles(workspace, slug, eff);
      return c.json({ files });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  // file path uses a wildcard segment (`{ rest: "*" }` style) so we can capture
  // multi-segment relative paths like `proofs/lemma1.lean`.
  app.get("/api/projects/:slug/effort/:effortSlug/files/*", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    const url = new URL(c.req.url);
    const prefix = `/api/projects/${slug}/effort/${eff}/files/`;
    const relPath = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    try {
      const content = await readEffortFile(workspace, slug, eff, relPath);
      if (content === null) return c.json({ error: "file not found" }, 404);
      return c.json({ path: relPath, content });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.put("/api/projects/:slug/effort/:effortSlug/files/*", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    const url = new URL(c.req.url);
    const prefix = `/api/projects/${slug}/effort/${eff}/files/`;
    const relPath = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (typeof body?.content !== "string") return c.json({ error: "content (string) is required" }, 400);
    try {
      await writeEffortFile(workspace, slug, eff, relPath, body.content);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.post("/api/projects/:slug/effort/:effortSlug/snapshot", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    try {
      const version = await snapshotEffort(workspace, slug, eff);
      return c.json({ version });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/effort/:effortSlug/versions", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    try {
      const versions = await listSnapshots(workspace, slug, eff);
      return c.json({ versions });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  // ─── GAP #9: status state-machine + dependency graph ────────────────────

  /**
   * POST /api/projects/<slug>/effort/<eff>/status
   *   body: { to: <EffortStatus>, reason?: string, supersededBy?: string }
   *
   * Guarded transition (VALID_TRANSITIONS in src/core/effort/types.ts).
   * On invalid transition returns 400 with the allowed list. DEAD_END /
   * ERRATUM need `reason`; SUPERSEDED needs `supersededBy` (must exist in
   * the same project, not self). On SUPERSEDED a `supersedes` edge is auto-
   * added to the project's effort-relations log.
   */
  app.post("/api/projects/:slug/effort/:effortSlug/status", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const to = typeof body?.to === "string" ? body.to : "";
    if (!isEffortStatus(to)) {
      return c.json(
        { error: `'to' must be one of: ${EFFORT_STATUSES.join(", ")}` },
        400,
      );
    }
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    const supersededBy = typeof body?.supersededBy === "string" ? body.supersededBy : undefined;
    if (supersededBy && !isSafeSlug(supersededBy)) {
      return c.json({ error: "invalid 'supersededBy' slug" }, 400);
    }
    const r = await transitionEffortStatus(workspace, slug, eff, { to, reason, supersededBy });
    if (r.ok) return c.json({ metadata: r.metadata, entry: r.entry });
    if (r.reason === "not-found") return c.json({ error: "effort not found" }, 404);
    if (r.reason === "invalid-transition") {
      return c.json(
        {
          error: `invalid transition: ${r.from} → ${to}`,
          from: r.from,
          to,
          allowed: r.allowed,
        },
        400,
      );
    }
    if (r.reason === "missing-reason") {
      return c.json({ error: `'${r.field}' is required for transition to ${to}` }, 400);
    }
    if (r.reason === "supersedes-self") {
      return c.json({ error: "an effort cannot supersede itself" }, 400);
    }
    if (r.reason === "supersededBy-not-found") {
      return c.json({ error: `supersededBy effort not found in project: ${r.slug}` }, 404);
    }
    return c.json({ error: "unknown transition error" }, 400);
  });

  /**
   * POST /api/projects/<slug>/effort/<eff>/relations
   *   body: { to: <effortSlug>, type: RelationType,
   *           description?: string, confidence?: number,
   *           source?: "user"|"llm"|"spine" }
   *
   * Appends one edge to the project's `efforts/.relations.jsonl`. The from-
   * side is taken from the URL. Both endpoints must exist; the type must be
   * one of VALID_RELATION_TYPES.
   */
  app.post("/api/projects/:slug/effort/:effortSlug/relations", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const to = typeof body?.to === "string" ? body.to : "";
    const type = typeof body?.type === "string" ? body.type : "";
    if (!isSafeSlug(to)) return c.json({ error: "'to' must be a valid effort slug" }, 400);
    if (!(VALID_RELATION_TYPES as readonly string[]).includes(type)) {
      return c.json({ error: `'type' must be one of: ${VALID_RELATION_TYPES.join(", ")}` }, 400);
    }
    if (to === eff) {
      return c.json({ error: "an effort cannot relate to itself" }, 400);
    }
    // Both endpoints must exist.
    if (!(await readEffortMetadata(workspace, slug, eff))) {
      return c.json({ error: "effort not found" }, 404);
    }
    if (!(await readEffortMetadata(workspace, slug, to))) {
      return c.json({ error: `target effort not found: ${to}` }, 404);
    }
    const description = typeof body?.description === "string" ? body.description : undefined;
    const confidence = typeof body?.confidence === "number" ? body.confidence : undefined;
    const source =
      body?.source === "user" || body?.source === "llm" || body?.source === "spine"
        ? body.source
        : undefined;
    const edge = await addRelation(workspace, slug, {
      from: eff,
      to,
      type: type as RelationType,
      description,
      confidence,
      source,
    });
    return c.json({ relation: edge }, 201);
  });

  /** GET edges where from=<eff>. */
  app.get("/api/projects/:slug/effort/:effortSlug/relations", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    const out = await listEffortRelations(workspace, slug, eff);
    return c.json({ relations: out });
  });

  /** GET edges where to=<eff> ("who depends on me?"). */
  app.get("/api/projects/:slug/effort/:effortSlug/dependents", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    const out = await listEffortDependents(workspace, slug, eff);
    return c.json({ dependents: out });
  });

  /** GET every edge in the project (for graph rendering). */
  app.get("/api/projects/:slug/efforts/graph", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    const edges = await listAllRelations(workspace, slug);
    return c.json({ edges });
  });

  /** DELETE one edge by id. */
  app.delete("/api/projects/:slug/effort/:effortSlug/relations/:relationId", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    const relationId = c.req.param("relationId");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    if (!relationId) return c.json({ error: "relation id required" }, 400);
    const removed = await removeRelation(workspace, slug, relationId);
    if (!removed) return c.json({ error: "relation not found" }, 404);
    return c.body(null, 204);
  });

  // ─── GAP #11: long-running goal runs ──────────────────────────────

  /**
   * Validate a scope object coming over the wire. Returns the parsed scope
   * or `null` (with an error message) on failure. We require *all* slugs to
   * pass `isSafeSlug` to keep the BUG #5 traversal defence intact.
   */
  function parseGoalScope(raw: any): { ok: true; scope: ChatScope } | { ok: false; error: string } {
    if (!raw || raw === "global") return { ok: true, scope: { kind: "global" } };
    if (typeof raw === "string") {
      if (raw === "global") return { ok: true, scope: { kind: "global" } };
      return { ok: false, error: "scope must be an object or 'global'" };
    }
    if (typeof raw !== "object") return { ok: false, error: "scope must be an object" };
    const kind = raw.kind;
    if (kind === "global") return { ok: true, scope: { kind: "global" } };
    if (kind === "project") {
      const projectSlug = String(raw.projectSlug ?? "");
      if (!isSafeSlug(projectSlug)) return { ok: false, error: "invalid projectSlug" };
      return { ok: true, scope: { kind: "project", projectSlug } };
    }
    if (kind === "effort") {
      const projectSlug = String(raw.projectSlug ?? "");
      const effortSlug = String(raw.effortSlug ?? "");
      if (!isSafeSlug(projectSlug) || !isSafeSlug(effortSlug)) {
        return { ok: false, error: "invalid projectSlug or effortSlug" };
      }
      return { ok: true, scope: { kind: "effort", projectSlug, effortSlug } };
    }
    return { ok: false, error: `unknown scope kind: ${String(kind)}` };
  }

  /** Loose UUID-ish id check for goal ids over the wire. */
  function isSafeGoalId(s: string): boolean {
    return /^[a-zA-Z0-9_\-]{8,64}$/.test(s);
  }

  /**
   * POST /api/goals
   *   body: { objective, scope?, model?, budgetTokens?, maxRounds? }
   *
   * Creates the goal record on disk and returns it. Does *not* drive the
   * first round (clients post to /api/goals/:id/run for that, so they can
   * stream events the same way as plain chat).
   */
  app.post("/api/goals", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const objective = typeof body?.objective === "string" ? body.objective : "";
    if (!objective.trim()) return c.json({ error: "'objective' is required" }, 400);
    const parsed = parseGoalScope(body?.scope);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const cfg = loadConfig(configPathFor(workspace));
    const model = typeof body?.model === "string" ? body.model : cfg.defaultModel ?? DEFAULT_MODEL;
    // v0.17 W11: per-scope autonomy defaults fill in missing budgets.
    //
    // goal-defaults-timer (2026-06-23): DEFAULT_GOAL_AUTONOMY now carries
    // explicit `defaultMaxRounds=200 / defaultTokensCap=12.8M`, so the
    // effective merge always has both fields. We use them directly here
    // and drop the old `layerHas` guard that required a project/global
    // layer to be on-disk — that guard was the reason a freshly-created
    // goal still came out with `budget: { tokensMax: null, roundsMax: null }`
    // even after the worker bumped the defaults. The pre-W11 sse-round-start
    // test that asserted "no caller budget = uncapped" was updated alongside.
    const auto = await loadGoalAutonomy({ workspace }).catch(() => null);
    const effRounds = auto?.effective.defaultMaxRounds;
    const effTokens = auto?.effective.defaultTokensCap;
    // goal-defaults-timer (part 3/3): the create-goal modal's third
    // field. Coerce string → trimmed string → undefined when empty so
    // createGoal's defensive blank-strip is symmetric with what we
    // accept here. Anything non-string (number, array, object) is
    // ignored rather than 400'd — future-friendly to clients that
    // might pass structured hints we don't yet understand.
    const rawExtra = typeof body?.extraInstructions === "string" ? body.extraInstructions : "";
    const extraInstructions = rawExtra.trim().length > 0 ? rawExtra : undefined;
    const goal = await createGoal(workspace, {
      objective,
      scope: parsed.scope,
      model,
      budgetTokensMax:
        typeof body?.budgetTokens === "number" && body.budgetTokens > 0
          ? body.budgetTokens
          : (typeof effTokens === "number" && effTokens > 0 ? effTokens : null),
      budgetRoundsMax:
        typeof body?.maxRounds === "number" && body.maxRounds > 0
          ? body.maxRounds
          : (typeof effRounds === "number" && effRounds > 0 ? effRounds : null),
      extraInstructions,
    });
    return c.json({ goal }, 201);
  });

  /**
   * **C6:** GET /api/goals/daemon/status — ops/observability endpoint.
   *
   * Returns a structured snapshot of the GoalDaemon's current state:
   *   - enabled / stopped flags
   *   - configured maxConcurrent + iterIdleMs
   *   - runnerCount + queueLength (queue length is reserved — the
   *     current daemon doesn't enforce a hard concurrency cap, see
   *     design doc §7 risk #9)
   *   - per-runner rows: goalId, startedAt, iterations, lastEventAt,
   *     state, source (when known)
   *   - iterationLogPath (when iteration JSONL log is wired)
   *
   * When the daemon is disabled (MATHRAN_DAEMON=0 in tests/CI) returns
   * a stub with enabled=false so callers can still detect liveness.
   *
   * Design doc: ~/.openclaw/workspace/_tasks/todo1-design.md §8 C6.
   */
  app.get("/api/goals/daemon/status", (c) => {
    if (!goalDaemon) {
      return c.json({
        enabled: false,
        stopped: true,
        maxConcurrent: 0,
        iterIdleMs: 0,
        runnerCount: 0,
        queueLength: 0,
        runners: [],
        running: [],
        iterations: {},
      });
    }
    return c.json(goalDaemon.status());
  });

  // ─── NEW-F5: /healthz + /metrics (audit 2026-06-24) ───────────────────
  // /healthz: cheap liveness probe — returns 200 + JSON body always (even
  // when the daemon is disabled), so a supervisor (systemd, k8s, etc.)
  // can ping every few seconds without a daemon dependency.
  // /metrics: Prometheus-formatted snapshot of useful counters/gauges so
  // a separate `prometheus + grafana` stack can build dashboards.
  const serveBootMs = Date.now();
  app.get("/healthz", async (c) => {
    let activeGoals = 0;
    try {
      const all = await listGoals(workspace);
      activeGoals = all.filter((g) => g.status === "active").length;
    } catch {
      // listGoals failure is non-fatal for /healthz — keep returning 200.
    }
    return c.json({
      ok: true,
      daemon: goalDaemon ? { enabled: true, stopped: false } : { enabled: false },
      activeGoals,
      uptimeMs: Date.now() - serveBootMs,
      ts: new Date().toISOString(),
    });
  });

  app.get("/metrics", async (c) => {
    // Prometheus text exposition format 0.0.4. Keep cardinality LOW —
    // labels with goal IDs would explode storage. We only emit per-status
    // gauges + a few process-wide counters.
    let goals: Goal[] = [];
    try {
      goals = await listGoals(workspace);
    } catch {
      // empty
    }
    const byStatus: Record<string, number> = {};
    for (const g of goals) {
      byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
    }
    const lines: string[] = [];
    lines.push("# HELP mathran_goals_total Number of goals in the workspace, by status.");
    lines.push("# TYPE mathran_goals_total gauge");
    for (const s of ["active", "paused", "complete", "failed", "cancelled", "exhausted"]) {
      lines.push(`mathran_goals_total{status="${s}"} ${byStatus[s] ?? 0}`);
    }
    lines.push("# HELP mathran_daemon_enabled 1 if the goal daemon is running, 0 otherwise.");
    lines.push("# TYPE mathran_daemon_enabled gauge");
    lines.push(`mathran_daemon_enabled ${goalDaemon ? 1 : 0}`);
    lines.push("# HELP mathran_uptime_ms Milliseconds since `mathran serve` started.");
    lines.push("# TYPE mathran_uptime_ms gauge");
    lines.push(`mathran_uptime_ms ${Date.now() - serveBootMs}`);
    if (goalDaemon) {
      const st = goalDaemon.status();
      lines.push("# HELP mathran_daemon_runners Active runner count in the goal daemon.");
      lines.push("# TYPE mathran_daemon_runners gauge");
      lines.push(`mathran_daemon_runners ${st.runnerCount ?? 0}`);
      lines.push("# HELP mathran_daemon_queue_length Queued (waiting) goal kick count.");
      lines.push("# TYPE mathran_daemon_queue_length gauge");
      lines.push(`mathran_daemon_queue_length ${st.queueLength ?? 0}`);
    }
    // Total tokens spent across active+complete goals — useful for cost.
    let totalTokens = 0;
    let totalIterations = 0;
    let totalCompactionRuns = 0;
    for (const g of goals) {
      totalTokens += g.stats.tokensUsed ?? 0;
      totalIterations += g.stats.iterationsRun ?? 0;
      totalCompactionRuns += g.stats.compactionRuns ?? 0;
    }
    lines.push("# HELP mathran_tokens_total Sum of stats.tokensUsed across all goals.");
    lines.push("# TYPE mathran_tokens_total counter");
    lines.push(`mathran_tokens_total ${totalTokens}`);
    lines.push("# HELP mathran_iterations_total Sum of stats.iterationsRun across all goals.");
    lines.push("# TYPE mathran_iterations_total counter");
    lines.push(`mathran_iterations_total ${totalIterations}`);
    lines.push("# HELP mathran_compaction_runs_total Sum of stats.compactionRuns across all goals.");
    lines.push("# TYPE mathran_compaction_runs_total counter");
    lines.push(`mathran_compaction_runs_total ${totalCompactionRuns}`);
    // Phase ζ (cost meter) — per-model dollar cost summed across all goals.
    // Keyed by model slug (LOW cardinality: a workspace uses a handful of
    // models). We SKIP any goal whose model has no verifiable public price
    // (computeGoalCostUsd → null) rather than emit a fake $0.00 under
    // model="unknown". When no priced model is present the series is omitted
    // entirely. DESIGN-REFERENCE.md §5.E.
    const costByModel: Record<string, number> = {};
    for (const g of goals) {
      const cost = computeGoalCostUsd(g);
      if (cost === null) continue;
      costByModel[g.model] = (costByModel[g.model] ?? 0) + cost;
    }
    const costModels = Object.keys(costByModel).sort();
    if (costModels.length > 0) {
      lines.push("# HELP mathran_cost_usd_total Estimated USD cost summed across all goals, by model.");
      lines.push("# TYPE mathran_cost_usd_total counter");
      for (const m of costModels) {
        lines.push(`mathran_cost_usd_total{model="${promLabel(m)}"} ${costByModel[m]}`);
      }
    }
    return new Response(lines.join("\n") + "\n", {
      status: 200,
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  });

  /** GET /api/goals?all=1 — default lists active+paused only. */
  app.get("/api/goals", async (c) => {
    const all = c.req.query("all") === "1" || c.req.query("all") === "true";
    const goals = await listGoals(workspace);
    const filtered = all
      ? goals
      : goals.filter((g: Goal) => g.status === "active" || g.status === "paused");
    return c.json({ goals: filtered });
  });

  app.get("/api/goals/:goalId", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    return c.json({ goal: g });
  });

  // ─── Thread endpoints (v0.16 §3) ─────────────────────────────────────────
  // Goal-mode sub-goals are mathran's threads: a `spawn_sub_goal` tool
  // call creates a child Goal record with its own conversation. These
  // endpoints let the SPA navigate that tree without scraping audit logs.

  /**
   * Find which Goal owns a given conversationId (top-level lookup so the
   * chat panel knows whether the conversation it's rendering is a
   * goal-mode run or a plain chat). Returns 404 when no goal references
   * the conversation — the caller should treat this as "not a goal".
   */
  app.get("/api/goals/by-conversation/:conversationId", async (c) => {
    const conversationId = c.req.param("conversationId");
    if (!isSafeSlug(conversationId)) {
      return c.json({ error: "invalid conversation id" }, 400);
    }
    // O(N) scan; acceptable because the goal directory is tiny in
    // practice (single-user app, dozens at most). If this ever grows we
    // add a goals-by-conversation index file.
    const all = await listGoals(workspace);
    const owner = all.find((g) => g.conversationIds.includes(conversationId));
    if (!owner) return c.json({ error: "no goal owns this conversation" }, 404);
    return c.json({ goalId: owner.id, goal: owner });
  });

  /**
   * One-shot "open this thread" payload: the goal record, every sub-goal
   * stub (id/status/objective/parent), and the primary conversation's
   * full chat history. The SPA uses this to render a Thread drawer
   * without three sequential round-trips.
   *
   * Sub-goals are returned shallow (their conversation history is *not*
   * inlined) because a deep tree blows up payload size; the SPA opens
   * each sub-thread lazily by calling /thread again with that sub-goal's
   * id when the user clicks in.
   */
  app.get("/api/goals/:goalId/thread", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const goal = await readGoal(workspace, goalId);
    if (!goal) return c.json({ error: "not found" }, 404);

    // Primary conversation history. A goal with no rounds run yet (rare,
    // happens between createGoal and the first runRound) has an empty
    // conversationIds list; we surface an empty history in that case so
    // the SPA doesn't error out.
    const primaryConvId = goal.conversationIds[0];
    let history: any[] = [];
    if (primaryConvId) {
      history = await loadConversationHistory(workspace, goal.scope, primaryConvId);
    }

    // Shallow sub-goal stubs. We deliberately project a small set of
    // fields so the response stays compact — the SPA only needs enough
    // to render the tree node, not to replay it.
    const subGoalIds = goal.subGoalIds ?? [];
    const subGoals: Array<{
      id: string;
      objective: string;
      status: string;
      parentGoalId: string | null;
      endReason: string | null;
      conversationId: string | null;
      roundsRun: number;
      iterationsRun: number;
      assistantTurnsTotal: number;
      tokensUsed: number;
    }> = [];
    for (const subId of subGoalIds) {
      const sg = await readGoal(workspace, subId);
      if (!sg) continue;
      subGoals.push({
        id: sg.id,
        objective: sg.objective,
        status: sg.status,
        parentGoalId: sg.parentGoalId ?? null,
        endReason: sg.endReason ?? null,
        conversationId: sg.conversationIds[0] ?? null,
        roundsRun: sg.stats.roundsRun,
        iterationsRun: sg.stats.iterationsRun,
        assistantTurnsTotal: sg.stats.assistantTurnsTotal,
        tokensUsed: sg.stats.tokensUsed,
      });
    }

    return c.json({
      goal,
      primaryConversationId: primaryConvId ?? null,
      history,
      subGoals,
    });
  });

  /**
   * GET /api/goals/:rootId/tree — W10 (v0.17 mathub parity).
   *
   * Returns a flat array of every goal reachable from `rootId` via the
   * `parentGoalId` chain (root included), in pre-order. Each node carries
   * the minimum the SPA's SubagentTreePanel needs to render a node row
   * and its status dot: id, parentId, a display `name`, lifecycle status,
   * cumulative tokens used, and (when terminal-but-not-clean) the
   * `endReason` surfaced as `errorMessage`.
   *
   * The `status` enum here is the SPA-facing one and folds `Goal.status`
   * into five buckets: `running` (active goal, currently being driven),
   * `done` (complete), `failed` (failed | cancelled), `aborted`
   * (exhausted — budget tripped), `pending` (paused, no rounds yet).
   * This is a UI shape — the underlying record keeps the richer status.
   *
   * O(N) over the goals directory; acceptable because the goal directory
   * is tiny in practice.
   */
  app.get("/api/goals/:rootId/tree", async (c) => {
    const rootId = c.req.param("rootId");
    if (!isSafeGoalId(rootId)) return c.json({ error: "invalid rootId" }, 400);
    const root = await readGoal(workspace, rootId);
    if (!root) return c.json({ error: "not found" }, 404);

    // Scan once, bucket by parentGoalId. Cheap with the goals dir size we
    // expect (single-user app), and gives O(1) descendant lookup below.
    const all = await listGoals(workspace);
    const childrenByParent = new Map<string, Goal[]>();
    for (const g of all) {
      const pid = g.parentGoalId ?? null;
      if (pid === null) continue;
      const arr = childrenByParent.get(pid);
      if (arr) arr.push(g);
      else childrenByParent.set(pid, [g]);
    }
    // Stable creation-order within a parent so the SPA's recursive
    // renderer doesn't reshuffle rows between polls.
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    }

    type TreeNode = {
      id: string;
      parentId: string | null;
      name: string;
      status: "pending" | "running" | "done" | "failed" | "aborted";
      tokensUsed: number;
      errorMessage?: string;
    };
    function toStatus(g: Goal): TreeNode["status"] {
      switch (g.status) {
        case "active":
          // A freshly-created goal that's never run a round is rendered
          // as `pending`; once any iteration records stats it's `running`.
          return g.stats.iterationsRun === 0 ? "pending" : "running";
        case "paused":
          return "pending";
        case "complete":
          return "done";
        case "failed":
        case "cancelled":
          return "failed";
        case "exhausted":
          return "aborted";
        default:
          return "pending";
      }
    }
    function nameFor(g: Goal): string {
      const obj = g.objective.trim();
      return obj.length <= 60 ? obj : obj.slice(0, 60).trimEnd() + "…";
    }

    const out: TreeNode[] = [];
    const seen = new Set<string>();
    function walk(g: Goal): void {
      if (seen.has(g.id)) return; // cycle guard — should never happen
      seen.add(g.id);
      const node: TreeNode = {
        id: g.id,
        parentId: g.parentGoalId ?? null,
        name: nameFor(g),
        status: toStatus(g),
        tokensUsed: g.stats.tokensUsed ?? 0,
      };
      // Only surface `endReason` as an error tooltip for the failed
      // bucket — "done" goals also have an endReason (the mark_done
      // text) and we don't want it lighting up as red.
      if ((node.status === "failed" || node.status === "aborted") && g.endReason) {
        node.errorMessage = g.endReason;
      }
      out.push(node);
      const kids = childrenByParent.get(g.id);
      if (kids) for (const k of kids) walk(k);
    }
    walk(root);
    return c.json({ nodes: out });
  });

  /**
   * GET /api/goals/:goalId/plan — v0.16 §9 audit #6.
   *
   * Returns the goal's active plan (parsed) so the SPA can render it in
   * the thread drawer. Two distinct "no plan" states share a 200 response:
   *
   *   • `hasPlan: false` + `body: null` + empty `steps` — the goal exists
   *     but no plan file has been written yet (sub-goal, bootstrap opted
   *     out, or bootstrap failed). The SPA renders a quiet placeholder
   *     rather than an error.
   *   • Goal itself missing → 404 (mirrors the rest of /api/goals/:id).
   *
   * `steps` mirrors `PlanStep` from src/core/goal/plan.ts (1-based global
   * index, status `todo`/`done`, text, source line). The SPA renders the
   * raw markdown body but also has the parsed steps available for any
   * future interactive checkbox UI.
   */
  app.get("/api/goals/:goalId/plan", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const goal = await readGoal(workspace, goalId);
    if (!goal) return c.json({ error: "not found" }, 404);

    const body = await readGoalPlan(workspace, goalId);
    if (body === null) {
      return c.json({
        hasPlan: false,
        planPath: null,
        body: null,
        steps: [],
      });
    }
    const steps = parsePlanSteps(body);
    return c.json({
      hasPlan: true,
      // Prefer the stamped `goal.planPath` for display (it's relative to
      // workspace and matches what the goal record advertises), but fall
      // back to the canonical relative path so older records that never
      // ran a round under W4+ still render correctly.
      planPath: goal.planPath ?? goalPlanRelPath(goalId),
      body,
      steps,
    });
  });

  // ─── F8: GET /api/goals/:id/files-changed ────────────────────────────
  // Returns a deduplicated list of files this goal has written/edited,
  // newest-first. Pure read of goal.steps[]; cheap to poll alongside
  // /status. Empty list (and 200) for a goal that exists but has no
  // write tool calls yet, so the SPA can render an empty state without
  // distinguishing 404 from "no writes".
  app.get("/api/goals/:goalId/files-changed", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const goal = await readGoal(workspace, goalId);
    if (!goal) return c.json({ error: "not found" }, 404);
    const { extractFilesChanged } = await import("../core/goal/files-changed.js");
    const entries = extractFilesChanged(goal);
    return c.json({ goalId, count: entries.length, entries });
  });

  // ─── F7: POST /api/goals/:id/ask ─────────────────────────────────────
  // Natural-language status query against a goal. Body: {question}.
  // Builds a read-only context bundle (id, status, stats, plan body,
  // files-changed, last 25 audit steps) and asks the goal's model a
  // one-shot question. Streams text back to the caller as a plain text
  // response (Server-Sent Events would be overkill for a one-shot Q&A
  // — the SPA can show a loading state then render the answer when
  // the response finishes).
  //
  // Does NOT mutate goal state, does NOT push to conversation history,
  // does NOT spawn a runner. Pure read + one LLM call.
  app.post("/api/goals/:goalId/ask", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const goal = await readGoal(workspace, goalId);
    if (!goal) return c.json({ error: "not found" }, 404);
    let body: { question?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body; expected {question: string}" }, 400);
    }
    const question = (body.question ?? "").trim();
    if (!question) return c.json({ error: "question is required" }, 400);
    if (question.length > 4000) return c.json({ error: "question too long (>4000 chars)" }, 400);

    // Best-effort plan body load (silently skipped on miss).
    let planBody = "";
    try {
      const loaded = await readGoalPlan(workspace, goalId);
      if (loaded) planBody = loaded;
    } catch {
      // skip
    }

    const { buildGoalAskContext } = await import("../core/goal/ask.js");
    const context = buildGoalAskContext(goal, { planBody });

    // Resolve LLM + model the same way other endpoints do — defer to
    // the router so the goal's model selection is honoured.
    const config = loadConfig(configPathFor(workspace));
    const llm = new ModelRouter(config);
    const messages = [
      { role: "system" as const, content: context },
      { role: "user" as const, content: question },
    ];
    try {
      const res = await llm.chat({ model: goal.model, messages });
      let answer = "";
      for await (const chunk of res.stream()) {
        if (chunk.type === "text" && typeof chunk.delta === "string") answer += chunk.delta;
      }
      return c.json({
        goalId,
        question,
        answer: answer.trim(),
        model: goal.model,
      });
    } catch (err: any) {
      return c.json({ error: String(err?.message ?? err) }, 500);
    }
  });

  /**
   * POST /api/goals/:id/run
   *   body: { message?: string }
   *
   * Drive exactly one round of work. The request blocks until the round
   * finishes (or budget trips, or DONE: / GIVE_UP: marker fires). Tools
   * available are the same ones the chat surface gets (currently just
   * `lean_check`).
   */
  app.post("/api/goals/:goalId/run", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    if (g.status !== "active") {
      return c.json({ error: `goal is ${g.status}; not runnable` }, 400);
    }
    let body: any = {};
    try { body = await c.req.json(); } catch { /* empty body is fine */ }
    // C9: empty / blank body → undefined userMessage. Symmetric with
    // /run/stream below; lets `runOneIteration` emit a `[daemon: continue]`
    // nudge instead of materialising a fake user turn in the
    // conversation. See todo1-design.md §6.2.
    const userMessage: string | undefined =
      typeof body?.message === "string" && body.message.trim().length > 0
        ? body.message
        : undefined;

    // v0.17 W8: clear any stale abortRequested flag from a previous round
    // (e.g. the user clicked Abort then Resume / Run). The runner checks
    // this flag at round-top and bails out as aborted, so we MUST clear
    // it before driving the round or the very first iteration will
    // immediately abort itself.
    await clearGoalAbortRequest(workspace, goalId);

    const cfg = loadConfig(configPathFor(workspace));
    const llm: LLMProvider = goalLlmFactory
      ? goalLlmFactory({ model: g.model })
      : new ModelRouter(cfg);
    const lean = new LocalLeanProvider();
    const tools = [createLeanCheckTool(lean)];

    // Register an AbortController so POST /interrupt can stop this round.
    const controller = new AbortController();
    inflightGoals.set(goalId, controller);
    try {
      // C9: call runOneIteration directly (not runGoalRound) so an
      // `undefined` userMessage stays undefined instead of falling back
      // to the legacy fake-continue sentinel inside the wrapper.
      // `/run/stream` already takes this path through the daemon; we
      // keep the two endpoints symmetric.
      const r = await runOneIteration({
        workspace,
        goalId,
        userMessage,
        llm,
        tools,
        builtinTools: GOAL_MODE_BUILTIN_TOOLS,
        toolContext: { workspace, scope: g.scope },
        signal: controller.signal,
        // v0.16 §9 audit #4: opt into the plan bootstrap. The HTTP server
        // drives the SPA; goals here are real user goals (not test runs),
        // so spending one upfront `runPlan` round is a good trade for
        // grounding every subsequent round in a stable checklist.
        bootstrapPlan: "auto",
        selfGrade: true,
      });
      return c.json({
        goal: r.goal,
        text: r.text,
        completed: r.completed,
        failed: r.failed,
        exhausted: r.exhausted,
        aborted: r.aborted,
        endReason: r.endReason,
      });
    } catch (err: any) {
      await endGoal(workspace, goalId, "failed", String(err?.message ?? err));
      return c.json({ error: String(err?.message ?? err) }, 500);
    } finally {
      inflightGoals.delete(goalId);
    }
  });

  /**
   * POST /api/goals/:id/run/stream
   *   body: { message?: string }
   *
   * v0.17 mathub parity W7 — SSE-streaming variant of `POST /run`.
   *
   * Identical scheduling semantics to `/run` (one round per request,
   * cooperative-abort check, plan bootstrap, AbortController registration),
   * BUT the inner `ChatSession.send` events are forwarded onto the response
   * stream as `text:` / `tool-call:` / `tool-result:` / `ask_user:` /
   * `done:` SSE frames, plus a leading `round-start:` frame the goal runner
   * synthesises so the SPA's AgentStatusPanel can render `🔄 Step N/MAX`
   * before the model has produced its first token. A terminal `result:`
   * frame carries the same JSON envelope the non-streaming `/run` endpoint
   * returns, so callers don't need a second round-trip to find out whether
   * the goal completed / failed / exhausted.
   *
   * The legacy JSON endpoint is preserved unchanged so existing CLI / SPA
   * callers (`runGoalRound` in `web/src/lib/chat.ts`) keep working without
   * a coordinated migration.
   */
  app.post("/api/goals/:goalId/run/stream", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    if (g.status !== "active") {
      return c.json({ error: `goal is ${g.status}; not runnable` }, 400);
    }
    let body: any = {};
    try { body = await c.req.json(); } catch { /* empty body is fine */ }
    // C9: when the SPA / CLI client sends an empty / blank message body,
    // hand `undefined` to the runner. `runOneIteration` (see runner.ts
    // §C2-1) then synthesises a minimal internal `[daemon: continue]`
    // nudge instead of injecting the historical fake
    // `"Continue with the current objective."` user turn — completing
    // todo1-design.md §6.2 (the C7 script migrated existing on-disk
    // fake-continue rows; this stops new ones from being generated).
    // Real user messages (non-empty trimmed string) flow through
    // unchanged.
    const userMessage: string | undefined =
      typeof body?.message === "string" && body.message.trim().length > 0
        ? body.message
        : undefined;

    await clearGoalAbortRequest(workspace, goalId);

    // ── C3: Daemon-mode branch ────────────────────────────────────
    //
    // When MATHRAN_DISABLE_GOAL_DAEMON is unset, this request opens an
    // SSE stream subscribed to `goalDaemon.eventBus.on('goal:<id>')` and
    // asks the daemon to kick the loop. The daemon owns the runner
    // lifetime now — the SSE handler just slices off this request's
    // portion of the loop. When the first `iteration-end` arrives we
    // emit the legacy `result:` frame (so the SPA's existing
    // `runGoalRound` HTTP client sees identical wire bytes) and close
    // the stream; the daemon continues iterating in the background.
    //
    // When MATHRAN_DISABLE_GOAL_DAEMON=1 we fall through to the v0.17
    // inline-runner code path below and behaviour is byte-identical to
    // pre-C3. This is the explicit opt-out for production goals that
    // were running mid-deploy.
    if (goalDaemon) {
      const daemon = goalDaemon;
      return streamSSE(c, async (stream) => {
        const queue: { event: string; data: string }[] = [];
        let done = false;
        let wake: (() => void) | null = null;
        const wakePump = () => {
          const w = wake;
          wake = null;
          if (w) w();
        };
        const pump = (async () => {
          while (!done || queue.length > 0) {
            while (queue.length > 0) {
              const frame = queue.shift()!;
              await stream.writeSSE(frame);
            }
            if (done) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })();

        // Bridge daemon events into the SSE queue. The factory in
        // buildProductionRunnerFactory forwards inner ChatEvents AND
        // daemon-shape events through `goal:<id>` so the same
        // subscriber sees both. We translate iteration-end into the
        // legacy `result:` frame and close on iteration-end OR
        // turn-end (whichever comes first). Subscribed for the
        // lifetime of THIS request only.
        //
        // Wire-contract pin: the SPA's parser expects the `result:`
        // frame to be the FINAL frame in the stream (see
        // src/server/sse-round-start.test.ts). The legacy inline path
        // emits result-then-close synchronously; the daemon path has
        // to read the goal record back from disk first (async). We
        // use `iterationEndSeen` + a pending `resultReady` promise so
        // turn-end / pump-exit waits for the async result push to
        // complete, preserving the contract.
        let iterationEndSeen = false;
        let resultReady: Promise<void> = Promise.resolve();
        const listener = (ev: any) => {
          if (!ev || typeof ev !== "object") return;
          const type = String((ev as { type?: unknown }).type ?? "");
          // Pass-through frames that match the legacy wire format.
          if (
            type === "round-start" ||
            type === "text" ||
            type === "tool-call" ||
            type === "tool-result" ||
            type === "ask_user" ||
            type === "todos" ||
            type === "steer-received" ||
            // TODO-2 §3.2 / C8 — compaction lifecycle event. SPA's
            // chat.ts adds a handler that flips a 🧹 badge + updates
            // the cumulative compactionRuns counter shown in
            // AgentStatusPanel.
            type === "compaction" ||
            // Layer 1 — token budget continuation. SPA flips a 💰 badge +
            // shows how often mark_done was blocked en route to the goal's
            // token target.
            type === "budget-continuation" ||
            type === "done"
          ) {
            queue.push({ event: type, data: JSON.stringify(ev) });
            wakePump();
            return;
          }
          // Daemon-shape iteration-end: synthesise the legacy `result:`
          // frame and end this request's stream slice. The daemon
          // continues iterating in the background.
          if (type === "iteration-end") {
            iterationEndSeen = true;
            const r = (ev as { result?: DaemonIterationResult }).result ?? {
              completed: false,
              failed: false,
              exhausted: false,
              aborted: false,
            };
            // We need to reload the goal so the `result:` frame
            // carries the post-iteration goal record (mirrors the
            // legacy contract). Hold the pump open until this push
            // completes by tracking the promise; turn-end / finally
            // both await it before setting done = true so the result
            // frame is guaranteed to be the FINAL frame in the SSE
            // stream.
            resultReady = (async () => {
              const fresh = (await readGoal(workspace, goalId)) ?? g;
              queue.push({
                event: "result",
                data: JSON.stringify({
                  goal: fresh,
                  text: "", // wire compat: legacy text was a per-call buffer; daemon path streams chunks via `text` events
                  completed: r.completed,
                  failed: r.failed,
                  exhausted: r.exhausted,
                  aborted: r.aborted,
                  ...(r.endReason ? { endReason: r.endReason } : {}),
                }),
              });
              done = true;
              wakePump();
            })();
            return;
          }
          if (type === "error") {
            queue.push({ event: "error", data: JSON.stringify(ev) });
            wakePump();
            return;
          }
          // turn-end without preceding iteration-end (e.g. naturalEnd /
          // status-flipped / interrupted before iter started). End the
          // stream without a `result:` frame so the client falls back
          // to its no-result handler.
          //
          // If we already saw iteration-end, ignore: the async
          // `resultReady` promise will set `done = true` itself once
          // the result frame is queued.
          if (type === "turn-end") {
            if (iterationEndSeen) return;
            done = true;
            wakePump();
            return;
          }
          // Iteration-start + any future daemon-shape events: ignore.
          // (Legacy wire never had iteration-start so SPA wouldn't know
          // what to do with it.)
        };
        daemon.eventBus.on(`goal:${goalId}`, listener);

        try {
          // Kick the daemon. If a runner already exists for this goal,
          // kickGoal is a no-op (or enqueues the userMessage). The
          // daemon will emit events on `goal:<goalId>` which our
          // listener pushes onto the queue.
          daemon.kickGoal(goalId, { userMessage });
          // Pump runs until `done = true` (set by listener on
          // iteration-end / turn-end / error).
          await pump;
          // Belt-and-braces: make sure the async `result:` push from an
          // iteration-end listener has fully flushed before we tear
          // down the subscription. The pump already awaits it via
          // resultReady's wakePump(), but if pump exited via
          // forceStop / cancellation we want to surface the same
          // promise rejection rather than swallow it.
          await resultReady;
        } finally {
          daemon.eventBus.off(`goal:${goalId}`, listener);
          done = true;
          wakePump();
        }
      });
    }

    // ── Legacy v0.17 inline-runner code path ────────────────────────
    const cfg = loadConfig(configPathFor(workspace));
    const llm: LLMProvider = goalLlmFactory
      ? goalLlmFactory({ model: g.model })
      : new ModelRouter(cfg);
    const lean = new LocalLeanProvider();
    const tools = [createLeanCheckTool(lean)];

    const controller = new AbortController();
    inflightGoals.set(goalId, controller);

    // v0.17 mathub parity W9 — Live Steering. The goal's first
    // conversationId is the key into the in-memory steer registry
    // (chat + goal share the same conversationId namespace, so the
    // SPA can target either by id). We register the slot as soon as
    // we know the id and release it in `finally`, ref-counted via the
    // returned closure so concurrent /run/stream calls on the same
    // goal (rare but possible during reload races) don't double-free.
    // The conversationId may not exist yet if this is the very first
    // round of the goal — mirror the runner's logic that mints one on
    // demand. We can't actually pre-mint without persisting, so we
    // accept this gap: the user's first steer for a brand-new goal
    // would 404 client-side and they retry once a round is live. In
    // practice the SPA only enables the Steer button once it has seen
    // the `session` SSE frame, which carries the conversationId.
    const steerConversationId = g.conversationIds[0] ?? null;
    const releaseSteerSlot = steerConversationId
      ? markStreamActive(steerConversationId)
      : () => undefined;

    return streamSSE(c, async (stream) => {
      // Stream events live (rather than buffering until the round finishes)
      // so the AgentStatusPanel can render `round-start` + phase changes as
      // they happen. `onEvent` is sync but `stream.writeSSE` is async, so we
      // run a small pump task in parallel with `runGoalRound`: events get
      // pushed onto `queue` synchronously from the runner, and the pump
      // drains them on every tick. Ordering is preserved (single producer,
      // single consumer, FIFO array).
      const queue: { event: string; data: string }[] = [];
      let done = false;
      let wake: (() => void) | null = null;
      const wakePump = () => {
        const w = wake;
        wake = null;
        if (w) w();
      };

      const pump = (async () => {
        while (!done || queue.length > 0) {
          while (queue.length > 0) {
            const frame = queue.shift()!;
            await stream.writeSSE(frame);
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })();

      try {
        const r = await runGoalRound({
          workspace,
          goalId,
          userMessage,
          llm,
          tools,
          builtinTools: GOAL_MODE_BUILTIN_TOOLS,
          toolContext: { workspace, scope: g.scope },
          signal: controller.signal,
          bootstrapPlan: "auto",
          selfGrade: true,
          onEvent: (ev) => {
            queue.push({ event: ev.type, data: JSON.stringify(ev) });
            wakePump();
            // v0.17 W12 — after a successful `todo_write` tool result,
            // synthesise a `todos` frame so the SPA's ActivePlanPanel
            // stays in sync. Goals always have a conversationId by the
            // time the inner ChatSession runs — the runner mints one on
            // first call — but `steerConversationId` captured the
            // pre-call value which may be empty for a brand-new goal.
            // We re-read the goal's conversationIds[0] off `g` to cover
            // that edge: the runner attaches the new id synchronously
            // before yielding any tool events.
            if (
              ev.type === "tool-result" &&
              ev.name === "todo_write" &&
              ev.ok
            ) {
              void (async () => {
                try {
                  // Re-read the goal so we pick up the runner-minted
                  // conversationId on the very first round (when
                  // `g.conversationIds[0]` was empty at request time).
                  const fresh = await readGoal(workspace, goalId);
                  const cid =
                    fresh?.conversationIds[0] ?? steerConversationId ?? undefined;
                  if (!cid) return;
                  const list = await loadTodos(workspace, g.scope, cid);
                  queue.push({
                    event: "todos",
                    data: JSON.stringify({ type: "todos", list }),
                  });
                  wakePump();
                } catch {
                  /* best-effort */
                }
              })();
            }
          },
          // v0.17 mathub parity W9 — forward the registry probe into
          // the inner `ChatSession.runRounds`. The runner re-emits
          // any `steer-received` event via `onEvent` so the SSE pump
          // ships the frame to the SPA.
          ...(steerConversationId
            ? { steerProbe: () => consumePendingSteer(steerConversationId) }
            : {}),
        });
        queue.push({
          event: "result",
          data: JSON.stringify({
            goal: r.goal,
            text: r.text,
            completed: r.completed,
            failed: r.failed,
            exhausted: r.exhausted,
            aborted: r.aborted,
            endReason: r.endReason,
          }),
        });
      } catch (err: any) {
        if (isAskUserPending(err)) {
          queue.push({
            event: "ask_user",
            data: JSON.stringify({
              type: "ask_user",
              id: (err as any).callId,
              name: "ask_user",
              question: (err as any).question,
            }),
          });
        } else {
          await endGoal(workspace, goalId, "failed", String(err?.message ?? err));
          queue.push({
            event: "error",
            data: JSON.stringify({ message: err?.message ?? String(err) }),
          });
        }
      } finally {
        inflightGoals.delete(goalId);
        releaseSteerSlot();
        done = true;
        wakePump();
        await pump;
      }
    });
  });

  /**
   * POST /api/goals/:id/interrupt — abort the in-flight round for this goal.
   *
   * Returns 200 (with `{ interrupted: true }`) when a controller was found and
   * aborted, 404 when no round is currently running for the goal. The goal's
   * persisted status is NOT changed here — the round winds down and the runner
   * leaves it active/paused for the caller to decide next.
   */
  app.post("/api/goals/:goalId/interrupt", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const controller = inflightGoals.get(goalId);
    if (!controller) return c.json({ error: "no in-flight round" }, 404);
    controller.abort();
    return c.json({ interrupted: true });
  });

  /**
   * POST /api/goals/:id/steer — v0.17 mathub parity W9 (Live Steering).
   *
   * Goal-flavoured wrapper around the scoped chat-side
   * `POST <basePath>/:conversationId/steer` route. The SPA's goal-mode
   * panel doesn't know (and shouldn't need to know) the underlying
   * conversationId of the running round; this route resolves the goal
   * record, picks `conversationIds[0]` (the canonical chat the runner
   * uses for the goal), and queues the steer there.
   *
   * Contract:
   *   - Body: `{ text: string }`. Empty / whitespace-only → 400.
   *   - Goal must exist and be running an in-flight stream → else 409.
   *   - Returns 200 `{ ok: true, queued: true, goalId, conversationId }`.
   *
   * Mirrors the chat-side contract so the SPA can pick which endpoint
   * to hit by URL pattern, never by special-casing types.
   */
  app.post("/api/goals/:goalId/steer", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const raw = typeof body?.text === "string" ? body.text : "";
    const text = raw.trim();
    if (text.length === 0) return c.json({ error: "text is required" }, 400);
    const conversationId = g.conversationIds[0];
    if (!conversationId || !hasActiveStream(conversationId)) {
      return c.json(
        { error: "no in-flight round to steer", goalId },
        409,
      );
    }
    // C3: dual-write the steer.
    //  - setPendingSteer(conversationId, text) is the legacy in-flight
    //    `steerProbe` mechanism; the runner's ChatSession.send() polls
    //    it mid-stream so this delivers the steer to the model on the
    //    CURRENT round's next probe.
    //  - goalDaemon.enqueueSteer(goalId, text) drains pre-iteration via
    //    runOneIteration's `steerText` parameter so the steer also lands
    //    on the very NEXT iteration if the current one ends naturally.
    //  - goalDaemon.kickGoal(goalId) wakes a parked-on-naturalTurnEnd
    //    runner so the steer is acted on immediately.
    //
    // Both writes are idempotent + cheap; running them in sequence is
    // the belt-and-braces approach the design doc §3.4 calls for.
    setPendingSteer(conversationId, text);
    if (goalDaemon) {
      goalDaemon.enqueueSteer(goalId, text);
      goalDaemon.kickGoal(goalId, { source: "steer" });
    }
    return c.json({ ok: true, queued: true, goalId, conversationId });
  });

  app.post("/api/goals/:goalId/pause", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    if (g.status !== "active") {
      return c.json({ error: `goal is ${g.status}; can only pause active goals` }, 400);
    }
    g.status = "paused";
    g.steps.push({
      at: new Date().toISOString(),
      kind: "status",
      payload: { to: "paused", reason: "user pause" },
    });
    await writeGoal(workspace, g);
    return c.json({ goal: g });
  });

  app.post("/api/goals/:goalId/cancel", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    if (g.status === "complete" || g.status === "failed" || g.status === "cancelled" || g.status === "exhausted") {
      return c.json({ error: `goal already ${g.status}` }, 400);
    }
    const ended = await endGoal(workspace, goalId, "cancelled", "user cancelled");
    return c.json({ goal: ended });
  });

  // ─── v0.17 W8: GoalRunStatusPanel support (status / abort / resume) ─
  //
  // The status panel polls `/status` every ~3s while a goal is active so
  // it can render heartbeat freshness, budget bars, and the latest
  // round/tool counts without keeping the SSE stream open. /abort and
  // /resume let the user terminate or restart a goal-loop from that same
  // panel.

  /**
   * GET /api/goals/:id/status — denormalised projection of `goal.json`
   * suited for a 3-second polling loop. Returns *just* the fields the
   * SPA needs (no audit log) so the response is small and never blocks
   * on jsonl loads. Returns 404 when the goal doesn't exist; never
   * mutates state.
   */
  app.get("/api/goals/:goalId/status", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);

    // Pull the latest assistant text from the audit log as a cheap
    // `latestSummary` proxy (avoids loading the full conversation
    // jsonl just to render the panel's one-line preview). The store
    // already records every assistant turn as a `text` step.
    let latestSummary: string | null = null;
    for (let i = g.steps.length - 1; i >= 0; i--) {
      const s = g.steps[i];
      if (s.kind === "text" && typeof s.payload === "string" && s.payload.trim().length > 0) {
        latestSummary = s.payload.trim().slice(0, 240);
        break;
      }
    }

    // Resume counter: how many times has a fresh `/run` cleared an
    // abortRequested flag? Cheap to derive from the audit log: each
    // user-abort + subsequent round-start cycle leaves a paired pair
    // of `status` steps (`abortRequested:true` then a new `plan`
    // step). We just count the `abortRequested:true` rows.
    let resumeCount = 0;
    for (const s of g.steps) {
      if (
        s.kind === "status" &&
        typeof s.payload === "object" &&
        s.payload !== null &&
        (s.payload as Record<string, unknown>).abortRequested === true
      ) {
        resumeCount++;
      }
    }

    return c.json({
      id: g.id,
      objective: g.objective,
      status: g.status,
      endReason: g.endReason ?? null,
      round: g.stats.roundsRun,
      iterationsRun: g.stats.iterationsRun,
      assistantTurnsTotal: g.stats.assistantTurnsTotal,
      llmCallsTotal: g.stats.llmCallsTotal,
      roundsMax: g.budget.roundsMax,
      tokensUsed: g.stats.tokensUsed,
      tokensMax: g.budget.tokensMax,
      // Phase ζ (cost meter) — denormalised $ cost so the SPA renders the
      // badge without re-deriving pricing. null => model has no public
      // price (UI shows "—"). DESIGN-REFERENCE.md §5.E.
      costUsd: computeGoalCostUsd(g),
      inputTokensUsed: g.stats.inputTokensUsed ?? 0,
      outputTokensUsed: g.stats.outputTokensUsed ?? 0,
      model: g.model,
      toolCount: g.stats.toolCallCount,
      resumeCount,
      heartbeatAt: g.heartbeatAt ?? null,
      latestSummary,
      abortRequested: g.meta?.abortRequested === true,
      // Echo IDs the panel may want to deep-link to.
      conversationId: g.conversationIds[0] ?? null,
      summaryPath: g.summaryPath ?? null,
      planPath: g.planPath ?? null,
      parentGoalId: g.parentGoalId ?? null,
      subGoalCount: (g.subGoalIds ?? []).length,
      // TODO-2 §3.2 / C9 — surface compaction stats to the SPA badge.
      compactionRuns: g.stats.compactionRuns ?? 0,
      compactionTokensDropped: g.stats.compactionTokensDropped ?? 0,
      lastCompactionReason: g.stats.lastCompactionReason ?? null,
      lastCompactionAt: g.stats.lastCompactionAt ?? null,
    });
  });

  /**
   * GET /api/goals/:id/events — read-only live tail (UX gap D).
   *
   * Subscribes to the goal daemon's `goal:<id>` eventBus and forwards every
   * frame onto an SSE stream WITHOUT kicking a run (contrast with
   * POST /run/stream, which both kicks the loop and streams). This is the
   * endpoint `mathran goal watch <id>` connects to: a remote operator can
   * ssh in and `tail` a goal that some other process (SPA / daemon) is
   * driving, with zero side effects on the run loop.
   *
   * Wire contract:
   *   - leading `snapshot:` frame carries a small status projection so the
   *     watcher can print a header before any live event arrives.
   *   - daemon-shape frames are forwarded verbatim under their own `type`
   *     (iteration-start / iteration-end / text / tool-call / tool-result /
   *     compaction / budget-continuation / round-start / done / turn-end /
   *     error / ask_user / todos / steer-received).
   *   - periodic `ping:` keep-alive frames.
   *   - a terminal `status:` frame ({status, endReason, terminal:true}) is
   *     emitted (and the stream closed) the moment the goal record reaches a
   *     terminal status. Terminal detection is driven by a cheap disk poll so
   *     it works even when the daemon is disabled or the goal is idle.
   */
  app.get("/api/goals/:goalId/events", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g0 = await readGoal(workspace, goalId);
    if (!g0) return c.json({ error: "not found" }, 404);

    const TERMINAL = new Set(["complete", "failed", "cancelled", "exhausted"]);
    const snapshotOf = (g: Goal) => ({
      id: g.id,
      objective: g.objective,
      status: g.status,
      model: g.model,
      iterationsRun: g.stats.iterationsRun,
      assistantTurnsTotal: g.stats.assistantTurnsTotal,
      toolCount: g.stats.toolCallCount,
      tokensUsed: g.stats.tokensUsed,
      tokensMax: g.budget.tokensMax,
      roundsMax: g.budget.roundsMax,
      costUsd: computeGoalCostUsd(g),
      endReason: g.endReason ?? null,
      createdAt: g.createdAt,
    });

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshotOf(g0)) });

      // Already terminal: emit the closing status frame and we're done.
      if (TERMINAL.has(g0.status)) {
        await stream.writeSSE({
          event: "status",
          data: JSON.stringify({ status: g0.status, endReason: g0.endReason ?? null, terminal: true }),
        });
        return;
      }

      const queue: { event: string; data: string }[] = [];
      let done = false;
      let wake: (() => void) | null = null;
      const wakePump = () => {
        const w = wake;
        wake = null;
        if (w) w();
      };
      const pump = (async () => {
        while (!done || queue.length > 0) {
          while (queue.length > 0) {
            await stream.writeSSE(queue.shift()!);
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })();

      // Forward every daemon frame verbatim. Read-only: we never call
      // kickGoal, so this subscription is a pure side-channel.
      const listener = (ev: unknown) => {
        if (!ev || typeof ev !== "object") return;
        const type = String((ev as { type?: unknown }).type ?? "");
        if (!type) return;
        queue.push({ event: type, data: JSON.stringify(ev) });
        wakePump();
      };
      if (goalDaemon) goalDaemon.eventBus.on(`goal:${goalId}`, listener);

      // Terminal authority + keep-alive: poll the goal record on disk. This
      // closes the stream on terminal even when the daemon is disabled or the
      // goal is idle (no live frames). A `ping` every ~16s keeps proxies open.
      let tick = 0;
      const poll = setInterval(() => {
        void (async () => {
          tick++;
          const fresh = await readGoal(workspace, goalId);
          if (!fresh || TERMINAL.has(fresh.status)) {
            queue.push({
              event: "status",
              data: JSON.stringify({
                status: fresh?.status ?? "missing",
                endReason: fresh?.endReason ?? null,
                terminal: true,
              }),
            });
            done = true;
            wakePump();
            return;
          }
          if (tick % 8 === 0) {
            queue.push({ event: "ping", data: JSON.stringify({ at: Date.now() }) });
            wakePump();
          }
        })();
      }, 2000);

      // Client disconnect (CLI Ctrl-C / stream close) → unwind the pump.
      stream.onAbort(() => {
        done = true;
        wakePump();
      });

      try {
        await pump;
      } finally {
        clearInterval(poll);
        if (goalDaemon) goalDaemon.eventBus.off(`goal:${goalId}`, listener);
        done = true;
        wakePump();
      }
    });
  });

  /**
   * POST /api/goals/:id/abort — request a cooperative abort of the
   * goal loop. Sets `meta.abortRequested = true` (which the runner
   * checks at round-top) AND aborts any in-flight AbortController
   * registered for this goal so the current round unwinds promptly.
   *
   * Distinct from POST /interrupt: /interrupt is a single-round
   * cancellation that leaves the goal's status untouched; /abort is
   * the same gesture plus a *persisted* flag so a daemonised /
   * background runner that picks up the goal later still sees the
   * abort. The goal's status is NOT changed here — the runner / next
   * round decides. POST /resume clears the flag and re-runs.
   */
  app.post("/api/goals/:goalId/abort", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    const updated = await requestGoalAbort(workspace, goalId);
    // Best-effort: if a round is currently mid-stream, abort its
    // AbortController so the SSE/stream unwinds immediately. We do
    // this AFTER setting the flag so a runner that races to read the
    // flag at round-top will see it.
    const controller = inflightGoals.get(goalId);
    let inflight = false;
    if (controller) {
      controller.abort();
      inflight = true;
    }
    return c.json({ aborted: true, inflight, goal: updated });
  });

  /**
   * POST /api/goals/:id/resume — clear a pending abortRequested flag
   * and (when status === "paused") flip the goal back to active so
   * the SPA can immediately POST /run.
   *
   * Terminal statuses (complete / failed / cancelled / exhausted) are
   * not resumable; the caller should start a fresh goal instead.
   * Returns 200 + the updated goal record so the panel can refresh
   * without an extra round-trip.
   */
  app.post("/api/goals/:goalId/resume", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    if (
      g.status === "complete" ||
      g.status === "failed" ||
      g.status === "cancelled" ||
      g.status === "exhausted"
    ) {
      return c.json({ error: `goal is ${g.status}; not resumable` }, 400);
    }
    await clearGoalAbortRequest(workspace, goalId);
    if (g.status === "paused") {
      g.status = "active";
      g.steps.push({
        at: new Date().toISOString(),
        kind: "status",
        payload: { to: "active", reason: "user resume" },
      });
      await writeGoal(workspace, g);
    }
    const fresh = await readGoal(workspace, goalId);
    return c.json({ goal: fresh });
  });

  /**
   * POST /api/goals/:id/resurrect — explicit revive of a terminally
   * ended goal (`failed` / `cancelled`). The normal `/resume` endpoint
   * refuses these statuses on purpose (terminal = pipeline thinks it's
   * over). Resurrect exists as the documented escape hatch when the
   * "terminal" was caused by infra (copilot token outage, fetch failure,
   * server restart) rather than the goal actually being done.
   *
   * Body: `{ reason: string }` — required, free-form, written into a
   * status step so the goal's history shows why it was revived. Refusing
   * the call without a reason avoids accidental one-click revives that
   * lose context about what went wrong the first time.
   *
   * Effects:
   *   1. status → "active"
   *   2. endedAt / endReason cleared (so the goal looks like it never
   *      terminated for budget / UI purposes)
   *   3. Pending abortRequested flag cleared (mirrors /resume).
   *   4. A status step appended:
   *        { from: prevStatus, to: "active", reason, via: "resurrect" }
   *
   * Non-terminal statuses (active / paused / complete / exhausted) are
   * rejected with 400 — use /resume or start a fresh goal instead.
   * `complete` and `exhausted` are intentionally NOT resurrectable: they
   * represent a healthy end-of-life, not an outage.
   *
   * After this call the SPA can immediately `POST /run/stream` to
   * continue work. No automatic re-run happens here — resurrect is
   * metadata-only so the caller stays in control of when the next round
   * fires.
   */
  app.post("/api/goals/:goalId/resurrect", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const reason =
      body !== null &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>).reason === "string"
        ? ((body as Record<string, unknown>).reason as string).trim()
        : "";
    if (reason.length === 0) {
      return c.json(
        {
          error:
            "'reason' is required: explain why this terminally-ended goal should be " +
            "revived (e.g. 'copilot token refreshed, retrying'). Avoids accidental " +
            "one-click revives that lose context about what went wrong.",
        },
        400,
      );
    }
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    if (g.status !== "failed" && g.status !== "cancelled") {
      return c.json(
        {
          error:
            `goal status is '${g.status}'; resurrect only revives 'failed' or 'cancelled'. ` +
            `Use POST /api/goals/${goalId}/resume for paused goals, or start a fresh goal.`,
        },
        400,
      );
    }
    const prevStatus = g.status;
    const prevEndReason = g.endReason ?? null;
    // Clear any abortRequested flag too — same defensive cleanup /resume does.
    await clearGoalAbortRequest(workspace, goalId);
    // Re-read after clearGoalAbortRequest in case it mutated other fields.
    const fresh = await readGoal(workspace, goalId);
    if (!fresh) return c.json({ error: "not found after clear" }, 500);
    fresh.status = "active";
    fresh.endedAt = undefined;
    fresh.endReason = undefined;
    fresh.steps.push({
      at: new Date().toISOString(),
      kind: "status",
      payload: {
        from: prevStatus,
        to: "active",
        reason,
        via: "resurrect",
        previousEndReason: prevEndReason,
      },
    });
    await writeGoal(workspace, fresh);
    const after = await readGoal(workspace, goalId);
    return c.json({
      resurrected: true,
      previousStatus: prevStatus,
      previousEndReason: prevEndReason,
      goal: after,
    });
  });

  // Per-plan AbortControllers + a small in-memory queue so an SPA that POSTs
  // /api/plans and immediately opens /stream picks up every event — the
  // runner is started synchronously here and may have already emitted some
  // tokens by the time the SSE consumer attaches.
  type PlanFrame =
    | { event: "token"; data: { delta: string } }
    | { event: "step"; data: { round: number; finishReason: string } }
    | { event: "done"; data: { planId: string; body: string; turns: number; truncated: boolean; aborted: boolean } }
    | { event: "error"; data: { message: string } };

  interface PlanRun {
    planId: string;
    abort: AbortController;
    /** Buffered frames not yet flushed to an SSE consumer. */
    buffer: PlanFrame[];
    /** Set after the runner emits `done` or `error`. */
    finished: boolean;
    /** Notify listeners when new frames arrive. */
    waiters: Array<() => void>;
  }
  const planRuns = new Map<string, PlanRun>();

  function planScopeOk(raw: any): { ok: true } | { ok: false; error: string } {
    // Plans are workspace-rooted today — there is no per-scope plans store —
    // so we accept the same shape as goals for forward-compat and ignore the
    // value. Empty/missing scope is also accepted.
    if (raw === undefined || raw === null) return { ok: true };
    if (raw === "global") return { ok: true };
    if (typeof raw === "object") {
      const kind = raw.kind;
      if (kind === "global" || kind === "project" || kind === "effort") return { ok: true };
      return { ok: false, error: `unknown scope kind: ${String(kind)}` };
    }
    return { ok: false, error: "scope must be an object or 'global'" };
  }

  /** Slug-safe id matcher for plan ids over the wire. */
  function isSafePlanIdParam(s: string): boolean {
    return /^plan-[a-z0-9]+$/.test(s) && s.length <= 64;
  }

  /**
   * POST /api/plans  body: `{ objective, scope?, model? }`
   *
   * Creates a plan record + spawns the planning runner in the background
   * and returns 202 with `{ planId }`. Clients then open
   * `GET /api/plans/:planId/stream` to receive SSE progress frames. The
   * scope field is accepted for forward-compat (the on-disk PlanStore is
   * workspace-rooted; per-scope plan dirs aren't a thing yet).
   */
  app.post("/api/plans", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const objective = typeof body?.objective === "string" ? body.objective.trim() : "";
    if (!objective) return c.json({ error: "'objective' is required" }, 400);
    const scopeCheck = planScopeOk(body?.scope);
    if (!scopeCheck.ok) return c.json({ error: scopeCheck.error }, 400);
    const cfg = loadConfig(configPathFor(workspace));
    const model = typeof body?.model === "string" && body.model.trim().length > 0
      ? body.model.trim()
      : cfg.defaultModel ?? DEFAULT_MODEL;

    // Reserve the plan record up front so we have a stable id to hand back
    // before the runner even queues an LLM call. The runner re-resolves the
    // record by id when it streams the body in.
    const store = new PlanStore({ workspace });
    const plan = await store.create(objective, model);

    // Wire the LLM through the same factory the goal runner uses so tests
    // can inject a fake LLM via `goalLlmFactory`. (One seam for both modes
    // keeps the test harness small.)
    const llm: LLMProvider = goalLlmFactory
      ? goalLlmFactory({ model })
      : new ModelRouter(cfg);

    const run: PlanRun = {
      planId: plan.id,
      abort: new AbortController(),
      buffer: [],
      finished: false,
      waiters: [],
    };
    planRuns.set(plan.id, run);

    const push = (frame: PlanFrame) => {
      run.buffer.push(frame);
      const w = run.waiters.splice(0);
      for (const fn of w) {
        try { fn(); } catch { /* ignore */ }
      }
    };

    // Drive the runner. The runner mutates the same plan record on disk via
    // its own PlanStore handle, so we don't have to re-write the body here.
    // Note: we kick this off *without* awaiting so the POST returns 202
    // immediately; the SSE consumer drains `run.buffer`.
    (async () => {
      try {
        await runPlan({
          objective,
          workspace,
          llm,
          model,
          planId: plan.id,
          abortSignal: run.abort.signal,
          onEvent: (ev) => {
            if (ev.type === "token") push({ event: "token", data: { delta: ev.delta } });
            else if (ev.type === "step") push({ event: "step", data: { round: ev.round, finishReason: ev.finishReason } });
            else if (ev.type === "done") push({ event: "done", data: { planId: ev.planId, body: ev.body, turns: ev.turns, truncated: ev.truncated, aborted: ev.aborted } });
            else if (ev.type === "error") push({ event: "error", data: { message: ev.message } });
          },
        });
      } catch (err: any) {
        push({ event: "error", data: { message: String(err?.message ?? err) } });
      } finally {
        run.finished = true;
        // Wake up any consumer that's still waiting so it can flush + close.
        const w = run.waiters.splice(0);
        for (const fn of w) { try { fn(); } catch { /* ignore */ } }
      }
    })();

    return c.json({ planId: plan.id }, 202);
  });

  /**
   * GET /api/plans/:planId/stream — SSE stream of plan progress.
   *
   * Replays whatever has already been buffered (so a consumer that races
   * the runner doesn't lose the head tokens) and then forwards new frames
   * as they arrive. Closes when the runner reports `done` or `error`,
   * **or** when an SPA reconnects to a plan that already finished and we
   * have nothing left to send.
   */
  app.get("/api/plans/:planId/stream", (c) => {
    const planId = c.req.param("planId");
    if (!isSafePlanIdParam(planId)) return c.json({ error: "invalid planId" }, 400);
    const run = planRuns.get(planId);
    if (!run) return c.json({ error: "no active plan run for this id" }, 404);
    return streamSSE(c, async (stream) => {
      let cursor = 0;
      // Drain loop: emit anything new, then wait for the next push.
      // The runner sets `finished` after pushing its terminal frame, so we
      // always flush that final frame before exiting.
      while (true) {
        while (cursor < run.buffer.length) {
          const frame = run.buffer[cursor++];
          if (!frame) continue;
          await stream.writeSSE({
            event: frame.event,
            data: JSON.stringify(frame.data),
          });
        }
        if (run.finished) break;
        await new Promise<void>((resolve) => {
          run.waiters.push(resolve);
        });
      }
    });
  });

  /**
   * POST /api/plans/:planId/accept — mark the plan accepted (SPA flavour;
   * no effort id is created, the CLI's `mathran plan accept` keeps doing
   * that). Returns `{ ok: true, location }` where `location` is the
   * relative on-disk path of the plan jsonl — the SPA shows this in its
   * "Plan saved to <location>" toast.
   */
  app.post("/api/plans/:planId/accept", async (c) => {
    const planId = c.req.param("planId");
    if (!isSafePlanIdParam(planId)) return c.json({ error: "invalid planId" }, 400);
    const store = new PlanStore({ workspace });
    try {
      const accepted = await store.acceptDraft(planId);
      const file = path.join(".mathran", "plans", `${accepted.id}.jsonl`);
      return c.json({ ok: true, plan: accepted, location: file });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const status = msg.includes("not found") ? 404 : 400;
      return c.json({ error: msg }, status);
    }
  });

  /**
   * POST /api/plans/:planId/reject — mark the plan rejected. Same shape
   * as accept; returns the updated plan record so the SPA can update its
   * local view without re-fetching.
   */
  app.post("/api/plans/:planId/reject", async (c) => {
    const planId = c.req.param("planId");
    if (!isSafePlanIdParam(planId)) return c.json({ error: "invalid planId" }, 400);
    const store = new PlanStore({ workspace });
    try {
      const rejected = await store.reject(planId);
      return c.json({ ok: true, plan: rejected });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const status = msg.includes("not found") ? 404 : 400;
      return c.json({ error: msg }, status);
    }
  });

  /** GET /api/plans/:planId — fetch the latest stored snapshot. Useful
   *  after a /stream `done` event so the SPA can re-load the canonical
   *  body if it lost any frames. */
  app.get("/api/plans/:planId", async (c) => {
    const planId = c.req.param("planId");
    if (!isSafePlanIdParam(planId)) return c.json({ error: "invalid planId" }, 400);
    const store = new PlanStore({ workspace });
    const plan: Plan | null = await store.get(planId);
    if (!plan) return c.json({ error: "not found" }, 404);
    return c.json({ plan });
  });

  app.get("/api/providers", (c) => c.json(maskProviders(workspace)));

  app.put("/api/providers", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      return c.json(await writeProviders(workspace, body));
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/config", (c) => c.json(safeConfig(workspace)));

  // ─── Goal autonomy config (v0.17 mathub parity W11) ─────────────────────
  // Per-scope persistent defaults for goal-loop behaviour:
  // autonomy level, summary cadence, fallback budget caps, and an
  // `enabled` gate for any future auto-promote flow. Two on-disk
  // layers (project = workspace-local, global = HOME) with a sparse
  // overlay so an unspecified key in `project` inherits from `global`,
  // then from `DEFAULT_GOAL_AUTONOMY`.
  //
  // `scopeId` is accepted-and-validated for forward-compat (e.g. a
  // future per-project file layout), but storage today is keyed by
  // workspace + HOME alone, so the value is effectively opaque past
  // the validator. Accepted forms:
  //   - "global"
  //   - "project~<slug>"
  //   - "effort~<projectSlug>~<effortSlug>"
  // Anything else gets a 400. URL `~` (unreserved) avoids collisions
  // with Hono path segments.
  function isValidAutonomyScopeId(s: string): boolean {
    if (s === "global") return true;
    const parts = s.split("~");
    if (parts.length === 2 && parts[0] === "project") return isSafeSlug(parts[1]);
    if (parts.length === 3 && parts[0] === "effort")
      return isSafeSlug(parts[1]) && isSafeSlug(parts[2]);
    return false;
  }
  function isAutonomyLayer(s: unknown): s is GoalAutonomyLayer {
    return s === "global" || s === "project";
  }

  app.get("/api/scopes/:scopeId/goal-autonomy", async (c) => {
    const scopeId = c.req.param("scopeId");
    if (!isValidAutonomyScopeId(scopeId)) {
      return c.json({ error: "invalid scopeId" }, 400);
    }
    const r = await loadGoalAutonomy({ workspace });
    return c.json({
      effective: r.effective,
      global: r.global,
      project: r.project,
      defaults: DEFAULT_GOAL_AUTONOMY,
    });
  });

  app.patch("/api/scopes/:scopeId/goal-autonomy", async (c) => {
    const scopeId = c.req.param("scopeId");
    if (!isValidAutonomyScopeId(scopeId)) {
      return c.json({ error: "invalid scopeId" }, 400);
    }
    let body: any;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (!isAutonomyLayer(body?.scope)) {
      return c.json({ error: "'scope' must be 'global' or 'project'" }, 400);
    }
    const v = validateGoalAutonomyPatch(body?.patch);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const r = await saveGoalAutonomy({ workspace }, body.scope, v.patch);
    return c.json({
      effective: r.effective,
      global: r.global,
      project: r.project,
      defaults: DEFAULT_GOAL_AUTONOMY,
    });
  });

  app.delete("/api/scopes/:scopeId/goal-autonomy", async (c) => {
    const scopeId = c.req.param("scopeId");
    if (!isValidAutonomyScopeId(scopeId)) {
      return c.json({ error: "invalid scopeId" }, 400);
    }
    const layer = c.req.query("scope");
    if (!isAutonomyLayer(layer)) {
      return c.json({ error: "'scope' query must be 'global' or 'project'" }, 400);
    }
    const r = await deleteGoalAutonomyLayer({ workspace }, layer);
    return c.json({
      effective: r.effective,
      global: r.global,
      project: r.project,
      defaults: DEFAULT_GOAL_AUTONOMY,
    });
  });

  // ─── Chat (T1-C) ────────────────────────────────────────────────────────────────────────
  registerChatRoutes(app, workspace, sessions);

  // ─── Slash commands (SPA Slash Commands task) ────────────────────────────
  registerSlashRoutes(app, {
    workspace,
    store: sessions,
    computeUsageStats,
    subagentKinds: () => defaultSubagentRegistry().list(),
    ...(mcpRegistry ? { mcpRegistry } : {}),
  });

  // ─── Static hosting / placeholder ──────────────────────────────────────────
  // Three layers (v0.15 §3 single-binary support):
  //   1. embedded asset map (populated when the generator has run; required
  //      under `bun build --compile` because the binary has no surrounding
  //      `dist/web/` dir)
  //   2. on-disk `dist/web/` via @hono/node-server's serveStatic (dev /
  //      `node dist/cli/index.js serve` path)
  //   3. tiny placeholder page (neither is available)
  if (embeddedAssetCount() > 0) {
    app.use("/*", makeEmbeddedAssetHandler());
  } else {
    const webDir = path.join(repoRoot(), "dist", "web");
    if (fssync.existsSync(webDir)) {
      const rel = path.relative(process.cwd(), webDir) || ".";
      app.use("/*", serveStatic({ root: rel }));
      app.get("/", serveStatic({ root: rel, path: "index.html" }));
      const indexPath = path.join(webDir, "index.html");
      app.notFound(async (c) => {
        if (c.req.method !== "GET") return c.json({ error: "not found" }, 404);
        const url = new URL(c.req.url);
        if (url.pathname.startsWith("/api/")) {
          return c.json({ error: "not found" }, 404);
        }
        try {
          const html = await fs.readFile(indexPath, "utf-8");
          return c.html(html);
        } catch {
          return c.json({ error: "not found" }, 404);
        }
      });
    } else {
      app.get("/", (c) => c.html(PLACEHOLDER_HTML));
    }
  }

  return { app, daemon: goalDaemon };
}

/**
 * Start the mathran server. Binds 127.0.0.1 by default (never 0.0.0.0) and
 * resolves to a handle exposing the bound URL plus a `close()`.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const workspace = resolveWorkspaceRoot(opts.workspace);

  // Permission profile (C-1): `--profile <name>` flag > `settings.json#profile`
  // > none. Unknown profile names are warned to stderr and ignored (matches
  // `mathran chat` behaviour). The resolved profile is threaded into the
  // session factory so every SPA conversation inherits its effects.
  const profileName =
    opts.profile ?? (await readSettingsDefaultProfileLazy(workspace));
  let resolvedProfile: ProfileEffects | undefined;
  if (profileName) {
    try {
      resolvedProfile = resolveProfile(profileName, { workspace });
    } catch (err) {
      if (err instanceof UnknownProfileError) {
        // eslint-disable-next-line no-console
        console.error(`[mathran] ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  // MCP (#4): bring up the process-level registry before building the app so
  // every SPA conversation's session inherits its tools. Best-effort.
  const mcpRegistry = getGlobalMcpRegistry();
  try {
    await mcpRegistry.init({ workspace });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[mathran] MCP init failed: ${(err as Error)?.message ?? err}`);
  }

  const factory =
    opts.chatSessionFactory ??
    defaultSessionFactory(workspace, sharedApprovalRegistry, resolvedProfile, mcpRegistry);

  const { app, daemon: goalDaemon } = buildApp(workspace, factory, opts.goalLlmFactory, mcpRegistry);

  // C5: kick off the daemon (no-op when MATHRAN_DISABLE_GOAL_DAEMON=1
  // or daemon construction was skipped). Boot-resume of active goals
  // lives inside daemon.start() (added in the C5 commit later this
  // series) — right now this is the dependency-free start hook so the
  // serve.ts wiring is already in place when C5 lands.
  if (goalDaemon) {
    try {
      await goalDaemon.start();
    } catch (err) {
      // Don't tear down the whole HTTP server if boot-resume hits a
      // transient disk error — log it and let the operator decide
      // whether to restart with the daemon disabled.
      // eslint-disable-next-line no-console
      console.error("[mathran] goalDaemon.start() failed:", err);
    }
  }

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: host, port }, () => resolve(s));
  });

  const address = server.address() as AddressInfo | string | null;
  const boundPort =
    address && typeof address === "object" ? address.port : port;
  const url = `http://${host}:${boundPort}`;

  const close = () =>
    new Promise<void>((resolve, reject) => {
      // C5: graceful daemon shutdown. Order matters:
      //   1. daemon.stop(30_000) — interrupts every running
      //      GoalTurnRunner, waits for them to finish their CURRENT
      //      iteration (or 30s, whichever comes first), then
      //      force-stops anything still alive. This lets a runner's
      //      in-flight LLM call drain cleanly and its result/iteration
      //      step persist to disk, so a subsequent boot-resume sees
      //      consistent state.
      //   2. mcpRegistry.shutdown() — tears down MCP server processes.
      //   3. server.close() — closes the HTTP listener.
      void (async () => {
        if (goalDaemon) {
          try {
            await goalDaemon.stop(30_000);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[mathran] goalDaemon.stop(30_000) error:", err);
          }
        }
        await mcpRegistry.shutdown();
        server.close((err?: unknown) => (err ? reject(err) : resolve()));
      })();
    });

  return {
    close,
    url,
    host,
    port: boundPort,
    workspace,
    ...(resolvedProfile ? { profile: resolvedProfile.name } : {}),
  };
}

/**
 * Wrap the synchronous `readSettingsDefaultProfile` in a Promise so `startServer`
 * can `await` it. The underlying I/O is `fs.readFileSync` — fine for a one-shot
 * read during process startup, but the Promise wrap keeps the call site uniform
 * with the rest of the async server boot.
 */
async function readSettingsDefaultProfileLazy(
  workspace: string,
): Promise<string | undefined> {
  return readSettingsDefaultProfile(workspace);
}
