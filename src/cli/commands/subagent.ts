/**
 * `mathran subagent <type> <input-json>` — direct invocation of any subagent
 * runner from the shell (v0.5 wire-up Gap #4 + #5).
 *
 * Lets humans / CI scripts exercise the same runners the LLM gets via
 * `dispatch_subagent`, without spinning up a chat session. Especially useful
 * for:
 *   - smoke-testing a runner end-to-end (`mathran subagent search '{"query":"x"}'`)
 *   - validating the subprocess runtime (`--runtime subprocess`)
 *   - debugging artifact output (`--no-summary` / `--artifact` to print the
 *     full file rather than the capped inline summary)
 *
 * Mirrors the same SubagentTask / SubagentResult shapes the LLM tool uses;
 * any divergence would defeat the whole point of having both surfaces.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";

import { loadConfig } from "../../core/config.js";
import { ModelRouter } from "../../providers/index.js";
import {
  SubagentScheduler,
  defaultSubagentRegistry,
} from "../../core/subagent/index.js";
import type {
  SubagentResult,
  SubagentTaskType,
} from "../../core/subagent/types.js";
import type { SubagentTaskWithRuntime } from "../../core/subagent/scheduler.js";

const KNOWN_TYPES: readonly SubagentTaskType[] = [
  "compact",
  "search",
  "read_summarize",
  "research",
  "lean_explore",
];

/** Runners that need an LLM provider in their input (we auto-wire it). */
const LLM_RUNNERS: ReadonlySet<SubagentTaskType> = new Set([
  "compact",
  "read_summarize",
  "research",
  "lean_explore",
]);

export interface SubagentCommandOptions {
  /** Subagent runner to invoke. */
  type: string;
  /** JSON-encoded input passed to the runner. */
  inputJson: string;
  /** "inline" (default) or "subprocess". */
  runtime?: string;
  /** Timeout in ms (default 60000). */
  timeoutMs?: number;
  /** Hard cap for the inline summary (default 2048). */
  hardCapBytes?: number;
  /** Workspace root. Defaults to MATHRAN_WORKSPACE or cwd. */
  workspace?: string;
  /** Path to config file. */
  configPath?: string;
  /** Emit JSON instead of human-readable text. */
  json?: boolean;
  /** Don't print the inline summary (useful with --artifact). */
  noSummary?: boolean;
  /** After the run, also `cat` the artifact file (if any). */
  artifact?: boolean;
  /** Auto-inject `llm` into input for runners that need one (default true). */
  injectLlm?: boolean;
  /** Model id for the auto-injected LLM. Defaults to config.defaultModel. */
  model?: string;
}

function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return path.resolve(explicit);
  const env = process.env.MATHRAN_WORKSPACE;
  if (env && env.length > 0) return path.resolve(env);
  return process.cwd();
}

/**
 * Run one subagent task. Returns a process exit code:
 *   0   success (status == "ok" OR caller passed an explicitly accepted
 *       non-ok status — for now we treat every non-ok as a non-zero exit).
 *   1   runner returned status != "ok"
 *   2   bad usage (unknown type, malformed JSON, etc.)
 */
export async function runSubagentCommand(
  opts: SubagentCommandOptions,
): Promise<number> {
  if (!KNOWN_TYPES.includes(opts.type as SubagentTaskType)) {
    console.error(
      `mathran subagent: unknown type "${opts.type}". Known: ${KNOWN_TYPES.join(", ")}`,
    );
    return 2;
  }
  const type = opts.type as SubagentTaskType;

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(opts.inputJson);
  } catch (err: any) {
    console.error(`mathran subagent: --input is not valid JSON: ${err?.message ?? err}`);
    return 2;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    console.error(`mathran subagent: --input must be a JSON object`);
    return 2;
  }

  let runtime: "inline" | "subprocess" | undefined;
  if (opts.runtime === undefined || opts.runtime === "inline") {
    runtime = undefined; // use scheduler's default ("inline")
  } else if (opts.runtime === "subprocess") {
    runtime = "subprocess";
  } else {
    console.error(
      `mathran subagent: --runtime must be "inline" or "subprocess" (got "${opts.runtime}")`,
    );
    return 2;
  }

  const workspace = resolveWorkspaceRoot(opts.workspace);
  const config = loadConfig(opts.configPath);

  // Auto-wire an LLM provider for runners that need one. The dispatch_subagent
  // tool relies on the same scheduler, so behaviour here matches what the
  // model sees.
  const injectLlm = opts.injectLlm !== false;
  if (LLM_RUNNERS.has(type) && injectLlm && input.llm === undefined) {
    try {
      const router = new ModelRouter(config);
      input.llm = router;
      if (opts.model) {
        input.modelHint = opts.model;
      } else if (config.defaultModel) {
        input.modelHint = config.defaultModel;
      }
    } catch (err: any) {
      // Keep going — caller may have passed `--no-inject-llm` deliberately,
      // or the runner may not actually need it. Surface the error only when
      // it actually bites (the runner will fail clearly).
      console.error(
        `mathran subagent: warning: could not auto-wire LLM (${err?.message ?? err})`,
      );
    }
  }

  const scheduler = new SubagentScheduler({
    workspace,
    registry: defaultSubagentRegistry(),
  });

  const task: SubagentTaskWithRuntime = {
    type,
    input,
    ...(runtime !== undefined ? { runtime } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.hardCapBytes !== undefined ? { hardCapBytes: opts.hardCapBytes } : {}),
  };

  let result: SubagentResult;
  try {
    result = await scheduler.dispatch(task);
  } catch (err: any) {
    console.error(`mathran subagent: scheduler threw: ${err?.message ?? err}`);
    if (process.env.MATHRAN_DEBUG) console.error(err?.stack);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanResult(result, opts);
  }

  if (opts.artifact && result.artifactPath) {
    try {
      const abs = path.join(workspace, result.artifactPath);
      const raw = await fs.readFile(abs, "utf8");
      if (!opts.json) console.log("\n--- artifact ---");
      console.log(raw);
    } catch (err: any) {
      console.error(
        `mathran subagent: could not read artifact at ${result.artifactPath}: ${err?.message ?? err}`,
      );
    }
  }

  return result.status === "ok" ? 0 : 1;
}

function printHumanResult(result: SubagentResult, opts: SubagentCommandOptions): void {
  console.log(`status:       ${result.status}`);
  console.log(`runId:        ${result.runId}`);
  console.log(`type:         ${result.type}`);
  if (result.artifactPath) {
    console.log(`artifactPath: ${result.artifactPath}`);
  }
  console.log(`durationMs:   ${result.stats.durationMs}`);
  if (result.stats.tokensUsed !== undefined) {
    console.log(`tokensUsed:   ${result.stats.tokensUsed}`);
  }
  if (result.stats.toolCallCount !== undefined) {
    console.log(`toolCallCount: ${result.stats.toolCallCount}`);
  }
  if (result.errorMessage) {
    console.log(`error:        ${result.errorMessage}`);
  }
  if (!opts.noSummary && result.summary) {
    console.log("\n--- summary ---");
    console.log(result.summary);
  }
}

// Exposed for tests.
export { KNOWN_TYPES as SUBAGENT_CLI_KNOWN_TYPES };
