/**
 * Code mode v1 — the `run_code_mode` LLM-callable tool.
 *
 * `createCodeModeTool({ tools, ... })` returns a {@link ToolSpec} that the
 * model can call once to execute a whole JS script that itself drives several
 * mathran tools. The script's exported value (plus a small meta envelope) is
 * fed back as the tool result.
 *
 * Tool whitelist policy
 * ---------------------
 * Out of the entire ChatSession tool registry, only the names listed in
 * {@link DEFAULT_ALLOWED_TOOLS} are exposed by default — all read-only, and
 * all matching the most common "scan workspace + extract" workflow:
 *
 *   read_file, glob, grep, list_dir (alias for glob "**\/*")
 *
 * Callers can extend the whitelist via `allowWrite: true` (adds write_file,
 * edit_file, apply_patch) and / or `allowBash: true` (adds bash).
 *
 * Why a whitelist and not "everything" — the LLM cannot escape the QuickJS
 * sandbox, but it CAN drive any mathran tool we bind. Exposing destructive
 * tools by default would let a hallucinated script `await bash({cmd: "rm -rf ~"})`
 * with no approval prompt (code-mode bypasses the per-tool approval gate by
 * design — that's the whole point of folding 60 round-trips into one).
 *
 * Result envelope
 * ---------------
 * The tool result is a JSON-stringified envelope:
 *
 *     {
 *       result: "<the script's return value, JSON-stringified>",
 *       toolCalls: 12,
 *       durationMs: 845,
 *       toolTrace: ["glob", "read_file", "read_file", ...],
 *     }
 *
 * On failure:
 *
 *     {
 *       error: "<one-line reason>",
 *       toolCalls: 3,
 *       durationMs: 1234,
 *       interrupted: false,
 *       oom: false,
 *       toolTrace: [...],
 *     }
 *
 * The model is told this contract in the tool description so it knows how to
 * parse the response.
 */

import type { ToolSpec, ToolExecuteContext } from "../chat/session.js";
import { runScript } from "./runtime.js";
import {
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
} from "./limits.js";
import type { ToolBinding } from "./types.js";

/**
 * Tool names exposed inside the sandbox by default. All read-only.
 *
 * `list_dir` is intentionally NOT in this set because mathran currently has
 * no dedicated `list_dir` tool — listing is done via `glob('**\/*')`. We
 * keep the docs honest: the model is told "use glob with a pattern".
 */
export const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  "read_file",
  "glob",
  "grep",
  // Read-only project / wiki helpers, exposed when they happen to be wired:
  "search_wiki",
  "read_wiki_page",
  "list_wiki_pages",
  "read_doc_page",
  "list_doc_pages",
  "list_projects",
  "read_project_metadata",
  "list_efforts",
  "read_effort",
];

/** Additional tools enabled when `allowWrite: true`. */
export const WRITE_ALLOWED_TOOLS: readonly string[] = [
  "write_file",
  "edit_file",
  "apply_patch",
  // Per-conversation scratchpad write is harmless (own subtree).
  "scratchpad_write",
];

/** Additional tools enabled when `allowBash: true`. Includes computed ones. */
export const BASH_ALLOWED_TOOLS: readonly string[] = [
  "bash",
  "run_python",
];

export interface CodeModeToolOptions {
  /**
   * The full list of `ToolSpec`s the host ChatSession has wired. The code-mode
   * tool filters this through the whitelist at CALL TIME (not construction
   * time), so a session that conditionally registers tools later still sees
   * them. We accept a thunk to support that pattern; for static sessions a
   * plain array works fine.
   */
  tools: ToolSpec[] | (() => ToolSpec[]);
  /** Workspace root threaded into bound tools. Optional. */
  workspace?: string;
  /** Extra tool names to allow (additive on top of the defaults). */
  extraAllowedTools?: readonly string[];
  /** If true, add the {@link WRITE_ALLOWED_TOOLS}. Default: false. */
  allowWrite?: boolean;
  /** If true, add the {@link BASH_ALLOWED_TOOLS}. Default: false. */
  allowBash?: boolean;
  /** Override the default 256 MiB memory cap. */
  memoryLimitBytes?: number;
  /** Override the default 60 s wall-clock cap. */
  timeoutMs?: number;
}

/**
 * Build the {@link ToolSpec} the host registers as `run_code_mode`.
 *
 * The closure captures `opts.tools` so the SAME object the session uses for
 * tool dispatch is what we filter — no risk of drift.
 */
export function createCodeModeTool(opts: CodeModeToolOptions): ToolSpec {
  const memLimit = opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const allow = new Set<string>([
    ...DEFAULT_ALLOWED_TOOLS,
    ...(opts.allowWrite ? WRITE_ALLOWED_TOOLS : []),
    ...(opts.allowBash ? BASH_ALLOWED_TOOLS : []),
    ...(opts.extraAllowedTools ?? []),
  ]);

  return {
    name: "run_code_mode",
    // We classify this as "exec" because the script may invoke any whitelisted
    // tool — its risk envelope is the UNION of the bound tools'. Hosts that
    // gate "exec" through approval will catch code-mode at the front door.
    riskClass: "exec",
    // NOT read-only: even with the default whitelist a malicious script could
    // exhaust the model's tool-call budget. Plan mode keeps code-mode disabled
    // — that matches plan mode's overall "no side effects" stance.
    readOnly: false,
    description: buildDescription(allow, opts.allowWrite, opts.allowBash, memLimit, timeoutMs),
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "JavaScript source executed inside a sandboxed QuickJS VM. Top-level await works. " +
            "Return a JSON-serializable value (string / number / object / array). " +
            "Throws inside the script propagate as `error` in the envelope. " +
            "Available globals: the whitelisted mathran tools listed in this tool's description, " +
            "each callable as `await <name>({ ...args })`.",
        },
      },
      required: ["script"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const script = typeof args.script === "string" ? args.script : "";
      if (!script.trim()) {
        return { ok: false, content: "code_mode error: 'script' must be non-empty string" };
      }
      const allTools = typeof opts.tools === "function" ? opts.tools() : opts.tools;
      const bindings: ToolBinding[] = [];
      for (const t of allTools) {
        if (allow.has(t.name)) {
          bindings.push({ name: t.name, tool: t });
        }
      }
      if (bindings.length === 0) {
        // Defensive — at least one bound tool means at least *some* useful work
        // can happen. With zero we'd run pure JS, which has its own uses but is
        // also confusing as a default — surface the misconfiguration clearly.
        return {
          ok: false,
          content:
            "code_mode error: no tools are bound (session registered none of the whitelisted names)",
        };
      }
      const res = await runScript({
        script,
        bindings,
        ctx: buildCtx(ctx, opts.workspace),
        memoryLimitBytes: memLimit,
        timeoutMs,
      });
      if (!res.ok) {
        return {
          ok: false,
          content: JSON.stringify({
            error: res.error,
            toolCalls: res.meta.toolCalls,
            durationMs: res.meta.durationMs,
            interrupted: res.meta.interrupted,
            oom: res.meta.oom,
            toolTrace: res.meta.toolTrace,
          }),
        };
      }
      return {
        ok: true,
        content: JSON.stringify({
          result: res.result ?? "",
          toolCalls: res.meta.toolCalls,
          durationMs: res.meta.durationMs,
          toolTrace: res.meta.toolTrace,
        }),
      };
    },
  };
}

/**
 * Merge the call-site `ctx` with a builder-time `workspace` so bound tools
 * see the same `ctx.workspace` they'd see via direct tool-call dispatch.
 */
function buildCtx(
  ctx: ToolExecuteContext | undefined,
  workspace: string | undefined,
): ToolExecuteContext | undefined {
  if (!ctx && !workspace) return undefined;
  return {
    ...(ctx ?? {}),
    ...(workspace ? { workspace } : {}),
  };
}

function buildDescription(
  allow: Set<string>,
  allowWrite: boolean | undefined,
  allowBash: boolean | undefined,
  memLimit: number,
  timeoutMs: number,
): string {
  const toolList = Array.from(allow).sort().join(", ");
  const writeNote = allowWrite
    ? " (write tools enabled)"
    : " (read-only — write/edit/bash are NOT available)";
  const bashNote = allowBash ? " (bash + run_python enabled)" : "";
  return (
    "Run a JS script inside a sandboxed QuickJS VM that can call mathran tools as async functions. " +
    "Use this when a task involves MANY tool calls that mostly transform/aggregate data — e.g. " +
    "'scan 50 files for TODO comments and return a sorted list', 'grep then read top-3 matches'. " +
    "It collapses what would be 50+ tool-call round-trips into a single LLM call. " +
    "Inside the script: `await <tool>({...args})` exactly like a tool-call. " +
    "On tool failure the call throws — use try/catch. Script return value is JSON-stringified back. " +
    `Memory cap: ${Math.round(memLimit / (1024 * 1024))} MiB. Wall-clock cap: ${Math.round(timeoutMs / 1000)} s. ` +
    `Available tools: ${toolList}.${writeNote}${bashNote} ` +
    "Do NOT use this for single tool calls — call the tool directly. " +
    "Do NOT use eval/Function/import — they're disabled."
  );
}
