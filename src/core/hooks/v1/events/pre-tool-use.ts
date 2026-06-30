/**
 * `PreToolUse` event — fires before a tool runs. Hooks may BLOCK the call
 * (`decision: "block"`) or REWRITE its input (`updated_input: {...}`).
 *
 *   - matcher inputs: [<canonical tool name>, ...claude-code aliases]
 *   - stdin payload:  PreToolUseInput (toolName, toolInput, …)
 *   - block behaviour: caller short-circuits with `{ ok: false, content: reason }`
 */

import { aliasesForTool } from "../aliases.js";
import { invokeHookV1 } from "../invoker.js";
import type {
  HookV1Entry,
  HookV1Outcome,
  PreToolUseInput,
} from "../schema.js";

export interface PreToolUseRequest {
  workspace: string;
  sessionId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
  /** Optional override for the default 30 s timeout (ms). */
  defaultTimeoutMs?: number;
}

export async function runPreToolUse(
  entries: ReadonlyArray<HookV1Entry>,
  req: PreToolUseRequest,
): Promise<HookV1Outcome> {
  const input: PreToolUseInput = {
    hookEventName: "PreToolUse",
    cwd: req.workspace,
    toolName: req.toolName,
    toolInput: req.toolInput,
  };
  if (req.sessionId !== undefined) input.sessionId = req.sessionId;
  if (req.toolUseId !== undefined) input.toolUseId = req.toolUseId;
  return invokeHookV1(entries, "PreToolUse", input, {
    cwd: req.workspace,
    matcherInputs: [req.toolName, ...aliasesForTool(req.toolName)],
    ...(req.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: req.defaultTimeoutMs }
      : {}),
  });
}
