/**
 * `PostToolUse` event — fires AFTER a tool ran (success or failure). Cannot
 * block (the tool already executed). Hooks may emit `additionalContext` that
 * the caller may inject into the conversation.
 */

import { aliasesForTool } from "../aliases.js";
import { invokeHookV1 } from "../invoker.js";
import type {
  HookV1Entry,
  HookV1Outcome,
  PostToolUseInput,
} from "../schema.js";

export interface PostToolUseRequest {
  workspace: string;
  sessionId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: { ok: boolean; content: string };
  toolUseId?: string;
  defaultTimeoutMs?: number;
}

export async function runPostToolUse(
  entries: ReadonlyArray<HookV1Entry>,
  req: PostToolUseRequest,
): Promise<HookV1Outcome> {
  const input: PostToolUseInput = {
    hookEventName: "PostToolUse",
    cwd: req.workspace,
    toolName: req.toolName,
    toolInput: req.toolInput,
    toolResult: req.toolResult,
  };
  if (req.sessionId !== undefined) input.sessionId = req.sessionId;
  if (req.toolUseId !== undefined) input.toolUseId = req.toolUseId;
  return invokeHookV1(entries, "PostToolUse", input, {
    cwd: req.workspace,
    matcherInputs: [req.toolName, ...aliasesForTool(req.toolName)],
    ...(req.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: req.defaultTimeoutMs }
      : {}),
  });
}
