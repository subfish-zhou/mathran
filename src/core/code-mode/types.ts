/**
 * Code mode v1 — type definitions.
 *
 * "Code mode" replaces N consecutive tool-call round-trips with a SINGLE LLM
 * tool call whose argument is a small piece of JavaScript that gets executed
 * inside a sandboxed QuickJS interpreter. The script may call any whitelisted
 * mathran ToolSpec as if it were a local async JS function:
 *
 *     const txt = await read_file({ path: "src/foo.ts" });
 *     const hits = await grep({ pattern: "TODO", path: "src" });
 *     return { count: hits.length, sample: hits.slice(0, 3) };
 *
 * The script's return value is JSON-stringified and surfaced back to the LLM
 * as the tool result. Errors thrown inside the script are caught and returned
 * as `{ ok: false, content: "code_mode error: ..." }`.
 *
 * Why this is worth a module:
 *   - Token cost: a goal-mode run that fires `read_file` 60 times currently
 *     pays for 60 prompt→completion round-trips. Bundling them into one JS
 *     script collapses that to ONE round-trip, at the cost of a ~1ms QuickJS
 *     spawn per call. Codex calls this "Code mode" — same pattern.
 *   - Sandbox: untrusted LLM output runs inside QuickJS WebAssembly with a
 *     hard memory + CPU budget. No `process`, no `require`, no `fetch`, no
 *     filesystem — the model can only call back into mathran tools we explicitly
 *     bind. This is a much smaller blast radius than `node -e`.
 *   - Sync-from-the-VM, async-on-the-host: each bound tool is a QuickJS
 *     "asyncified" function — the script `await`s it synchronously, and on the
 *     host side mathran runs the tool's regular async `execute()` then resumes
 *     the VM with the result. No deferred-promise/`executePendingJobs` dance.
 *
 * v1 scope (this module):
 *   - One ChatSession-level builtin tool `run_code_mode({ script })`.
 *   - Whitelist of read-only tools by default (read_file, glob, grep, list_dir),
 *     optional opt-in for write_file / edit_file / bash.
 *   - 256 MiB memory cap, 60 s wall-clock budget enforced via QuickJS interrupt
 *     handler.
 *   - Default OFF — host must explicitly set `builtinTools.code_mode = true`.
 *
 * v1 explicitly does NOT:
 *   - Stream incremental output (the script runs to completion, then returns).
 *   - Persist state between calls (each `run_code_mode` spawns a fresh VM).
 *   - Expose `fetch` / `XMLHttpRequest` / timers — those go through tools.
 */

import type { ToolSpec, ToolExecuteContext } from "../chat/session.js";

/**
 * One mathran ToolSpec wrapped for exposure inside the QuickJS sandbox.
 *
 * `name` is the JS global the bound function will be installed at. It MUST
 * match the wrapped ToolSpec's name so the LLM sees the same surface as in
 * tool-call mode — e.g. `await read_file({ path })` inside code-mode behaves
 * exactly like a `read_file` tool-call.
 *
 * `tool` is the unwrapped ToolSpec — the bridge calls `tool.execute(args, ctx)`
 * and returns the `content` string verbatim. Callers can choose to JSON.parse
 * the content themselves (the LLM is told the contract upfront).
 */
export interface ToolBinding {
  /** Global name inside the VM (e.g. "read_file"). Must be a valid JS ident. */
  name: string;
  /** The wrapped ToolSpec to invoke on each call. */
  tool: ToolSpec;
}

/**
 * Outcome of `runScript()`. Either the script ran to completion and returned
 * a JSON-serializable value (`ok: true`, `result`), or it failed (`ok: false`,
 * `error` — already shaped as a single line of human-readable text suitable
 * for surfacing to the LLM).
 *
 * `meta` carries diagnostics the host wants to log (memory + CPU usage,
 * trace of tool calls made). The orchestrator may format these into the
 * tool result so the LLM can self-correct on the next round.
 */
export interface CodeModeResult {
  ok: boolean;
  /** When ok: stringified script result. Empty string for `undefined`. */
  result?: string;
  /** When !ok: a single-line error string. */
  error?: string;
  /** Per-call diagnostics. */
  meta: {
    /** Number of tool calls the script made (across all bound tools). */
    toolCalls: number;
    /** Total wall-clock duration in ms. */
    durationMs: number;
    /** True if the run hit the CPU/wall-clock interrupt. */
    interrupted: boolean;
    /** True if the run hit the memory cap. */
    oom: boolean;
    /** Names of tools invoked, in call order (de-duplicated stays as-is for trace). */
    toolTrace: string[];
  };
}

/**
 * Input shape `runScript()` accepts. The bridge owns lifecycle (VM spawn,
 * memory/CPU limits, dispose) so callers just hand over the script + bindings.
 */
export interface CodeModeRequest {
  /** The raw JS source. Wrapped in `(async () => { ... })()` by the runtime. */
  script: string;
  /** Tools to expose inside the VM. */
  bindings: ToolBinding[];
  /** Context threaded into every tool's `execute()`. Optional. */
  ctx?: ToolExecuteContext;
  /** Memory cap in bytes. Default: 256 MiB. */
  memoryLimitBytes?: number;
  /** Wall-clock budget in ms. Default: 60 000. */
  timeoutMs?: number;
  /**
   * Max stack size in bytes. Defaults to 1 MiB — deeper than QuickJS's own
   * default but still small enough to catch runaway recursion fast.
   */
  maxStackBytes?: number;
}
