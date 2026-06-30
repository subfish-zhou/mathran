/**
 * `SessionStart` event — fires when a chat session starts (or resumes).
 * Hooks may emit `additionalContext` strings the caller may pre-load into
 * the conversation. Universal matcher only (no tool name to match against).
 */

import { invokeHookV1 } from "../invoker.js";
import type {
  HookV1Entry,
  HookV1Outcome,
  SessionStartInput,
} from "../schema.js";

export interface SessionStartRequest {
  workspace: string;
  sessionId?: string;
  /** `"startup"` / `"resume"` / etc. — opaque tag passed through to the hook. */
  source?: string;
  defaultTimeoutMs?: number;
}

export async function runSessionStart(
  entries: ReadonlyArray<HookV1Entry>,
  req: SessionStartRequest,
): Promise<HookV1Outcome> {
  const input: SessionStartInput = {
    hookEventName: "SessionStart",
    cwd: req.workspace,
  };
  if (req.sessionId !== undefined) input.sessionId = req.sessionId;
  if (req.source !== undefined) input.source = req.source;
  return invokeHookV1(entries, "SessionStart", input, {
    cwd: req.workspace,
    matcherInputs: [],
    ...(req.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: req.defaultTimeoutMs }
      : {}),
  });
}
