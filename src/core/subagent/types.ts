/**
 * Subagent infrastructure — shared types (v0.2 §1).
 *
 * A subagent is a bounded, single-purpose worker the main agent can dispatch
 * to offload work (search, read+summarize, compaction, research, Lean
 * exploration). Each dispatch runs under a concurrency cap, a wall-clock
 * timeout and a byte cap on the returned summary, and may persist larger
 * output to a per-run artifact directory under the workspace.
 */

export type SubagentTaskType =
  | "search"
  | "read_summarize"
  | "compact"
  | "research"
  | "lean_explore";

export interface SubagentTask {
  type: SubagentTaskType;
  input: Record<string, unknown>;
  parentRunId?: string; // optional: parent goal id or session id for audit chain
  hardCapBytes?: number; // summary byte cap; default 2048
  timeoutMs?: number; // default 60000
}

export interface SubagentResult {
  runId: string; // unique per dispatch; format: "sub-<8 hex>"
  type: SubagentTaskType;
  status: "ok" | "error" | "timeout" | "cap_exceeded";
  summary: string; // ≤ hardCapBytes; "" on error
  artifactPath: string | null; // relative to workspace, e.g. ".mathran/subagents/sub-abc/output.txt"
  stats: {
    startedAt: string; // ISO
    endedAt: string; // ISO
    durationMs: number;
    tokensUsed?: number; // optional, runners that talk to LLM set this
    toolCallCount?: number;
  };
  errorMessage?: string; // populated when status != "ok"
}

export interface SubagentContext {
  workspace: string; // absolute path
  runId: string;
  signal: AbortSignal;
  // helper for runners to write artifacts
  writeArtifact(name: string, content: string | Buffer): Promise<string>; // returns relative path
}

export interface SubagentRunner {
  type: SubagentTaskType;
  run(
    task: SubagentTask,
    ctx: SubagentContext,
  ): Promise<Omit<SubagentResult, "runId" | "type" | "stats">>;
}
