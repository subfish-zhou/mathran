/**
 * `PreCompact` event — fires BEFORE a compaction attempt. Hooks may block.
 * `PostCompact` event — fires AFTER a compaction attempt (block has no effect).
 */

import { invokeHookV1 } from "../invoker.js";
import type {
  HookV1Entry,
  HookV1Outcome,
  PostCompactInput,
  PreCompactInput,
} from "../schema.js";

export interface PreCompactRequest {
  workspace: string;
  sessionId?: string;
  phase?: string;
  reason?: string;
  defaultTimeoutMs?: number;
}

export async function runPreCompact(
  entries: ReadonlyArray<HookV1Entry>,
  req: PreCompactRequest,
): Promise<HookV1Outcome> {
  const input: PreCompactInput = {
    hookEventName: "PreCompact",
    cwd: req.workspace,
  };
  if (req.sessionId !== undefined) input.sessionId = req.sessionId;
  if (req.phase !== undefined) input.phase = req.phase;
  if (req.reason !== undefined) input.reason = req.reason;
  return invokeHookV1(entries, "PreCompact", input, {
    cwd: req.workspace,
    matcherInputs: [],
    ...(req.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: req.defaultTimeoutMs }
      : {}),
  });
}

export interface PostCompactRequest {
  workspace: string;
  sessionId?: string;
  phase?: string;
  reason?: string;
  status?: string;
  droppedRoundCount?: number;
  defaultTimeoutMs?: number;
}

export async function runPostCompact(
  entries: ReadonlyArray<HookV1Entry>,
  req: PostCompactRequest,
): Promise<HookV1Outcome> {
  const input: PostCompactInput = {
    hookEventName: "PostCompact",
    cwd: req.workspace,
  };
  if (req.sessionId !== undefined) input.sessionId = req.sessionId;
  if (req.phase !== undefined) input.phase = req.phase;
  if (req.reason !== undefined) input.reason = req.reason;
  if (req.status !== undefined) input.status = req.status;
  if (req.droppedRoundCount !== undefined) {
    input.droppedRoundCount = req.droppedRoundCount;
  }
  return invokeHookV1(entries, "PostCompact", input, {
    cwd: req.workspace,
    matcherInputs: [],
    ...(req.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: req.defaultTimeoutMs }
      : {}),
  });
}
