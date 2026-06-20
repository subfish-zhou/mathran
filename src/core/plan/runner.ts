/**
 * Plan-mode runner (v0.3 §13).
 *
 * Drives one constrained `ChatSession.send()` against the user's planning
 * objective and captures the assistant's final markdown plan. The session is
 * curated read-only in two senses:
 *
 *   1. **Tool curation** — the only tools we wire into the session are
 *      `search` (built-in subagent dispatch, Task 8) and `read_file_summary`
 *      (Task 9). The caller passes no extra tools. There is no `lean_check`,
 *      no `write_file`, no shell.
 *   2. **System prompt** — the persona pins the assistant in plan mode and
 *      asks it to end with a fenced `# Plan` heading so the runner can
 *      cleanly extract the plan body.
 *
 * Note: this is **policy**, not a sandbox. If the underlying LLM has any
 * other escape hatch (e.g. provider-side built-in browsing) we don't control
 * it. The plan accept flow gives the user a chance to review before any
 * effort is created.
 */

import { ChatSession } from "../chat/session.js";
import type { ChatEvent } from "../chat/index.js";
import type { LLMProvider } from "../providers/llm.js";
import { IDENTITY_FRAGMENT, PLAN_MODE_FRAGMENT } from "../prompts/index.js";

import { PlanStore, type Plan } from "./store.js";

/**
 * System prompt for plan mode. Exported so tests can assert on its
 * substance and so the CLI/REST can echo it for transparency.
 *
 * Composed from the canonical fragments in `src/core/prompts/`. The
 * IDENTITY fragment ensures the model still knows it's mathran (some
 * providers behave differently if identity isn't pinned), and the
 * PLAN_MODE_FRAGMENT carries the read-only tool policy + required
 * output schema (## Approach, ## Steps, ## Key files, ## Risks,
 * ## Acceptance) that downstream plan rendering relies on.
 */
export const PLAN_SYSTEM_PROMPT = `${IDENTITY_FRAGMENT}

${PLAN_MODE_FRAGMENT}`;

export interface RunPlanOpts {
  /** What the user asked you to plan. Frozen as the first user message. */
  objective: string;
  /** Workspace root — also where the plan record is persisted. */
  workspace: string;
  /** Already-configured LLM (router or direct provider). */
  llm: LLMProvider;
  /** Model id to pass through to the provider. */
  model: string;
  /**
   * Maximum LLM rounds before forcibly stopping. Default 10. A "round" here
   * is one `ChatSession.send()` invocation that may loop through tool calls.
   * Plan mode usually finishes in 1 round; tool calls don't count toward
   * this limit (they're absorbed inside `send`).
   */
  maxTurns?: number;
  /** Cancellation signal threaded into the underlying chat session. */
  abortSignal?: AbortSignal;
  /**
   * Override the system prompt. Tests pass a shorter one; production callers
   * should leave this unset so they get {@link PLAN_SYSTEM_PROMPT}.
   */
  systemPrompt?: string;
  /**
   * Optional progress sink (v0.16 §9 audit #2). When set, the runner forwards
   * the in-session text deltas and round transitions so the HTTP layer can
   * re-emit them as SSE frames. The CLI doesn't pass this; tests don't need
   * it either. Throwing inside the callback is swallowed — the runner must
   * not let a flaky sink crash a plan in flight.
   */
  onEvent?: (ev: PlanEvent) => void;
  /**
   * Pre-existing plan id to reuse instead of minting + creating a fresh one
   * (v0.16 §9 audit #2). The HTTP layer reserves the record up front so it
   * can return `{ planId }` synchronously to the SPA, then hands the same id
   * back here so the runner doesn't create a duplicate. When omitted, the
   * runner creates its own record as before (CLI / tests path).
   */
  planId?: string;
}

/**
 * Events emitted during a plan run when `onEvent` is supplied. Shaped after
 * the chat SSE envelope so the SPA can re-use its event reader patterns.
 */
export type PlanEvent =
  | { type: "token"; delta: string }
  | { type: "step"; round: number; finishReason: string }
  | {
      type: "done";
      planId: string;
      body: string;
      turns: number;
      truncated: boolean;
      aborted: boolean;
    }
  | { type: "error"; message: string };

export interface PlanResult {
  /** The id of the saved plan record. */
  planId: string;
  /** Extracted plan markdown (may equal the full final message body). */
  body: string;
  /** How many LLM rounds the runner ran (>=1 on success). */
  turns: number;
  /** True when `maxTurns` cut the run short. */
  truncated: boolean;
  /** True when the run stopped because the abort signal fired. */
  aborted: boolean;
}

/**
 * Extract the plan body from a final assistant message.
 *
 * Strategy: find the FIRST occurrence of a Markdown heading whose text
 * begins with `Plan` (case-insensitive, allowing 1+ leading `#`). If found,
 * return everything from that heading onward. Otherwise the entire trimmed
 * message body is the plan.
 *
 * This is intentionally permissive: a model that writes `# Plan`,
 * `## Plan`, `# PLAN`, or `## Plan: deep-dive` all parse correctly.
 */
export function extractPlanBody(text: string): string {
  if (!text || text.length === 0) return "";
  const match = /^#+\s*Plan\b.*$/im.exec(text);
  if (!match || match.index === undefined) return text.trim();
  return text.slice(match.index).trim();
}

/**
 * Run one planning conversation and return the resulting plan record id +
 * body. Throws on transport errors; returns `aborted: true` instead of
 * throwing on `AbortError` to keep the CLI exit path simple.
 */
export async function runPlan(opts: RunPlanOpts): Promise<PlanResult> {
  const maxTurns = opts.maxTurns ?? 10;
  const systemPrompt = opts.systemPrompt ?? PLAN_SYSTEM_PROMPT;
  const store = new PlanStore({ workspace: opts.workspace });
  // Use the caller-supplied draft if it's still around; otherwise mint a new
  // one. We tolerate a stale `opts.planId` (deleted on disk) by falling back
  // to `create()` so the runner's contract stays "always produce a record".
  let plan: Plan;
  if (opts.planId) {
    const existing = await store.get(opts.planId);
    plan = existing ?? (await store.create(opts.objective, opts.model));
  } else {
    plan = await store.create(opts.objective, opts.model);
  }

  const session = new ChatSession({
    llm: opts.llm,
    model: opts.model,
    systemPrompt,
    // Read-only tool curation: only the two built-ins. Caller supplies no
    // extras — and we deliberately don't accept extras through opts.
    tools: [],
    builtinTools: { search: true, read_file_summary: true },
    workspace: opts.workspace,
    // Generous tool-round budget: plan-mode conversations might do many
    // search/read calls inside a single send().
    maxToolRounds: 16,
  });

  let turns = 0;
  let aborted = false;
  let truncated = false;
  let lastText = "";
  let userMessage: string = opts.objective;

  const safeEmit = (ev: PlanEvent) => {
    if (!opts.onEvent) return;
    try {
      opts.onEvent(ev);
    } catch {
      // never let a flaky sink crash an in-flight plan
    }
  };

  for (let i = 0; i < maxTurns; i++) {
    if (opts.abortSignal?.aborted) {
      aborted = true;
      break;
    }
    let textBuf = "";
    let finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error" = "stop";
    try {
      for await (const ev of session.send(userMessage, {
        ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
      }) as AsyncIterable<ChatEvent>) {
        if (ev.type === "text") {
          textBuf += ev.delta;
          safeEmit({ type: "token", delta: ev.delta });
        } else if (ev.type === "done") {
          finishReason = ev.finishReason;
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        aborted = true;
        if (textBuf.length > 0) lastText = textBuf;
        break;
      }
      throw err;
    }
    turns++;
    if (textBuf.length > 0) lastText = textBuf;
    safeEmit({ type: "step", round: turns, finishReason });

    // Plan mode is one-shot in the common case: as soon as the assistant
    // finishes a turn with no further tool calls (finishReason !== "tool_calls"),
    // we treat its text as the plan and stop.
    if (finishReason !== "tool_calls") {
      break;
    }

    // If we got here the model wanted more tool work but ChatSession already
    // ran maxToolRounds rounds inside `send`. Nudge it to wrap up the plan.
    userMessage =
      "You've used your in-session tool budget. Stop investigating and finalize the plan now. " +
      "End your response with a `# Plan` heading and the actionable plan body.";
  }

  if (turns >= maxTurns && !aborted) {
    truncated = true;
  }

  const body = extractPlanBody(lastText);
  await store.setBody(plan.id, body);

  const result: PlanResult = {
    planId: plan.id,
    body,
    turns,
    truncated,
    aborted,
  };
  safeEmit({
    type: "done",
    planId: result.planId,
    body: result.body,
    turns: result.turns,
    truncated: result.truncated,
    aborted: result.aborted,
  });
  return result;
}
