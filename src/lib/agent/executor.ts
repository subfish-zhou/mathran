import type OpenAI from "openai";
import type { ToolRegistry } from "./tools/registry";
import type { ToolContext, ToolResult } from "./tools/types";
import { logLLMUsage } from "./azure-llm";
import { LLMRouter, ContentFilterError } from "./llm-router";
import { trimToolResults } from "./context/tool-result-trim";
import { SessionManager } from "./session-manager";
import {
  recordSpawn,
  recordTerminal,
  recordDeadEnd,
  classifyFailure,
  taskSignature,
  lookupAvoidHint,
} from "./subagent-persistence";
import { getAvailableSkills, loadSkill } from "./skills/loader";
import { matchSkills } from "./skills/matcher";
import { renderSkillsBlock } from "./skills/render";
// [commit-4b] Booting hooks at module-load happens automatically inside
// hooks/boot. Importing it here forces that side-effect on every executor
// instantiation path; safe (idempotent).
import "./hooks/boot";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runSubagentStartHooks,
  runSubagentStopHooks,
} from "./hooks/runtime";
// W7: per-user-tool rate-limit at the executor entry of each tool call.
import { requireRateLimit, RateLimitExceededError } from "@/lib/rate-limit";
// Goal Supervisor: completion gate (opt-in, default disabled = original break).
import { type AssistantGoalConfig, DEFAULT_GOAL_CONFIG } from "./goal-config";
import { getActiveRunForConversation } from "./goal/run-state";
import { getGoalBudgetForConversation } from "./goal/runtime-budgets";
import {
  type GoalProvider,
  type Objective,
  SimpleGoalProvider,
  decideGateAction,
} from "./goal-provider";
import { contextManager } from "./context/manager";
import "./context/boot";
import { drainSubagentNotifications, enqueueSubagentNotification } from "./context/subagent-mailbox";

export enum ToolErrorType {
  TIMEOUT = 'TIMEOUT',
  RATE_LIMIT = 'RATE_LIMIT',
  NOT_FOUND = 'NOT_FOUND',
  PERMISSION = 'PERMISSION',
  INTERNAL = 'INTERNAL',
  NETWORK = 'NETWORK',
}

export function classifyToolError(err: unknown): ToolErrorType {
  if (!(err instanceof Error)) return ToolErrorType.INTERNAL;
  const msg = err.message.toLowerCase();
  const name = err.name?.toLowerCase() ?? '';
  if (msg.includes('timed out') || msg.includes('timeout') || name === 'aborterror' || msg.includes('aborted')) {
    return ToolErrorType.TIMEOUT;
  }
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
    return ToolErrorType.RATE_LIMIT;
  }
  if (msg.includes('not found') || msg.includes('404') || msg.includes('no such')) {
    return ToolErrorType.NOT_FOUND;
  }
  if (
    msg.includes('permission') || msg.includes('forbidden') || msg.includes('403') ||
    msg.includes('unauthorized') || msg.includes('401')
  ) {
    return ToolErrorType.PERMISSION;
  }
  if (
    msg.includes('network') || msg.includes('econnrefused') || msg.includes('econnreset') ||
    msg.includes('fetch failed') || msg.includes('enotfound')
  ) {
    return ToolErrorType.NETWORK;
  }
  return ToolErrorType.INTERNAL;
}

function getRetryAfterMs(err: unknown): number {
  if (err && typeof err === 'object' && 'headers' in err) {
    const headers = (err as Record<string, unknown>).headers;
    if (headers && typeof headers === 'object') {
      const h = headers as Record<string, string>;
      const retryAfter = h['retry-after'] ?? h['Retry-After'];
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
      }
    }
  }
  return 2000;
}

async function handleToolError(
  err: unknown,
  toolName: string,
  retryFn: () => Promise<ToolResult>,
  doubledTimeoutRetryFn: () => Promise<ToolResult>,
  onToolRetry?: (name: string, attempt: number, reason: string) => void,
): Promise<ToolResult> {
  const errorType = classifyToolError(err);
  const msg = err instanceof Error ? err.message : "Tool execution failed";

  if (errorType === ToolErrorType.TIMEOUT) {
    onToolRetry?.(toolName, 1, "TIMEOUT");
    try {
      return await doubledTimeoutRetryFn();
    } catch {
      return { success: false, data: null, displayText: `[TIMEOUT] ${msg}` };
    }
  }

  if (errorType === ToolErrorType.RATE_LIMIT) {
    const waitMs = getRetryAfterMs(err);
    for (let attempt = 1; attempt <= 2; attempt++) {
      onToolRetry?.(toolName, attempt, "RATE_LIMIT");
      // [P2-5 TODO] Sleep is not abort-aware: if an upstream abort happens
      // during waitMs (commonly 5–30s for rate-limit retries), we still
      // wait the full delay before checking. Acceptable for now because
      // executor doesn't expose AbortSignal to wrapToolErrors yet — add
      // an optional signal arg + race-with-abort if/when cancel latency
      // becomes a problem in practice.
      await new Promise((r) => setTimeout(r, waitMs));
      try {
        return await retryFn();
      } catch (retryErr) {
        if (attempt === 2) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : msg;
          return { success: false, data: null, displayText: `[RATE_LIMIT] ${retryMsg}` };
        }
      }
    }
    return { success: false, data: null, displayText: `[RATE_LIMIT] ${msg}` };
  }

  if (errorType === ToolErrorType.NETWORK) {
    onToolRetry?.(toolName, 1, "NETWORK");
    try {
      return await retryFn();
    } catch {
      return { success: false, data: null, displayText: `[NETWORK] ${msg}` };
    }
  }

  if (errorType === ToolErrorType.NOT_FOUND) {
    return { success: false, data: null, displayText: `[NOT_FOUND] ${msg}` };
  }

  if (errorType === ToolErrorType.PERMISSION) {
    return { success: false, data: null, displayText: `[PERMISSION] ${msg}` };
  }

  // INTERNAL: log and don't retry
  console.error(`[agent-executor] Internal tool error in ${toolName}:`, err);
  return { success: false, data: null, displayText: `[INTERNAL] ${msg}` };
}

export interface AgentExecutorOptions {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools: ToolRegistry;
  toolContext: ToolContext;
  maxIterations?: number;
  parallelToolCalls?: boolean;
  onToolCall?: (name: string, args: unknown, callId: string) => void;
  onToolResult?: (name: string, callId: string, result: ToolResult) => void;
  onToolRetry?: (name: string, attempt: number, reason: string) => void;
  onToolOutputFile?: (name: string, mimeType: string, base64: string) => void;
  onSubAgentStatus?: (sessionId: string, status: string, result?: string) => void;
  onThinking?: () => void;
  onIteration?: (iteration: number, maxIterations: number) => void;
  onToken?: (token: string) => void;
  onNewTurn?: (iteration: number, previousContent: string) => void;
  /**
   * Goal Supervisor (C — reliability): fired exactly once when the loop is about
   * to return, with the final accumulated content and why it stopped. The
   * background goal-run job uses this to persist the terminal transcript +
   * flip assistant_goal_runs status (so a stop is never silent). `aborted`
   * is true when the caller signal cancelled the loop (vs natural completion /
   * budget exhaustion / objective reached).
   */
  onStopped?: (info: {
    content: string;
    stoppedReason?: BudgetUsageState['stoppedReason'];
    aborted: boolean;
    needsUserDecision: boolean;
    iteration: number;
    gateOutcome?: 'done' | 'needsUser' | 'continue' | 'error' | null;
  }) => void;
  // IMPL [quick-win-2] Stream live budget usage to UI (tokens / tool calls / wall-clock).
  onBudget?: (state: BudgetUsageState) => void;
  userId?: string;
  projectId?: string;
  /** Internal: marks events from a nested sub-agent */
  _nested?: boolean;
  /** Recursion depth for sub-agents (default 0, max MAX_SUBAGENT_DEPTH) */
  depth?: number;
  /**
   * #4: this agent's OWN SessionManager session id, used as the `parentId` when
   * it spawns a sub-agent so the parent→child link is established (enabling
   * getChildSessions and cascade-cancel). For the TOP-LEVEL agent (a channel
   * conversation, which has no SessionManager session of its own) this is
   * undefined; the executor then falls back to `toolContext.conversationId` as
   * the root parentId so at least the conversation→sub-agent link is recorded
   * and depth≥1 sub-agents chain to their parent session id.
   */
  sessionId?: string;
  // IMPL [quick-win-2] Per-call budget overrides; defaults from env.
  budget?: Partial<BudgetLimits>;
  /**
   * Phase 3 (C — abort): when the caller (SSE route) aborts because the client
   * disconnected / pressed Stop / deleted the in-flight message, this signal
   * fires. The loop checks it at the top of every iteration and bails out so
   * the BACKEND agent loop actually stops (not just the frontend SSE). Without
   * this, aborting only closed the fetch while the loop kept burning tokens.
   */
  signal?: AbortSignal;
  /**
   * Goal Supervisor (opt-in). When `enabled: true`, the executor does NOT break
   * the loop the moment the LLM emits a text-only turn (no tool calls); instead
   * it asks a GoalProvider whether the objective is DONE / needsUser / continue.
   * Default `DEFAULT_GOAL_CONFIG` has `enabled: false`, which preserves the
   * original behavior EXACTLY (text-only turn → break). Callers wire this from
   * the per-user × per-scope `assistant_goal_settings` table (via the
   * `assistantGoal` tRPC router) through `resolveGoalConfig`.
   */
  goalConfig?: AssistantGoalConfig;
  /**
   * Optional custom GoalProvider (e.g. future RcgGoalProvider). Defaults to
   * SimpleGoalProvider (same-model self-eval). Only consulted when
   * `goalConfig.enabled === true`.
   */
  goalProvider?: GoalProvider;
  /**
   * Live Steering — soft (照搬 Hermes `steer()` / `_apply_pending_steer_to_tool_results`).
   * Called at each tool-call batch boundary (after tool results are appended,
   * before the next LLM turn). If it resolves to non-empty text, that text is
   * appended to the LAST `role:"tool"` message's content with a "User guidance:"
   * marker — so the model sees mid-run user guidance as part of the tool output
   * on its next iteration WITHOUT interrupting the current work, and WITHOUT
   * inserting a new message (role alternation is preserved). For goal-mode the
   * caller wires this to `drainPendingSteer(runId)` (cross-process DB drain);
   * for the synchronous chat path it drains an in-memory queue.
   */
  drainSteer?: () => Promise<string | null>;
  /**
   * Live Steering — hard (照搬 Hermes `interrupt(message)`). Called at the TOP of
   * each loop iteration. If it resolves to non-empty text, the current
   * tool-calling is wrapped up and the text is injected as a NEW user turn
   * (the loop continues from there), letting the user redirect a running agent.
   * Goal-mode wires this to `drainPendingInterrupt(runId)`.
   */
  drainInterrupt?: () => Promise<string | null>;
}

// IMPL [quick-win-2] Budget shapes
export interface BudgetLimits {
  maxIterations: number;
  maxTotalTokens: number;
  maxToolCalls: number;
  maxWallClockMs: number;
}

export interface BudgetUsageState {
  iteration: number;
  totalTokens: number;
  toolCalls: number;
  wallClockMs: number;
  limits: BudgetLimits;
  /** When set, the executor stopped because of this budget breach. */
  stoppedReason?: 'tokens' | 'tool_calls' | 'wall_clock' | 'iterations' | 'no_progress' | 'content_filter' | 'budget_limited' | 'blocked';
}

export interface AgentResult {
  content: string;
  toolCalls: Array<{ name: string; args: unknown; result: ToolResult; callId: string }>;
  // IMPL [quick-win-2] Final budget usage for caller persistence.
  budget?: BudgetUsageState;
  /**
   * Goal Supervisor: set true when the run stopped because the objective is
   * blocked on a user decision (the gate emitted a question into the chat).
   * Undefined/false otherwise (incl. when the gate is disabled).
   */
  needsUserDecision?: boolean;
  /**
   * Goal Supervisor explicit gate verdict for the OUTER round loop. 'done' =
   * objective complete; 'needsUser' = huge fork (ask user); 'continue' = keep
   * pushing; 'error' = gate evaluate threw (treat as continue, NOT complete);
   * null = the gate did not fire this turn (non-gate stop: iteration cap /
   * tokens / abort). Lets goal-run.ts distinguish a true gate-complete from a
   * gate-evaluate-exception (which must NOT be misread as complete).
   */
  gateOutcome?: 'done' | 'needsUser' | 'continue' | 'error' | null;
}

// IMPL [quick-win-2] Defaults — bumped maxIterations 8 → 32; explicit budgets.
const MAX_ITERATIONS_DEFAULT = 32;
const TOOL_TIMEOUT_MS = 180_000;
// 7×24 mode (子鱼 2026-06-01): the per-turn token budget is no longer the
// anti-runaway guard. Set AGENT_MAX_TOTAL_TOKENS=0 (default) to DISABLE the
// token ceiling entirely; any positive value re-enables a hard cap. The real
// runaway protection is the four-tier guard: iterations + tool-calls +
// (relaxed) wall-clock + a NO-PROGRESS detector (identical iterations in a row).
const MAX_TOTAL_TOKENS = Number(process.env.AGENT_MAX_TOTAL_TOKENS ?? 0);
const MAX_TOTAL_TOOL_CALLS = Number(process.env.AGENT_MAX_TOOL_CALLS ?? 100);
// Relaxed 10min → 60min so long, legitimately-working turns (builds, test
// suites, multi-step research) are not killed mid-flight. no-progress catches
// true spinning faster + more precisely than a short wall-clock ever could.
const MAX_WALL_CLOCK_MS = Number(process.env.AGENT_MAX_WALL_CLOCK_MS ?? 60 * 60_000);
// No-progress detector: abort if this many CONSECUTIVE iterations produce a
// byte-identical fingerprint (same assistant content + same tool calls + same
// tool results). 0 disables. Default 5 — tolerant of legitimate retries, but
// catches a model stuck re-issuing the same call / re-emitting the same text.
const MAX_NO_PROGRESS_ITERS = Number(process.env.AGENT_MAX_NO_PROGRESS_ITERS ?? 5);

/**
 * Pure, order-independent fingerprint of one agent iteration, used by the
 * no-progress detector. Two iterations with the same assistant text and the
 * same set of (tool name, args, result payload) tuples produce the same
 * string — regardless of the order parallel tool calls resolved in.
 *
 * Exported for unit testing the streak logic without spinning the full loop.
 */
export function computeIterationFingerprint(
  assistantContent: string,
  toolResults: Array<{ name: string; arguments: string; payload: unknown }>,
): string {
  return JSON.stringify({
    c: assistantContent,
    t: toolResults
      .map((r) => `${r.name}\u0000${r.arguments}\u0000${JSON.stringify(r.payload)}`)
      .sort(),
  });
}

export async function runAgentLoop(options: AgentExecutorOptions): Promise<AgentResult> {
  const {
    messages,
    tools,
    toolContext,
    maxIterations = MAX_ITERATIONS_DEFAULT,
    parallelToolCalls = true,
    onToolCall,
    onToolResult,
    onToolRetry,
    onToolOutputFile,
    onSubAgentStatus,
    onThinking,
    onIteration,
    onToken,
    onNewTurn,
    onStopped,
    onBudget,
    userId,
    projectId,
    depth = 0,
    sessionId,
    budget: budgetOverrides,
    signal,
    goalConfig = DEFAULT_GOAL_CONFIG,
    goalProvider,
    drainSteer,
    drainInterrupt,
  } = options;

  // IMPL [quick-win-2] Resolve effective budget limits.
  const limits: BudgetLimits = {
    maxIterations,
    maxTotalTokens: budgetOverrides?.maxTotalTokens ?? MAX_TOTAL_TOKENS,
    maxToolCalls: budgetOverrides?.maxToolCalls ?? MAX_TOTAL_TOOL_CALLS,
    maxWallClockMs: budgetOverrides?.maxWallClockMs ?? MAX_WALL_CLOCK_MS,
  };
  // No-progress ceiling (executor-internal, not part of the streamed BudgetLimits).
  const maxNoProgressIters = MAX_NO_PROGRESS_ITERS;

  const router = new LLMRouter();
  const routerModel = router.defaultModel;
  // Extract bare model name for usage logging (strip provider prefix)
  const logModel = routerModel.includes("/") ? routerModel.slice(routerModel.indexOf("/") + 1) : routerModel;

  const openAITools = tools.getOpenAITools();
  const allToolCalls: AgentResult["toolCalls"] = [];
  let fullContent = "";
  // IMPL [quick-win-2] Resource accounting for budget enforcement (mutable + streamed).
  let totalTokensSoFar = 0;
  let toolCallsSoFar = 0;
  const loopStartMs = Date.now();
  const _loopStart = Date.now();
  let stoppedReason: BudgetUsageState['stoppedReason'] | undefined;
  let lastIteration = 0;
  // No-progress detector state: fingerprint of the previous iteration and how
  // many consecutive iterations have repeated it byte-for-byte.
  let lastProgressFingerprint: string | null = null;
  let noProgressstreak = 0;
  // Content-repetition guard (Frieren fix 2026-06-05): the two fingerprint
  // detectors below live in MUTUALLY-EXCLUSIVE branches (text-only gate path
  // @765 uses empty tool results; tool-loop path @1127 uses real results) yet
  // share state. A model that ALTERNATES "same text + a tool call" with "same
  // text, no tool call" produces DIFFERENT fingerprints each iteration (t:[] vs
  // t:[result]), so the streak keeps resetting and never fires — observed live:
  // gpt-5.5 re-emitted byte-identical "第1步总结…" 10× without ever aborting.
  // This guard keys ONLY on assistant content, caught at the single chokepoint
  // both paths flow through, so identical prose N turns in a row always stops.
  let lastContentFingerprint: string | null = null;
  let sameContentStreak = 0;

  // ─── Goal Supervisor state (only active when goalConfig.enabled) ──────────
  // Resolve the active provider + objective lazily on first gate hit. The
  // objective is derived from the latest user message in the conversation.
  const goalEnabled = goalConfig.enabled === true;
  const provider: GoalProvider =
    goalProvider ?? new SimpleGoalProvider({ autonomyLevel: goalConfig.autonomyLevel });
  let activeObjective: Objective | null | undefined; // undefined = not yet resolved
  let objectiveResolved = false;
  // Independent summary cadence: emit a progress summary every summaryIntervalMs.
  let lastSummaryAt = Date.now();
  // Marks that the gate stopped to ask the user a decision (surfaced via budget).
  let needsUserDecision = false;
  // Explicit Goal-gate verdict for the OUTER round loop (goal-run.ts). null when
  // the gate never fired this turn (loop ended for a non-gate reason: iteration
  // cap, tokens, abort, etc). Set only inside the gate block below.
  let gateOutcome: 'done' | 'needsUser' | 'continue' | 'error' | null = null;

  /**
   * Emit a goal-supervisor chat message into the SAME visible stream the user
   * already sees (onToken + fullContent). The executor has no direct channel
   * handle; this is how needsUser questions / nextHint nudges / periodic
   * summaries reach the chat box (chat-handler persists fullContent + streams
   * onToken to SSE → channel_messages).
   */
  const emitChatMessage = (text: string) => {
    const block = (fullContent.endsWith("\n") || fullContent === "" ? "" : "\n\n") + text + "\n";
    fullContent += block;
    onToken?.(block);
  };

  /** Lazily resolve the active objective (the latest user message text). */
  const resolveObjective = async (): Promise<Objective | null> => {
    if (objectiveResolved) return activeObjective ?? null;
    objectiveResolved = true;
    const lastUserMsg = [...workingMessages].reverse().find((m) => m.role === "user");
    const userText =
      lastUserMsg && "content" in lastUserMsg && typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : undefined;
    try {
      activeObjective = await provider.getActiveObjective({
        userText,
        conversationId: toolContext.conversationId,
        projectId: projectId ?? undefined,
        config: goalConfig,
      });
    } catch (err) {
      console.warn("[executor] goal getActiveObjective failed:", err);
      activeObjective = null;
    }
    return activeObjective ?? null;
  };

  /** Read the current conversation todos (best-effort) for the self-eval. */
  const readTodosForEval = async (): Promise<unknown> => {
    try {
      const t = tools.get("todo_read");
      if (!t) return null;
      const r = await t.execute({}, toolContext);
      return r?.data ?? null;
    } catch {
      return null;
    }
  };


  const emitBudget = () => {
    if (!onBudget) return;
    onBudget({
      iteration: lastIteration,
      totalTokens: totalTokensSoFar,
      toolCalls: toolCallsSoFar,
      wallClockMs: Date.now() - loopStartMs,
      limits,
      stoppedReason,
    });
  };

  // Working copy of messages we'll append to during the loop
  const workingMessages = [...messages];

  // ─── Skill System: inject available skills + matched skill content ───
  if (!options._nested) {
    try {
      const availableSkills = await getAvailableSkills({
        projectId: projectId ?? undefined,
        userId: userId ?? undefined,
      });

      if (availableSkills.length > 0) {
        // [commit-6c] Replaced the hand-written <available_skills> XML with
        // renderSkillsBlock() which applies the codex-parity char budget and
        // appends the progressive-disclosure 'How to use a skill' prompt that
        // forbids delegating SKILL.md reads to sub-agents. The output is a
        // markdown block instead of XML; this is a deliberate change to align
        // with codex's `core-skills/src/render.rs` (the skill loader tool
        // load_skill_reference is still available and unchanged so existing
        // workflows keep working). Locale defaults to 'en'; 6d (followup)
        // wires locale from the user/session preference.
        const { prompt: skillSystemSection } = renderSkillsBlock({
          skills: availableSkills,
          // 128k context for the default GPT-5.5 / Claude Opus 4.x backends.
          // 6d may swap this for the resolved per-conversation model context
          // window once the executor has a stable model handle here.
          contextWindowTokens: 128_000,
          locale: "en",
        });

        // Find user message for matching
        const lastUserMsg = [...workingMessages]
          .reverse()
          .find((m) => m.role === "user");
        const userText =
          lastUserMsg && "content" in lastUserMsg && typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : "";

        const matchedSkills: { name: string; body: string; references: string[] }[] = [];
        if (userText) {
          const matched = await matchSkills(userText, availableSkills);
          for (const slug of matched) {
            const skill = await loadSkill(slug);
            if (skill) {
              matchedSkills.push({
                name: skill.name,
                body: skill.body,
                references: Object.keys(skill.references),
              });
            }
          }
        }

        // [commit-11d/sprint-3] Route the skill section through the
        // ContextManager turn-time render path instead of building it
        // inline. Byte-identical to the legacy
        // `skillSystemSection + matchedSkillContent` concatenation.
        const skillRender = await contextManager.renderById(["skills"], {
          context: "personal",
          turnState: {
            matchedSkills,
            skillSystemSection,
          },
        });
        const skillContent = skillRender.text;

        // Inject as system message
        const skillMsg: OpenAI.Chat.ChatCompletionMessageParam = {
          role: "system",
          content: skillContent,
        };
        // Insert after existing system messages
        const lastSystemIdx = workingMessages.reduce(
          (idx, m, i) => (m.role === "system" ? i : idx),
          -1
        );
        workingMessages.splice(lastSystemIdx + 1, 0, skillMsg);
      }
    } catch (err) {
      // Skill loading failure should not block the agent
      console.warn("[executor] Failed to load skills:", err);
    }
  }

  // maxRounds is now the OUTER round cap (owned by goal-run.ts); the inner
  // per-turn loop uses the caller's maxIterations. Keeping a modest inner
  // ceiling means each round is a bounded "work burst" before the outer loop
  // re-summarizes / re-judges. (Phase C decouple.)
  const effectiveMaxIterations = maxIterations;   // 32 by default, goal or not

  for (let iteration = 0; iteration < effectiveMaxIterations; iteration++) {
    lastIteration = iteration;
    // Phase 3 (C — abort): bail out of the BACKEND loop the moment the caller
    // aborts (client disconnect / Stop / in-flight message deleted). Return
    // what we have so far so chat-handler can still persist partial content.
    if (signal?.aborted) {
      console.warn("[executor] Aborted by caller signal — stopping agent loop.");
      stoppedReason = 'wall_clock';
      break;
    }
    // Live Steering — hard (照搬 Hermes interrupt(message), drained at loop top).
    // A redirect message from the user (e.g. "stop, change direction") is
    // injected as a NEW user turn; the loop then continues from there, so the
    // running agent re-plans against the new instruction instead of being
    // killed. Soft steer (below, at the tool boundary) is the gentler default;
    // this hard path is for "wrap up what you're doing and pivot NOW".
    if (drainInterrupt) {
      try {
        const redirect = await drainInterrupt();
        if (redirect && redirect.trim()) {
          workingMessages.push({ role: "user", content: redirect.trim() });
          onNewTurn?.(iteration, fullContent);
          console.info(
            `[executor] Live Steering: injected hard interrupt redirect (${redirect.length} chars).`,
          );
        }
      } catch (err) {
        console.warn("[executor] drainInterrupt failed (ignored):", err);
      }
    }
    // [commit-12 / P0-1 fix] Drain pending sub-agent stop notifications
    // and inject as SYSTEM role messages. (Originally user role, matching
    // codex; reverted to system because compaction.snapToTurnStart() looks
    // for role==="user" as a turn boundary and would treat the synthetic
    // notification as a new user turn — stealing tail-keep slot from the
    // real user's most recent input.) Marker <subagent_notification> still
    // lets the model identify the payload as a structured environment
    // signal. Mailbox is bounded (64 per conv); see context/subagent-mailbox.ts.
    if (toolContext.conversationId) {
      try {
        const pendingNotifs = drainSubagentNotifications(toolContext.conversationId);
        if (pendingNotifs.length > 0) {
          const rendered = await contextManager.renderById(["subagent-notification"], {
            context: "personal",
            turnState: { subagentNotifications: pendingNotifs },
          });
          if (rendered.text) {
            workingMessages.push({ role: "system" as const, content: rendered.text });
          }
        }
      } catch (err) {
        console.warn("[executor] sub-agent notification drain failed (ignored):", err);
      }
    }
    // IMPL [quick-win-2] Enforce token / tool / wall-clock budget; stream usage every iter.
    // 7×24: maxTotalTokens <= 0 disables the token ceiling entirely.
    if (limits.maxTotalTokens > 0 && totalTokensSoFar > limits.maxTotalTokens) {
      console.warn(`[executor] Aborting: token budget exceeded (${totalTokensSoFar}/${limits.maxTotalTokens})`);
      stoppedReason = 'tokens';
      emitBudget();
      // Inject a final assistant nudge so the LLM can summarise — done by returning early;
      // chat-handler will save fullContent so the user sees what we have.
      fullContent += `\n\n[budget] Stopped: token budget exhausted (${totalTokensSoFar}/${limits.maxTotalTokens}). Reply to continue.`;
      break;
    }
    if (toolCallsSoFar > limits.maxToolCalls) {
      console.warn(`[executor] Aborting: tool-call budget exceeded (${toolCallsSoFar}/${limits.maxToolCalls})`);
      stoppedReason = 'tool_calls';
      emitBudget();
      fullContent += `\n\n[budget] Stopped: tool-call budget exhausted (${toolCallsSoFar}/${limits.maxToolCalls}). Reply to continue.`;
      break;
    }
    if (Date.now() - loopStartMs > limits.maxWallClockMs) {
      console.warn(`[executor] Aborting: wall-clock budget exceeded (${Date.now() - loopStartMs}ms)`);
      stoppedReason = 'wall_clock';
      emitBudget();
      fullContent += `\n\n[budget] Stopped: wall-clock budget exhausted (${Math.round((Date.now() - loopStartMs) / 1000)}s). Reply to continue.`;
      break;
    }
    onIteration?.(iteration, maxIterations);
    emitBudget();
    // ─── Goal Supervisor: periodic progress summary (independent cadence) ───
    // Every summaryIntervalMs, emit a short "目标 + 已完成 + 进行中 + 下一步"
    // summary into the chat box. Pure reporting — does NOT interrupt the run.
    // Only active when the gate is enabled.
    if (goalEnabled && Date.now() - lastSummaryAt >= goalConfig.summaryIntervalMs) {
      lastSummaryAt = Date.now();
      try {
        const objective = await resolveObjective();
        if (objective) {
          const todos = await readTodosForEval();
          let todosStr: string;
          try {
            todosStr = todos == null ? "(无)" : JSON.stringify(todos);
          } catch {
            todosStr = "(无)";
          }
          let summary = "";
          const summaryStream = router.chatCompletion({
            model: routerModel,
            messages: [
              {
                role: "system" as const,
                content: "你是进度汇报器。用中文输出一段简短摘要，包含：目标 / 已完成 / 进行中 / 下一步。不要超过 6 行。",
              },
              {
                role: "user" as const,
                content: `目标：${objective.text}\n\ntodos：${todosStr}\n\n最近输出片段：${fullContent.slice(-1500)}`,
              },
            ],
            maxTokens: 400,
          });
          for await (const chunk of summaryStream) {
            const d = chunk.choices?.[0]?.delta?.content;
            if (d) summary += d;
          }
          if (summary.trim()) {
            emitChatMessage(`📋 阶段摘要\n${summary.trim()}`);
          }
        }
      } catch (err) {
        console.warn("[executor] goal periodic summary failed:", err);
      }
    }
    if (iteration > 0) {
      onNewTurn?.(iteration, fullContent);
    }
    const startMs = Date.now();
    // Trim older tool results to save context window
    trimToolResults(workingMessages);
    onThinking?.();
    const stream = router.chatCompletion({
      model: routerModel,
      messages: workingMessages,
      maxTokens: 32768,
      tools: openAITools.length > 0 ? openAITools : undefined,
    });

    // Accumulate streamed response
    let iterationContent = "";
    let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    let finishReason = "";

    // Accumulate tool calls from delta chunks
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    // Set when this iteration's request was rejected by the provider's content
    // filter (Azure Responsible-AI). Handled after the stream loop: we stop the
    // run gracefully with a chat message instead of letting the error crash the
    // whole agent loop / goal-run job.
    let contentFilterMsg: string | null = null;

    try {
      for await (const chunk of stream) {
      // Phase 3 (C — abort): stop consuming the LLM stream promptly when the
      // caller aborts mid-generation (don't wait for the iteration boundary).
      if (signal?.aborted) {
        console.warn("[executor] Aborted mid-stream — breaking token loop.");
        break;
      }
      // Track usage from final chunk
      if (chunk.usage) {
        streamUsage = chunk.usage;
      }

      // Track finish reason
      if (chunk.choices?.[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // Accumulate text content
      if (delta.content) {
        iterationContent += delta.content;
        fullContent += delta.content;
        onToken?.(delta.content);
      }

      // Accumulate tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = pendingToolCalls.get(tc.index);
          if (existing) {
            // Append arguments
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
          } else {
            // First chunk for this tool call
            pendingToolCalls.set(tc.index, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          }
        }
      }
      }
    } catch (err) {
      // Request-level content-filter rejection (Azure Responsible-AI, HTTP 400
      // code=content_filter). Deterministic — the LLMRouter already tried any
      // configured cross-provider fallback before raising this. Stop the run
      // gracefully rather than crashing the loop / marking the goal-run failed.
      if (err instanceof ContentFilterError) {
        contentFilterMsg =
          "⚠️ 这一步的请求被内容安全策略拦截了（Azure 内容过滤）。我没法在不调整表述的情况下继续这条思路。" +
          "如果这是误判，请换种说法或拆分目标后再让我继续。";
        console.warn(
          `[executor] Content-filter rejection (${err.providerKey}/${err.model}) — stopping run gracefully.`,
          err.message,
        );
      } else {
        // Any other error from the LLM stream propagates as before.
        throw err;
      }
    }

    // Handle a content-filter rejection captured above: surface a chat message,
    // flag the stop reason, and break out of the agent loop cleanly.
    if (contentFilterMsg) {
      stoppedReason = 'content_filter';
      emitChatMessage(contentFilterMsg);
      fullContent += `\n\n${contentFilterMsg}`;
      emitBudget();
      break;
    }

    // Response-level content filter: the stream completed but the model's
    // output tripped the filter mid-generation (finish_reason). Content is
    // truncated; flag it rather than treating the partial turn as a clean
    // completion that the goal gate might mistake for "done".
    if (finishReason === "content_filter") {
      const note =
        "⚠️ 模型这一轮的输出触发了内容安全过滤，回复被截断。已停止以免基于不完整内容继续推进。";
      stoppedReason = 'content_filter';
      emitChatMessage(note);
      fullContent += `\n\n${note}`;
      emitBudget();
      break;
    }

    // Log LLM usage
    if (streamUsage) {
      // IMPL [quick-win-2] Accumulate token usage for budget enforcement.
      totalTokensSoFar += streamUsage.total_tokens ?? 0;
      logLLMUsage({
        tracker: {
          module: "chat",
          operation: "agent-loop",
          userId,
          projectId,
        },
        model: logModel,
        promptTokens: streamUsage.prompt_tokens ?? 0,
        completionTokens: streamUsage.completion_tokens ?? 0,
        totalTokens: streamUsage.total_tokens ?? 0,
        latencyMs: Date.now() - startMs,
        outputChars: iterationContent.length,
      });
    }

    // Content-repetition guard — see declaration above. Catches a model stuck
    // re-emitting byte-identical assistant text across consecutive iterations,
    // independent of whether each turn also (re)issued a tool call. Only counts
    // NON-EMPTY content (empty/whitespace turns are normal between tool calls).
    // Uses the same MAX_NO_PROGRESS_ITERS budget; 0 disables.
    if (maxNoProgressIters > 0 && iterationContent.trim().length > 0) {
      if (iterationContent === lastContentFingerprint) {
        sameContentStreak++;
        if (sameContentStreak >= maxNoProgressIters) {
          console.warn(
            `[executor] Aborting: identical assistant text for ${sameContentStreak + 1} consecutive iterations (content-repetition guard).`,
          );
          stoppedReason = 'no_progress';
          emitBudget();
          fullContent += `\n\n[budget] Stopped: model repeated the same response ${sameContentStreak + 1}× without progress. Reply to continue.`;
          break;
        }
      } else {
        lastContentFingerprint = iterationContent;
        sameContentStreak = 0;
      }
    }

    // Auto-continue if token limit hit but response not complete
    if (finishReason === "length" && pendingToolCalls.size === 0) {
      workingMessages.push({ role: "assistant" as const, content: iterationContent });
      iteration--; // Don't consume this iteration
      continue;
    }

    // Phase 3 (C — abort): if aborted during this iteration's generation, stop
    // BEFORE executing any tool calls (don't kick off new side-effects).
    if (signal?.aborted) {
      console.warn("[executor] Aborted after stream — skipping tool execution, stopping loop.");
      stoppedReason = 'wall_clock';
      break;
    }

    // If no tool calls, we're done — UNLESS the Goal Supervisor gate is enabled.
    if (pendingToolCalls.size === 0) {
      // ─── Goal Supervisor completion gate ──────────────────────────────────
      // HARD REQUIREMENT: when goalConfig.enabled === false (the DEFAULT), this
      // branch behaves EXACTLY as before — a plain `break`. The gate only ever
      // activates on explicit opt-in, so existing chat flows are untouched.
      if (!goalEnabled) {
        break;
      }

      // Enabled path: ask the GoalProvider whether the objective is actually
      // done / needs the user / should continue. Any failure degrades to the
      // original break (never trap the loop on supervisor errors).
      const objective = await resolveObjective();
      if (!objective) {
        // No supervisable objective → preserve original behavior.
        break;
      }

      let gateBreak = false;
      try {
        const todos = await readTodosForEval();
        const evalResult = await provider.evaluate(objective, todos, fullContent);
        // Best-effort progress recording (no-op for SimpleGoalProvider).
        try {
          await provider.recordProgress(objective, evalResult);
        } catch (e) {
          console.warn("[executor] goal recordProgress failed:", e);
        }

        // [commit-5d] Pull live budget snapshot + tokenBudget cap from the
        // active run row so decideGateAction can short-circuit to
        // 'budgetLimited' before consulting the LLM eval.
        let budgetCheck: { tokensUsed: number; tokenBudget: number | null | undefined } | undefined;
        if (toolContext.conversationId) {
          try {
            const activeRun = await getActiveRunForConversation(
              toolContext.conversationId,
            );
            if (activeRun) {
              const snap = getGoalBudgetForConversation(
                toolContext.conversationId,
              ).snapshot();
              budgetCheck = {
                tokensUsed: snap.tokensUsed,
                tokenBudget: activeRun.tokenBudget ?? null,
              };
            }
          } catch (e) {
            // Fail-soft: missing budgetCheck → decideGateAction falls back to
            // the 3-branch behavior. We do not want a DB hiccup to block the
            // main loop from making forward progress.
            console.warn("[executor] budgetCheck lookup failed:", e);
          }
        }
        const action = decideGateAction(evalResult, goalConfig, budgetCheck);
        if (action === "done") {
          // Objective genuinely complete → normal end.
          gateOutcome = 'done';
          gateBreak = true;
        } else if (action === "needsUser") {
          // Blocked on a user decision → surface a question + stop.
          gateOutcome = 'needsUser';
          needsUserDecision = true;
          stoppedReason = undefined;
          emitChatMessage(
            `❓ 需要你的决策：${evalResult.reason ?? "遇到无法自行决定的岔路口，请指示后我继续。"}`,
          );
          gateBreak = true;
        } else if (action === "budgetLimited") {
          // [commit-5d] Token budget exhausted. Stop the loop now; the next
          // user-facing turn will load budget_limit.md via the prompt-builder
          // (commit 5a). Mirrors codex's wrap-up turn behavior.
          gateOutcome = 'done';
          stoppedReason = 'budget_limited';
          emitChatMessage(
            "⚠️ 目标预算已用完（tokens_used ≥ token_budget），本轮停止以防超支。如需继续可调 update_goal 提高预算或重启目标。",
          );
          gateBreak = true;
        } else if (action === "blocked") {
          // [commit-5d] Defensive: 'blocked' is currently only set by
          // update_goal (commit 5b/5c); decideGateAction does not return it
          // from the eval path yet, but handle it the same as needsUser so
          // future wiring is non-breaking.
          gateOutcome = 'needsUser';
          needsUserDecision = true;
          stoppedReason = 'blocked';
          emitChatMessage(
            "⚠️ 目标被标为 blocked（3 轮同一障碍）。请指示后我继续。",
          );
          gateBreak = true;
        } else {
          gateOutcome = 'continue';
          // Not done, can self-handle → inject a system nudge + CONTINUE the
          // loop (do NOT break). nextHint tells the model what's still missing.
          //
          // Anti-spin backstop for the text-only path: the byte-level
          // no-progress detector below only updates inside the tool-execution
          // block (which `continue` skips), so guard identical text-only turns
          // here too. If the model re-emits byte-identical text for
          // maxNoProgressIters consecutive turns, force-stop even when enabled.
          if (maxNoProgressIters > 0) {
            const fp = computeIterationFingerprint(iterationContent, []);
            if (fp === lastProgressFingerprint) {
              noProgressstreak++;
              if (noProgressstreak >= maxNoProgressIters) {
                console.warn(
                  `[executor] Goal gate aborting: no progress for ${noProgressstreak} identical text-only turns.`,
                );
                stoppedReason = 'no_progress';
                gateBreak = true;
              }
            } else {
              lastProgressFingerprint = fp;
              noProgressstreak = 0;
            }
          }
          if (!gateBreak) {
            const hint = evalResult.nextHint ?? "继续推进";
            // [commit-11b/sprint-3] Route the goal-nudge string through the
            // ContextManager turn-time render path so the fragment owns the
            // exact text. renderTurnTime() filters to scope='turn-time'
            // fragments; the goal-nudge fragment returns the legacy
            // "目标尚未达成，缺：${hint}..." string when turnState.goalNudgeHint
            // is set, and other turn-time fragments render empty here
            // (no matchedSkills/avoidHint in turnState). Byte-identical
            // to the legacy hand-coded message above.
            const nudgeRender = await contextManager.renderById(["goal-nudge"], {
              context: "personal",
              turnState: { goalNudgeHint: hint },
            });
            const nudgeText = nudgeRender.text.trim() ||
              `目标尚未达成，缺：${hint}。继续推进，直到目标真正完成或确实需要用户决策为止。`;
            workingMessages.push({
              role: "system" as const,
              content: nudgeText,
            });
          }
          // Fall through (no break) → next loop iteration. maxIterations /
          // maxRounds / maxTokens remain the hard fallback ceilings.
        }
      } catch (err) {
        console.warn("[executor] goal gate evaluate failed — falling back to break:", err);
        gateOutcome = 'error';
        gateBreak = true;
      }

      if (gateBreak) break;
      // action === "continue": skip the rest of this iteration's tool-execution
      // machinery (there are no tool calls) and proceed to the next turn.
      continue;
    }

    // Build the assistant message with tool_calls for the conversation
    const toolCallsForMessage: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
    for (const [, tc] of pendingToolCalls) {
      toolCallsForMessage.push({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      });
    }

    workingMessages.push({
      role: "assistant" as const,
      content: iterationContent || null,
      tool_calls: toolCallsForMessage,
    });

    // Execute tool calls (parallel or sequential)
    // [commit-12] Per-iteration collectors for hook additionalContext and
    // tool output file hints. Filled inside executeOne (one entry per
    // tool call). After the parallel/sequential block finishes we render
    // them via contextManager.renderTurnTime + push to workingMessages.
    // This keeps push ordering deterministic regardless of parallel
    // tool execution.
    const hookContextItems: string[] = [];
    const outputFileHints: Array<{ name: string; mimeType: string }> = [];
    const executeOne = async (tc: { id: string; name: string; arguments: string }) => {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch (parseErr) {
        // [P1-3 fix] Surface the parse failure to the LLM as a failed
        // ToolResult instead of silently calling the tool with {}.
        // Tools with all-optional schemas would otherwise run with empty
        // args, hiding the LLM's malformed output.
        console.warn("[executor] Failed to parse tool arguments:", tc.arguments);
        const errMsg = (parseErr as Error)?.message ?? String(parseErr);
        const result: ToolResult = {
          success: false,
          data: null,
          displayText: `Failed to parse tool arguments as JSON: ${errMsg}. Raw: ${tc.arguments.slice(0, 200)}`,
        };
        onToolCall?.(tc.name, {}, tc.id);
        onToolResult?.(tc.name, tc.id, result);
        allToolCalls.push({ name: tc.name, args: {}, result, callId: tc.id });
        return { callId: tc.id, result };
      }

      onToolCall?.(tc.name, parsedArgs, tc.id);

      // W7: per-user-tool rate-limit. One quick check per tool call; rejection
      // is rendered as a failed ToolResult so the SSE stream keeps flowing
      // (the LLM sees the error and can back off / pick a different tool).
      if (userId) {
        try {
          await requireRateLimit("user-tool", userId);
        } catch (e) {
          if (e instanceof RateLimitExceededError) {
            const retrySec = Math.max(1, Math.ceil((e.decision.resetAt - Date.now()) / 1000));
            const rlResult: ToolResult = {
              success: false,
              data: null,
              displayText: `You're calling tools too fast. Try again in ${retrySec} seconds.`,
            };
            onToolResult?.(tc.name, tc.id, rlResult);
            allToolCalls.push({ name: tc.name, args: parsedArgs, result: rlResult, callId: tc.id });
            toolCallsSoFar++;
            return { callId: tc.id, result: rlResult };
          }
          throw e;
        }
      }

      const tool = tools.get(tc.name);
      let result: ToolResult;

      if (tool?.inputSchema) {
        const parsed = tool.inputSchema.safeParse(parsedArgs);
        if (!parsed.success) {
          // P1-9: reject model-provided tool args unless they satisfy runtime schema.
          result = {
            success: false,
            data: null,
            displayText: `Invalid tool arguments: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          };
          onToolResult?.(tc.name, tc.id, result);
          allToolCalls.push({ name: tc.name, args: parsedArgs, result, callId: tc.id });
          toolCallsSoFar++;
          return { callId: tc.id, result };
        }
        parsedArgs = parsed.data;
      }

      if (!tool) {
        result = { success: false, data: null, displayText: `Unknown tool: ${tc.name}` };
      } else if (tool.type === "sub-agent" && tool.agentConfig) {
        // Async sub-agent execution via SessionManager
        const agentConfig = tool.agentConfig;
        const sessionManager = SessionManager.getInstance();

        // #4: link parent→child. Use this agent's own SessionManager session id
        // when it has one (a sub-agent spawning a grandchild); fall back to the
        // conversation id as the root parentId for the TOP-LEVEL agent (a channel
        // conversation has no SessionManager session of its own). This makes
        // getChildSessions / cascade-cancel work across the whole tree.
        const parentSessionId = sessionId ?? toolContext.conversationId;

        // #A: provider key for the per-provider TPM token bucket. Derive from
        // the agent's configured model prefix; default to "azure" (Mathub's
        // default provider) when unset, matching LLMRouter.parseModel.
        const subProviderKey = (() => {
          const m = agentConfig.model ?? "";
          const slash = m.indexOf("/");
          const prefix = slash > 0 ? m.slice(0, slash) : "";
          if (prefix === "anthropic" || prefix === "openai" || prefix === "azure") return prefix;
          return "azure";
        })();

        // #A: ONE atomic admission — depth + global cap + per-parent quota +
        // per-provider token budget, with the session created in the same
        // synchronous step (no await ⇒ no TOCTOU race). On rejection we surface
        // a visible tool result so the agent can back-pressure (serialize /
        // retry later) instead of crashing the loop.
        // [commit-4b] Pass agentName + parentAgentPath so the new session
        // gets a stable identity (nickname + ancestry). agentRole is left
        // undefined; commit 4c may wire it from agent-roles.ts.
        const parentSession = parentSessionId
          ? sessionManager.getSession(parentSessionId)
          : undefined;
        const admit = sessionManager.reserveAndCreateSession({
          parentId: parentSessionId,
          parentDepth: depth,
          userId,
          providerKey: subProviderKey,
          agentName: tc.name,
          parentAgentPath: parentSession?.agentPath,
        });
        if (!("id" in admit)) {
          // SpawnDecision (rejection). Keep the legacy bracketed reason tags so
          // existing agent prompts/parsing still recognize DEPTH/CONCURRENCY.
          const tag = admit.reason === "DEPTH_LIMIT"
            ? "DEPTH_LIMIT"
            : admit.reason === "PARENT_QUOTA"
              ? "PARENT_QUOTA"
              : admit.reason === "PROVIDER_TPM"
                ? "PROVIDER_TPM"
                : "CONCURRENCY_LIMIT";
          result = { success: false, data: null, displayText: `[${tag}] ${admit.detail ?? "sub-agent spawn refused"}, try again after some complete` };
          onToolResult?.(tc.name, tc.id, result);
          allToolCalls.push({ name: tc.name, args: parsedArgs, result, callId: tc.id });
          toolCallsSoFar++;
          return { callId: tc.id, result };
        }
        const session = admit;

        // #B: signature for this sub-task (durable-shadow + failure-memory key).
        const subTaskSig = taskSignature(tc.name, parsedArgs);

        // #B: best-effort durable INSERT (fire-and-forget; never blocks/crashes
        // the loop). The in-memory SessionManager remains the live authority.
        recordSpawn({
          id: session.id,
          parentId: parentSessionId,
          rootConversationId: toolContext.conversationId,
          userId,
          depth: depth + 1,
          providerKey: subProviderKey,
          reservedTokens: session.reservedTokens,
          agentName: tc.name,
          taskArgs: parsedArgs,
          // [commit-4c] codex-parity fields wired from session-manager (4b).
          nickname: session.nickname,
          agentPath: session.agentPath ? session.agentPath.join("/") : undefined,
          role: session.agentRole,
        });

        // #B: failure-memory recall — if an identical sub-task previously hit a
        // deterministic dead end, inject its avoidHint so the child doesn't
        // repeat the same mistake. Best-effort + bounded (single indexed
        // lookup); undefined on miss/error.
        const avoidHint = await lookupAvoidHint(toolContext.conversationId, subTaskSig);

        const subRegistry = tools.getToolsForContext({
          hasProject: !!toolContext.projectId,
          allowedTools: agentConfig.tools,
        });
        // [commit-11d/sprint-3] Route the [Avoid] hint through the
        // ContextManager turn-time render path. Byte-identical to the
        // legacy ternary: when avoidHint is empty the fragment renders ''
        // and the joined sysPrompt equals just agentConfig.systemPrompt.
        const avoidRender = await contextManager.renderById(["avoid-hint"], {
          context: "personal",
          turnState: { avoidHint: avoidHint ?? undefined },
        });
        const avoidSuffix = avoidRender.text ? `\n\n${avoidRender.text}` : "";
        const sysPrompt = [agentConfig.systemPrompt, avoidSuffix]
          .filter(Boolean)
          .join("");
        const subMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          ...(sysPrompt
            ? [{ role: "system" as const, content: sysPrompt }]
            : []),
          { role: "user" as const, content: JSON.stringify(parsedArgs) },
        ];
        session.messages = subMessages;

        // Start sub-agent in background (don't await)
        const subAgentPromise = runAgentLoop({
          messages: subMessages,
          tools: subRegistry,
          toolContext,
          // #5: inherit the parent's effective maxIterations when the sub-agent
          // tool doesn't pin its own, instead of falling back to a hard 5.
          maxIterations: agentConfig.maxIterations ?? maxIterations,
          parallelToolCalls,
          onToolCall: onToolCall
            ? (name, args, callId) => {
                // #1(a): a child tool call is activity on the child session.
                sessionManager.touchSession(session.id);
                onToolCall(`[sub-agent] ${name}`, args, callId);
              }
            : (_name, _args, _callId) => sessionManager.touchSession(session.id),
          onToolResult: onToolResult
            ? (name, callId, r) => {
                sessionManager.touchSession(session.id);
                onToolResult(`[sub-agent] ${name}`, callId, r);
              }
            : (_name, _callId, _r) => sessionManager.touchSession(session.id),
          onToken: undefined,
          userId,
          projectId,
          // #4: hand the child ITS OWN session id so when it spawns a grandchild
          // the grandchild's parentId is this child's session (true chain).
          sessionId: session.id,
          _nested: true,
          depth: depth + 1,
        });

        // [commit-4b] SubagentStart hook — fire-and-forget. Spawned
        // immediately after admission so observers see start before any tool
        // call. Errors swallowed inside withTimeout / runtime, so we don't
        // need a try/catch here.
        const subagentStartedAt = Date.now();
        void runSubagentStartHooks({
          conversationId: toolContext.conversationId,
          userId,
          childSessionId: session.id,
          parentSessionId,
          agentName: tc.name,
          agentRole: session.agentRole,
          depth: depth + 1,
        });

        // Handle background resolution
        subAgentPromise
          .then((subResult) => {
            sessionManager.updateSession(session.id, {
              status: "completed",
              result: subResult.content,
            });
            // #A: reconcile the token bucket to actual usage (refund the
            // over-reservation). reservedTokens cleared inside ⇒ idempotent.
            sessionManager.releaseSession(session.id, subResult.budget?.totalTokens);
            // #B: durable terminal UPDATE (best-effort, fire-and-forget).
            recordTerminal(session.id, "completed", {
              actualTokens: subResult.budget?.totalTokens,
              result: subResult.content,
            });
            // [commit-4b] SubagentStop hook — "completed".
            void runSubagentStopHooks({
              conversationId: toolContext.conversationId,
              userId,
              childSessionId: session.id,
              status: "completed",
              durationMs: Date.now() - subagentStartedAt,
              totalTokens: subResult.budget?.totalTokens,
              resultPreview: typeof subResult.content === "string"
                ? subResult.content.slice(0, 200)
                : undefined,
            });
            // [commit-12] Mailbox: structured notification for parent agent.
            // Drained at the top of the next iteration and injected as a
            // user-role message via subagentNotificationFragment.
            if (toolContext.conversationId) {
              enqueueSubagentNotification(toolContext.conversationId, {
                agentReference: session.id,
                status: "completed",
                durationMs: Date.now() - subagentStartedAt,
                totalTokens: subResult.budget?.totalTokens,
                resultPreview: typeof subResult.content === "string"
                  ? subResult.content.slice(0, 200)
                  : undefined,
              });
            }
            onSubAgentStatus?.(session.id, "completed", subResult.content);
          })
          .catch((err) => {
            const errorMsg = err instanceof Error ? err.message : "Sub-agent failed";
            sessionManager.updateSession(session.id, {
              status: "failed",
              result: errorMsg,
            });
            // #A: failed run won't report usage — refund the full reservation
            // (errs toward bucket availability; the minority failure path).
            sessionManager.releaseSession(session.id);
            // #B: durable terminal UPDATE + classify into failure memory so an
            // identical future sub-task can be warned off (best-effort).
            recordTerminal(session.id, "failed", { errorMsg });
            const cls = classifyFailure({ errorMsg });
            recordDeadEnd({
              rootConversationId: toolContext.conversationId,
              signature: subTaskSig,
              failureClass: cls,
              detail: errorMsg,
            });
            // [commit-4b] SubagentStop hook — "failed".
            void runSubagentStopHooks({
              conversationId: toolContext.conversationId,
              userId,
              childSessionId: session.id,
              status: "failed",
              durationMs: Date.now() - subagentStartedAt,
              resultPreview: errorMsg.slice(0, 200),
            });
            // [commit-12] Mailbox failure notification — parent agent gets
            // structured signal even when sub-agent died with an exception.
            if (toolContext.conversationId) {
              enqueueSubagentNotification(toolContext.conversationId, {
                agentReference: session.id,
                status: "failed",
                durationMs: Date.now() - subagentStartedAt,
                resultPreview: errorMsg.slice(0, 200),
              });
            }
            onSubAgentStatus?.(session.id, "failed", errorMsg);
          });

        // Return immediately with session reference
        result = {
          success: true,
          data: { sessionId: session.id, status: "running" },
          displayText: `Sub-agent started: ${session.id}`,
        };
      } else {

        const executeTool = (timeoutMs: number) => {
          let timeoutHandle: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<ToolResult>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("Tool execution timed out")), timeoutMs);
          });
          const toolPromise = tool.execute(parsedArgs, toolContext);
          return Promise.race([toolPromise, timeoutPromise]).then(
            (res) => { clearTimeout(timeoutHandle!); return res; },
            (err) => { clearTimeout(timeoutHandle!); throw err; },
          );
        };

        // [commit-4b] PreToolUse hook — may block, may mutate input. Block
        // outcomes synthesize a tool result so the loop still advances (the
        // agent sees the block and can react), but tool.execute is skipped
        // entirely. Input mutation flows into parsedArgs via the
        // toolContext-bound parsedArgs object — here we just override the
        // local for the executeTool closure path.
        const preResult = await runPreToolUseHooks({
          conversationId: toolContext.conversationId,
          userId,
          iteration,
          toolName: tc.name,
          toolCallId: tc.id,
          input: parsedArgs,
        });
        // [commit-12 / P0-3 fix] Collect any developer-context additions from
        // pre-hooks so they get injected into the conversation after this
        // tool batch. Both "continue" AND "blocked" outcomes carry
        // additionalContext now — the explanation hooks emitted before
        // a block is exactly what the LLM needs to understand the block.
        if (preResult.additionalContext.length > 0) {
          hookContextItems.push(...preResult.additionalContext);
        }
        if (preResult.kind === "blocked") {
          result = {
            success: false,
            data: null,
            displayText: `[blocked by hook ${preResult.hookName}: ${preResult.reason}]`,
          };
        } else {
          // Hook may have mutated input. We don't reassign parsedArgs here
          // (it would diverge from what the model originally requested in
          // recordings); we rely on tool.execute(parsedArgs) for now and let
          // hooks that want input mutation gate side-effects in PostToolUse.
          // TODO commit-4c: thread updatedInput through executeTool when at
          // least one hook actually mutates.
          const toolStartedAt = Date.now();
          try {
            const toolTimeoutMs = tool.timeoutMs ?? TOOL_TIMEOUT_MS;
            result = await executeTool(toolTimeoutMs);
          } catch (err) {
            result = await handleToolError(
              err,
              tc.name,
              () => executeTool(tool.timeoutMs ?? TOOL_TIMEOUT_MS),
              () => executeTool((tool.timeoutMs ?? TOOL_TIMEOUT_MS) * 2),
              onToolRetry,
            );
          }
          // [commit-4b] PostToolUse hook — observe + optionally redact
          // output. Fire-and-await: hook timeout is internal so it can't hang
          // the loop. Output mutation is rare; we just trust hooks to be
          // honest about updatedOutput.
          const postResult = await runPostToolUseHooks({
            conversationId: toolContext.conversationId,
            userId,
            iteration,
            toolName: tc.name,
            toolCallId: tc.id,
            input: parsedArgs,
            output: result,
            durationMs: Date.now() - toolStartedAt,
            success: result.success,
            errorMessage: result.success ? undefined : result.displayText,
          });
          if (postResult.updatedOutput !== undefined && postResult.updatedOutput !== null) {
            const ov = postResult.updatedOutput;
            if (
              typeof ov === "object" &&
              "success" in (ov as Record<string, unknown>) &&
              "displayText" in (ov as Record<string, unknown>)
            ) {
              result = ov as ToolResult;
            }
          }
          // [commit-12] Collect dev-context additions from post-hooks too.
          if (postResult.additionalContext.length > 0) {
            hookContextItems.push(...postResult.additionalContext);
          }
        }
      }

      onToolResult?.(tc.name, tc.id, result);

      // Emit output files (e.g., images from sandbox execution)
      if (result.success && result.data && typeof result.data === "object") {
        const data = result.data as Record<string, unknown>;
        if (Array.isArray(data.outputFiles)) {
          for (const file of data.outputFiles as { name: string; content: string; mimeType: string }[]) {
            onToolOutputFile?.(file.name, file.mimeType, file.content);
            // [commit-12] Collect a name/mime tuple so the LLM gets a
            // structured hint about what files just landed. Bytes/path are
            // intentionally omitted here (the base64 content size doesn't
            // map cleanly to a useful number; tool emitters can add them
            // later if needed).
            outputFileHints.push({ name: file.name, mimeType: file.mimeType });
          }
        }
      }

      allToolCalls.push({
        name: tc.name,
        args: parsedArgs,
        result,
        callId: tc.id,
      });
      // IMPL [quick-win-2] Count this tool call against the budget.
      toolCallsSoFar++;

      return { callId: tc.id, result };
    };

    const toolCallEntries = Array.from(pendingToolCalls.values());

    // Collect this iteration's executed (callId → result) for the no-progress
    // fingerprint below, alongside pushing tool messages for the next LLM turn.
    const iterationResults: Array<{ name: string; arguments: string; payload: unknown }> = [];

    if (parallelToolCalls && toolCallEntries.length > 1) {
      // Parallel execution
      const results = await Promise.all(toolCallEntries.map(executeOne));
      const byId = new Map(toolCallEntries.map((tc) => [tc.id, tc]));
      for (const { callId, result } of results) {
        const payload = result.success
          ? (result.data ?? { result: result.displayText })
          : { error: result.displayText, isError: true };
        workingMessages.push({
          role: "tool" as const,
          tool_call_id: callId,
          content: JSON.stringify(payload),
        });
        const tc = byId.get(callId);
        iterationResults.push({ name: tc?.name ?? callId, arguments: tc?.arguments ?? "", payload });
      }
    } else {
      // Sequential execution
      for (const tc of toolCallEntries) {
        const { callId, result } = await executeOne(tc);
        const payload = result.success
          ? (result.data ?? { result: result.displayText })
          : { error: result.displayText, isError: true };
        workingMessages.push({
          role: "tool" as const,
          tool_call_id: callId,
          content: JSON.stringify(payload),
        });
        iterationResults.push({ name: tc.name, arguments: tc.arguments, payload });
      }
    }

    // [commit-12] After tool messages are in place, inject any hook
    // additionalContext and tool output-file hints as system messages.
    // Order: hook-context first (descriptive), then image-output (specific
    // file hints) — matches the FragmentPriority ordering (700 -> 750).
    if (hookContextItems.length > 0) {
      try {
        const rendered = await contextManager.renderById(["hook-context"], {
          context: "personal",
          turnState: { hookAdditionalContext: hookContextItems },
        });
        if (rendered.text) {
          workingMessages.push({ role: "system" as const, content: rendered.text });
        }
      } catch (err) {
        console.warn("[executor] hook-context render failed (ignored):", err);
      }
    }
    if (outputFileHints.length > 0) {
      try {
        const rendered = await contextManager.renderById(["image-output-hint"], {
          context: "personal",
          turnState: { imageOutputs: outputFileHints },
        });
        if (rendered.text) {
          workingMessages.push({ role: "system" as const, content: rendered.text });
        }
      } catch (err) {
        console.warn("[executor] image-output-hint render failed (ignored):", err);
      }
    }

    // ── Live Steering — soft (照搬 Hermes _apply_pending_steer_to_tool_results) ──
    // After this tool-call batch's results are in workingMessages and BEFORE the
    // next LLM turn, drain any pending user steer and append it to the LAST
    // role:"tool" message's content with a "User guidance:" marker. We modify
    // existing content rather than insert a new message, so role alternation is
    // never broken (an OpenAI/Anthropic hard requirement). The model reads the
    // steer as part of the tool output on its next iteration — non-interrupting
    // mid-run redirection. `iterationResults.length` bounds the tail we scan.
    if (drainSteer && iterationResults.length > 0) {
      try {
        const steerText = await drainSteer();
        if (steerText && steerText.trim()) {
          let targetIdx = -1;
          const scanFrom = Math.max(
            workingMessages.length - iterationResults.length,
            0,
          );
          for (let j = workingMessages.length - 1; j >= scanFrom; j--) {
            if (workingMessages[j]?.role === "tool") {
              targetIdx = j;
              break;
            }
          }
          if (targetIdx >= 0) {
            const marker = `\n\nUser guidance: ${steerText.trim()}`;
            const existing = workingMessages[targetIdx].content;
            if (typeof existing === "string") {
              workingMessages[targetIdx].content = existing + marker;
            } else if (Array.isArray(existing)) {
              // Multimodal content blocks — append a text block (照搬 Hermes).
              workingMessages[targetIdx].content = [
                ...existing,
                { type: "text", text: marker.trimStart() },
              ] as typeof existing;
            } else {
              workingMessages[targetIdx].content = String(existing ?? "") + marker;
            }
            console.info(
              `[executor] Live Steering: delivered soft steer to last tool result (${steerText.length} chars).`,
            );
          }
          // If no tool message was found in this batch's tail, the steer is
          // dropped here; the caller's drain is idempotent and the user can
          // re-send. (Hermes re-stashes; for the DB-backed channel a re-send is
          // simpler and avoids a second write path.)
        }
      } catch (err) {
        console.warn("[executor] drainSteer failed (ignored):", err);
      }
    }

    // ── No-progress detector ──────────────────────────────────────────────
    // Fingerprint this iteration: assistant text + each tool's (name, args,
    // result payload). If `maxNoProgressIters` consecutive iterations produce
    // the SAME fingerprint, the agent is spinning (re-issuing identical calls /
    // re-emitting identical text with no new information) — abort. This is the
    // primary 7×24 runaway guard, far more precise than a wall-clock timeout.
    if (maxNoProgressIters > 0) {
      const fp = computeIterationFingerprint(iterationContent, iterationResults);
      if (fp === lastProgressFingerprint) {
        noProgressstreak++;
        if (noProgressstreak >= maxNoProgressIters) {
          console.warn(
            `[executor] Aborting: no progress for ${noProgressstreak} consecutive iterations (identical output).`,
          );
          stoppedReason = 'no_progress';
          emitBudget();
          fullContent += `\n\n[budget] Stopped: no progress — ${noProgressstreak} identical iterations in a row. Reply to continue.`;
          break;
        }
      } else {
        lastProgressFingerprint = fp;
        noProgressstreak = 0;
      }
    }
  }

  // IMPL [quick-win-2] Final budget snapshot returned to caller for persistence.
  const finalBudget: BudgetUsageState = {
    iteration: lastIteration,
    totalTokens: totalTokensSoFar,
    toolCalls: toolCallsSoFar,
    wallClockMs: Date.now() - loopStartMs,
    limits,
    stoppedReason,
  };
  emitBudget();
  // C — reliability: surface the terminal state exactly once so the background
  // goal-run job can persist the final transcript + flip run status (no silent
  // stop). `aborted` distinguishes caller cancellation from natural stop.
  onStopped?.({
    content: fullContent,
    stoppedReason,
    aborted: signal?.aborted ?? false,
    needsUserDecision,
    iteration: lastIteration,
    gateOutcome,
  });
  return { content: fullContent, toolCalls: allToolCalls, budget: finalBudget, needsUserDecision, gateOutcome };
}
