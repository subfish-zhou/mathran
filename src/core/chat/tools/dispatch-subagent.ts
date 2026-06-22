/**
 * dispatch_subagent — generic ChatSession tool that exposes the subagent
 * scheduler to the LLM.
 *
 * Gap #4 (v0.5 §wire-up): until this tool, only `compact` had a user-visible
 * surface. The `search`/`read_summarize`/`research`/`lean_explore` runners
 * passed unit tests but had no slash command, no HTTP endpoint and no LLM
 * tool — the model literally could not invoke them. This single generic tool
 * solves the gap with one schema: `type` picks the runner, `input` is the
 * runner-specific payload, optional `runtime` opts into subprocess
 * isolation (Gap #5).
 *
 * Anti-recursion (per research.ts comments): the runners that themselves
 * drive an LLM (`research`, `lean_explore`) build their own LLM requests
 * directly and pass `tools: []`. They never go through `ChatSession`, so
 * registering `dispatch_subagent` as a ChatSession builtin tool cannot leak
 * into those inner loops. Confirmed by grepping research.ts / lean-explore.ts
 * for `tools:` — both pin `[]` at every call site.
 */

import type { ToolSpec } from "../session.js";
import type { SubagentScheduler, SubagentTaskWithRuntime } from "../../subagent/scheduler.js";
import type { SubagentTaskType } from "../../subagent/types.js";
import { RECOMMENDED_MODELS } from "../../subagent/registry.js";

const KNOWN_TYPES: readonly SubagentTaskType[] = [
  "compact",
  "search",
  "read_summarize",
  "research",
  "lean_explore",
];

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HARD_CAP_BYTES = 2048;
const SUMMARY_DISPLAY_CAP = 4096; // truncate summaries longer than this for the model

export interface DispatchSubagentToolOptions {
  /** Required — the scheduler the tool dispatches into. */
  scheduler: SubagentScheduler;
  /**
   * Optional list of configured provider keys (e.g. ["copilot", "openai"]).
   * When provided, a `model` override whose provider is not in this list is
   * rejected at dispatch time. When omitted, only the `provider/model` *format*
   * is validated (fail-open on provider existence).
   */
  knownProviders?: readonly string[];
}

/** Render the recommended-model mapping for the tool description. */
function recommendedModelsHint(): string {
  const entries = Object.entries(RECOMMENDED_MODELS).map(
    ([type, model]) => `${type} → ${model}`,
  );
  return entries.length > 0 ? entries.join(", ") : "(none)";
}

/**
 * Validate an optional `model` override. Returns an error string if invalid, or
 * the trimmed model string (or undefined when absent) when valid.
 */
export function validateModelOverride(
  raw: unknown,
  knownProviders?: readonly string[],
): { ok: true; model?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") {
    return { ok: false, error: 'dispatch_subagent: "model" must be a string' };
  }
  const model = raw.trim();
  if (model.length === 0) return { ok: true };
  const slash = model.indexOf("/");
  if (slash <= 0 || slash >= model.length - 1) {
    return {
      ok: false,
      error: `dispatch_subagent: invalid model "${raw}" (expected "provider/model" form, e.g. "copilot/claude-opus-4.8")`,
    };
  }
  const provider = model.slice(0, slash);
  if (knownProviders && knownProviders.length > 0 && !knownProviders.includes(provider)) {
    return {
      ok: false,
      error: `dispatch_subagent: unknown provider "${provider}" in model "${raw}" (known: ${knownProviders.join(", ")})`,
    };
  }
  return { ok: true, model };
}

const PARAMETERS = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["compact", "search", "read_summarize", "research", "lean_explore"],
      description: "Subagent runner to invoke",
    },
    input: {
      type: "object",
      description:
        "Runner-specific input. Each runner type expects its own shape:\n" +
        "- compact: {messages: [...], targetTokens?: number}\n" +
        "- search: {query: string, root?: string, maxResults?: number}\n" +
        "- read_summarize: {path: string, focus?: string}\n" +
        "- research: {objective: string, maxRounds?: number, root?: string}\n" +
        "- lean_explore: {goal: string, fileHint?: string, maxRounds?: number}",
      additionalProperties: true,
    },
    runtime: {
      type: "string",
      enum: ["inline", "subprocess"],
      description:
        "Optional. Default 'inline'. 'subprocess' isolates the runner in a " +
        "forked Node process (slower startup, safer for crashy LLM calls).",
    },
    model: {
      type: "string",
      description:
        "Optional model override for this subagent run, in 'provider/model' " +
        "form (e.g. 'copilot/claude-opus-4.8'). Defaults to the parent " +
        "session's model. Pick a stronger model (Opus) for code/Lean/math " +
        "reasoning, a faster one (GPT) for research/summarization. " +
        "Recommended per type: " +
        recommendedModelsHint() +
        " (these are hints — you decide).",
    },
    timeoutMs: {
      type: "number",
      description: "Optional override; default 60000",
    },
    hardCapBytes: {
      type: "number",
      description: "Optional summary byte cap; default 2048",
    },
  },
  required: ["type", "input"],
  additionalProperties: false,
} as const;

/**
 * Build a `dispatch_subagent` ToolSpec bound to a concrete scheduler.
 *
 * Behavior:
 *   - Validates `type` against the known runner list (else `ok: false`).
 *   - Validates `input` is an object (else `ok: false`).
 *   - Builds a `SubagentTaskWithRuntime` from args.
 *   - Calls `opts.scheduler.dispatch(task)`.
 *   - Formats result as human-readable text containing status, summary
 *     (truncated to first 4KB if longer), runId, artifactPath (if any),
 *     duration, tokens, toolCallCount.
 *   - `ok: true` iff `result.status === "ok"`; otherwise `ok: false` with
 *     errorMessage prepended.
 */
export function createDispatchSubagentTool(
  opts: DispatchSubagentToolOptions,
): ToolSpec {
  return {
    name: "dispatch_subagent",
    description:
      "Dispatch a bounded subagent runner (search / read_summarize / compact / " +
      "research / lean_explore). Use this when you need to offload work that " +
      "would otherwise pollute your context: searching the workspace, " +
      "summarizing a long file, multi-step research, or Lean proof exploration. " +
      "Each runner runs under a concurrency cap and wall-clock timeout; the " +
      "result is a bounded text summary (≤ ~2KB) plus an optional artifact " +
      "path with the full output. Set `runtime: 'subprocess'` for crashy LLM " +
      "work that should not bring down the parent.",
    parameters: PARAMETERS as unknown as Record<string, unknown>,
    async execute(args: Record<string, unknown>) {
      const rawType = typeof args.type === "string" ? args.type : "";
      if (!KNOWN_TYPES.includes(rawType as SubagentTaskType)) {
        return {
          ok: false,
          content: `dispatch_subagent: unknown subagent type "${rawType}". Known: ${KNOWN_TYPES.join(", ")}`,
        };
      }
      const type = rawType as SubagentTaskType;

      if (args.input === undefined || args.input === null) {
        return {
          ok: false,
          content: 'dispatch_subagent: missing required argument "input"',
        };
      }
      if (typeof args.input !== "object" || Array.isArray(args.input)) {
        return {
          ok: false,
          content: 'dispatch_subagent: "input" must be a JSON object',
        };
      }
      const input = args.input as Record<string, unknown>;

      const rawRuntime = typeof args.runtime === "string" ? args.runtime : undefined;
      let runtime: "inline" | "subprocess" | undefined;
      if (rawRuntime === undefined) {
        runtime = undefined;
      } else if (rawRuntime === "inline" || rawRuntime === "subprocess") {
        runtime = rawRuntime;
      } else {
        return {
          ok: false,
          content: `dispatch_subagent: invalid runtime "${rawRuntime}" (expected "inline" or "subprocess")`,
        };
      }

      const timeoutMs =
        typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
          ? args.timeoutMs
          : undefined;
      const hardCapBytes =
        typeof args.hardCapBytes === "number" && Number.isFinite(args.hardCapBytes)
          ? args.hardCapBytes
          : undefined;

      // Validate the optional model override *before* dispatching so a bad
      // string fails fast instead of letting a subagent spin up and crash.
      const modelCheck = validateModelOverride(args.model, opts.knownProviders);
      if (!modelCheck.ok) {
        return { ok: false, content: modelCheck.error };
      }
      const model = modelCheck.model;

      const task: SubagentTaskWithRuntime = {
        type,
        input,
        ...(runtime !== undefined ? { runtime } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(hardCapBytes !== undefined ? { hardCapBytes } : {}),
        ...(model !== undefined ? { model } : {}),
      };

      let result: Awaited<ReturnType<typeof opts.scheduler.dispatch>>;
      try {
        result = await opts.scheduler.dispatch(task);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          content: `dispatch_subagent: scheduler threw: ${msg}`,
        };
      }

      const ok = result.status === "ok";
      const content = formatResult(result);
      return { ok, content };
    },
  };
}

function formatResult(
  result: Awaited<ReturnType<SubagentScheduler["dispatch"]>>,
): string {
  const lines: string[] = [];
  // Status + optional error message lead so the model can react fast.
  if (result.status !== "ok" && result.errorMessage) {
    lines.push(`error: ${result.errorMessage}`);
  }
  lines.push(`status: ${result.status}`);
  lines.push(`runId: ${result.runId}`);
  if (result.artifactPath) {
    lines.push(`artifactPath: ${result.artifactPath}`);
  }
  const stats = result.stats;
  if (stats) {
    lines.push(`durationMs: ${stats.durationMs}`);
    if (typeof stats.tokensUsed === "number") {
      lines.push(`tokensUsed: ${stats.tokensUsed}`);
    }
    if (typeof stats.toolCallCount === "number") {
      lines.push(`toolCallCount: ${stats.toolCallCount}`);
    }
  }
  // Summary at the end with a header so it's visually separated from stats.
  // Truncate at SUMMARY_DISPLAY_CAP UTF-16 chars (rough byte proxy) so a
  // misconfigured runner can't blow past sensible context cost.
  const summary = result.summary ?? "";
  const summaryDisplay =
    summary.length > SUMMARY_DISPLAY_CAP
      ? summary.slice(0, SUMMARY_DISPLAY_CAP) +
        `\n… [truncated; ${summary.length - SUMMARY_DISPLAY_CAP} more chars]`
      : summary;
  if (summaryDisplay.length > 0) {
    lines.push("");
    lines.push("summary:");
    lines.push(summaryDisplay);
  }
  return lines.join("\n");
}

// Re-export defaults so tests/consumers can reference the same constants.
export {
  DEFAULT_TIMEOUT_MS as DISPATCH_DEFAULT_TIMEOUT_MS,
  DEFAULT_HARD_CAP_BYTES as DISPATCH_DEFAULT_HARD_CAP_BYTES,
  SUMMARY_DISPLAY_CAP as DISPATCH_SUMMARY_DISPLAY_CAP,
};
