/**
 * Hook runtime — executes registered hooks in priority order with timeout
 * and error isolation.
 *
 * Conventions (apply uniformly to all 8 entry points):
 *
 *   - Each hook is wrapped in withTimeout(p, name). Default 5000 ms, override
 *     via MATHUB_HOOK_TIMEOUT_MS env.
 *   - Timeout / throw → captured + logged as console.warn, treated as null
 *     outcome (== "continue, no mutation"). Never breaks the chain.
 *   - Each invocation gets a fresh hookId (uuid v4) + emittedAtMs.
 *   - Input mutation in PreToolUse / output mutation in PostToolUse flows
 *     left-to-right: each subsequent hook sees the previous hook's updated
 *     value.
 *   - injectContext additionalContext entries are accumulated as separate
 *     strings (caller decides how to splice them into the conversation).
 *
 * Inspired by codex-rs/core/src/hook_runtime.rs. Mathub keeps zero third-party
 * deps (Promise + setTimeout only); no EventEmitter / async-mutex / OTel —
 * those can layer above this module if needed.
 *
 * Ported: 2026-06-10 (commit 2/6 of mathub-ai-codex-upgrade).
 */

import { randomUUID } from "node:crypto";

import {
  HookEventName,
  type HookEventContext,
  type PreToolUseEvent,
  type PreToolUseOutcome,
  type PostToolUseEvent,
  type PostToolUseOutcome,
  type PreCompactEvent,
  type PreCompactOutcome,
  type PostCompactEvent,
  type ObserveOutcome,
  type SessionStartEvent,
  type UserPromptSubmitEvent,
  type SubagentStartEvent,
  type SubagentStopEvent,
  type StopEvent,
} from "./types";
import {
  getPreToolUseHooks,
  getPostToolUseHooks,
  getPreCompactHooks,
  getPostCompactHooks,
  getSessionStartHooks,
  getUserPromptSubmitHooks,
  getSubagentLifecycleHooks,
  getStopHooks,
} from "./registry";

// ─── Timeout utility ─────────────────────────────────────────────────

/** Read hook timeout from env at call time so tests can change it. */
function hookTimeoutMs(): number {
  const raw = process.env.MATHUB_HOOK_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/**
 * Race a hook promise against a timer. On timeout, the underlying promise is
 * abandoned (it cannot be cancelled, but no reference is retained).
 * Returns `null` on timeout/throw; caller treats null as "no mutation".
 */
async function withTimeout<T>(
  p: Promise<T>,
  hookName: string,
  eventName: string,
): Promise<T | null> {
  const timeoutMs = hookTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `hook ${hookName} (${eventName}) timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
    });
    return await Promise.race([p, timeoutPromise]);
  } catch (err) {
    // Intentionally swallow; hook errors must not break the chain.
    console.warn(
      `[hook:${eventName}] ${hookName} failed: ${(err as Error)?.message ?? String(err)}`,
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Event context helpers ───────────────────────────────────────────

/** Drop-in context for the caller; runtime fills hookId + emittedAtMs. */
export type PartialContext = Omit<HookEventContext, "hookId" | "emittedAtMs">;

function makeContext(partial: PartialContext): HookEventContext {
  return {
    ...partial,
    hookId: randomUUID(),
    emittedAtMs: Date.now(),
  };
}

// ─── PreToolUse ──────────────────────────────────────────────────────

export type PreToolUseRunInput = PartialContext & {
  toolName: string;
  toolCallId: string;
  input: unknown;
};

export type PreToolUseRunResult =
  | {
      kind: "continue";
      updatedInput: unknown;
      additionalContext: string[];
    }
  | {
      kind: "blocked";
      reason: string;
      hookName: string;
      /** [P0-3 fix] dev-context items accumulated by earlier hooks in the
       *  chain BEFORE this one blocked. Caller should still inject these
       *  so the LLM sees the "why" the prior hooks wanted to explain. */
      additionalContext: string[];
    };

export async function runPreToolUseHooks(
  args: PreToolUseRunInput,
): Promise<PreToolUseRunResult> {
  const { toolName, toolCallId, input, ...ctx } = args;
  let currentInput = input;
  const additionalContext: string[] = [];

  for (const hook of getPreToolUseHooks()) {
    const event: PreToolUseEvent = {
      ...makeContext(ctx),
      event: HookEventName.PreToolUse,
      toolName,
      toolCallId,
      input: currentInput,
    };

    const outcome: PreToolUseOutcome | null = await withTimeout(
      hook.run(event),
      hook.name,
      HookEventName.PreToolUse,
    );
    if (outcome === null) continue;

    if (outcome.kind === "blocked") {
      // [P0-3 fix] forward already-accumulated additionalContext so the
      // executor can still inject the "explanation" hooks ran before the
      // block. Without this those inject hints are silently lost.
      return {
        kind: "blocked",
        reason: outcome.reason,
        hookName: hook.name,
        additionalContext,
      };
    }
    if (outcome.kind === "injectContext") {
      additionalContext.push(outcome.additionalContext);
      continue;
    }
    // kind === "continue"
    if (outcome.updatedInput !== undefined) {
      currentInput = outcome.updatedInput;
    }
  }
  return { kind: "continue", updatedInput: currentInput, additionalContext };
}

// ─── PostToolUse ─────────────────────────────────────────────────────

export type PostToolUseRunInput = PartialContext & {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
};

export interface PostToolUseRunResult {
  updatedOutput: unknown;
  additionalContext: string[];
}

export async function runPostToolUseHooks(
  args: PostToolUseRunInput,
): Promise<PostToolUseRunResult> {
  const {
    toolName,
    toolCallId,
    input,
    output: initialOutput,
    durationMs,
    success,
    errorMessage,
    ...ctx
  } = args;
  let currentOutput = initialOutput;
  const additionalContext: string[] = [];

  for (const hook of getPostToolUseHooks()) {
    const event: PostToolUseEvent = {
      ...makeContext(ctx),
      event: HookEventName.PostToolUse,
      toolName,
      toolCallId,
      input,
      output: currentOutput,
      durationMs,
      success,
      errorMessage,
    };

    const outcome: PostToolUseOutcome | null = await withTimeout(
      hook.run(event),
      hook.name,
      HookEventName.PostToolUse,
    );
    if (outcome === null) continue;

    if (outcome.kind === "injectContext") {
      additionalContext.push(outcome.additionalContext);
      continue;
    }
    if (outcome.updatedOutput !== undefined) {
      currentOutput = outcome.updatedOutput;
    }
  }
  return { updatedOutput: currentOutput, additionalContext };
}

// ─── PreCompact ──────────────────────────────────────────────────────

export type PreCompactRunInput = PartialContext & {
  reason: PreCompactEvent["reason"];
  phase: PreCompactEvent["phase"];
  inputMessages: number;
  inputTokens: number;
};

export interface PreCompactRunResult {
  proceed: boolean;
  skipReason?: string;
  skipHookName?: string;
}

export async function runPreCompactHooks(
  args: PreCompactRunInput,
): Promise<PreCompactRunResult> {
  const { reason, phase, inputMessages, inputTokens, ...ctx } = args;

  for (const hook of getPreCompactHooks()) {
    const event: PreCompactEvent = {
      ...makeContext(ctx),
      event: HookEventName.PreCompact,
      reason,
      phase,
      inputMessages,
      inputTokens,
    };

    const outcome: PreCompactOutcome | null = await withTimeout(
      hook.run(event),
      hook.name,
      HookEventName.PreCompact,
    );
    if (outcome === null) continue;

    if (outcome.kind === "skip") {
      return {
        proceed: false,
        skipReason: outcome.reason,
        skipHookName: hook.name,
      };
    }
  }
  return { proceed: true };
}

// ─── PostCompact ─────────────────────────────────────────────────────

export type PostCompactRunInput = PartialContext & {
  telemetry: PostCompactEvent["telemetry"];
};

export async function runPostCompactHooks(
  args: PostCompactRunInput,
): Promise<void> {
  const { telemetry, ...ctx } = args;

  for (const hook of getPostCompactHooks()) {
    const event: PostCompactEvent = {
      ...makeContext(ctx),
      event: HookEventName.PostCompact,
      telemetry,
    };

    await withTimeout(hook.run(event), hook.name, HookEventName.PostCompact);
  }
}

// ─── SessionStart ────────────────────────────────────────────────────

export type SessionStartRunInput = PartialContext & {
  scope: SessionStartEvent["scope"];
  scopeId?: string;
  initialMessageCount: number;
};

export async function runSessionStartHooks(
  args: SessionStartRunInput,
): Promise<void> {
  const { scope, scopeId, initialMessageCount, ...ctx } = args;

  for (const hook of getSessionStartHooks()) {
    const event: SessionStartEvent = {
      ...makeContext(ctx),
      event: HookEventName.SessionStart,
      scope,
      scopeId,
      initialMessageCount,
    };

    await withTimeout(hook.run(event), hook.name, HookEventName.SessionStart);
  }
}

// ─── UserPromptSubmit ────────────────────────────────────────────────

export type UserPromptSubmitRunInput = PartialContext & {
  messageId: string;
  textPreview: string;
  attachmentCount: number;
};

export async function runUserPromptSubmitHooks(
  args: UserPromptSubmitRunInput,
): Promise<void> {
  const { messageId, textPreview, attachmentCount, ...ctx } = args;

  for (const hook of getUserPromptSubmitHooks()) {
    const event: UserPromptSubmitEvent = {
      ...makeContext(ctx),
      event: HookEventName.UserPromptSubmit,
      messageId,
      textPreview,
      attachmentCount,
    };

    await withTimeout(
      hook.run(event),
      hook.name,
      HookEventName.UserPromptSubmit,
    );
  }
}

// ─── SubagentStart / SubagentStop ────────────────────────────────────

export type SubagentStartRunInput = PartialContext & {
  childSessionId: string;
  parentSessionId?: string;
  agentName?: string;
  agentRole?: string;
  depth: number;
};

export async function runSubagentStartHooks(
  args: SubagentStartRunInput,
): Promise<void> {
  const { childSessionId, parentSessionId, agentName, agentRole, depth, ...ctx } =
    args;

  for (const hook of getSubagentLifecycleHooks()) {
    if (!hook.runStart) continue;
    const event: SubagentStartEvent = {
      ...makeContext(ctx),
      event: HookEventName.SubagentStart,
      childSessionId,
      parentSessionId,
      agentName,
      agentRole,
      depth,
    };

    await withTimeout(
      hook.runStart(event),
      hook.name,
      HookEventName.SubagentStart,
    );
  }
}

export type SubagentStopRunInput = PartialContext & {
  childSessionId: string;
  status: SubagentStopEvent["status"];
  durationMs: number;
  totalTokens?: number;
  resultPreview?: string;
};

export async function runSubagentStopHooks(
  args: SubagentStopRunInput,
): Promise<void> {
  const { childSessionId, status, durationMs, totalTokens, resultPreview, ...ctx } =
    args;

  for (const hook of getSubagentLifecycleHooks()) {
    if (!hook.runStop) continue;
    const event: SubagentStopEvent = {
      ...makeContext(ctx),
      event: HookEventName.SubagentStop,
      childSessionId,
      status,
      durationMs,
      totalTokens,
      resultPreview,
    };

    await withTimeout(
      hook.runStop(event),
      hook.name,
      HookEventName.SubagentStop,
    );
  }
}

// ─── Stop ────────────────────────────────────────────────────────────

export type StopRunInput = PartialContext & {
  reason: StopEvent["reason"];
};

export async function runStopHooks(args: StopRunInput): Promise<void> {
  const { reason, ...ctx } = args;

  for (const hook of getStopHooks()) {
    const event: StopEvent = {
      ...makeContext(ctx),
      event: HookEventName.Stop,
      reason,
    };

    await withTimeout(hook.run(event), hook.name, HookEventName.Stop);
  }
}

// Re-export ObserveOutcome consumer type so test files don't need to dive into ./types.
export type { ObserveOutcome };
