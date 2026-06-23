/**
 * fs runs ledger — git-friendly, DB-free replacement for mathub's `agentRuns`
 * table. Tracks an init-project agent run as plain text under:
 *
 *   <project>/.mathran/agent-runs/<runId>/
 *     ├── run.json        — { runId, agentType, status, startedAt, finishedAt?, error? }
 *     ├── phases.jsonl    — one line per phase start/end/data (append-only)
 *     ├── checkpoint.json — last completed phase + serialized data (for resume)
 *     └── logs.jsonl      — LLM/tool call detail (append-only)
 *
 * All JSON/JSONL is human-readable and append-only so `git diff` stays clean.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export type RunStatus = "running" | "completed" | "error";

export interface RunRecord {
  runId: string;
  agentType: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Echo of the original input (problem title, seed count, aiInit config). */
  input?: Record<string, unknown>;
}

export interface PhaseRecord {
  phase: string;
  event: "start" | "end";
  at: string;
  data?: Record<string, unknown>;
}

export interface CheckpointRecord {
  phase: string;
  at: string;
  data: Record<string, unknown>;
}

export interface LogRecord {
  at: string;
  kind: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface RunLedgerSnapshot {
  run: RunRecord;
  phases: PhaseRecord[];
  checkpoint: CheckpointRecord | null;
  logs: LogRecord[];
}

export function runsDir(projectDir: string): string {
  return path.join(projectDir, ".mathran", "agent-runs");
}

export function runDir(projectDir: string, runId: string): string {
  return path.join(runsDir(projectDir), runId);
}

/** Mint a new run id, format `run-<12 hex>`. */
export function newRunId(): string {
  return `run-${randomBytes(6).toString("hex")}`;
}

function runFile(projectDir: string, runId: string): string {
  return path.join(runDir(projectDir, runId), "run.json");
}
function phasesFile(projectDir: string, runId: string): string {
  return path.join(runDir(projectDir, runId), "phases.jsonl");
}
function checkpointFile(projectDir: string, runId: string): string {
  return path.join(runDir(projectDir, runId), "checkpoint.json");
}
function logsFile(projectDir: string, runId: string): string {
  return path.join(runDir(projectDir, runId), "logs.jsonl");
}

/** Create a new run ledger directory and write the initial `run.json`. */
export async function createRun(
  projectDir: string,
  opts: { runId?: string; agentType?: string; input?: Record<string, unknown> } = {},
): Promise<RunRecord> {
  const runId = opts.runId ?? newRunId();
  const record: RunRecord = {
    runId,
    agentType: opts.agentType ?? "init-project",
    status: "running",
    startedAt: new Date().toISOString(),
    input: opts.input,
  };
  await fs.mkdir(runDir(projectDir, runId), { recursive: true });
  await writeJson(runFile(projectDir, runId), record);
  return record;
}

export async function appendPhase(
  projectDir: string,
  runId: string,
  phase: string,
  event: "start" | "end",
  data?: Record<string, unknown>,
): Promise<void> {
  const record: PhaseRecord = { phase, event, at: new Date().toISOString(), data };
  await fs.mkdir(runDir(projectDir, runId), { recursive: true });
  await fs.appendFile(phasesFile(projectDir, runId), JSON.stringify(record) + "\n", "utf-8");
}

export async function writeCheckpoint(
  projectDir: string,
  runId: string,
  phase: string,
  data: Record<string, unknown>,
): Promise<void> {
  const record: CheckpointRecord = { phase, at: new Date().toISOString(), data };
  await fs.mkdir(runDir(projectDir, runId), { recursive: true });
  await writeJson(checkpointFile(projectDir, runId), record);
}

export async function appendLog(
  projectDir: string,
  runId: string,
  kind: string,
  message?: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const record: LogRecord = { at: new Date().toISOString(), kind, message, data };
  await fs.mkdir(runDir(projectDir, runId), { recursive: true });
  await fs.appendFile(logsFile(projectDir, runId), JSON.stringify(record) + "\n", "utf-8");
}

/** Flip a run to a terminal status, recording finishedAt and optional error. */
export async function finishRun(
  projectDir: string,
  runId: string,
  status: "completed" | "error",
  error?: string,
): Promise<void> {
  const run = await readRun(projectDir, runId);
  if (!run) return;
  run.status = status;
  run.finishedAt = new Date().toISOString();
  if (error) run.error = error;
  await writeJson(runFile(projectDir, runId), run);
}

export async function readRun(projectDir: string, runId: string): Promise<RunRecord | null> {
  try {
    return JSON.parse(await fs.readFile(runFile(projectDir, runId), "utf-8")) as RunRecord;
  } catch {
    return null;
  }
}

export async function readCheckpoint(projectDir: string, runId: string): Promise<CheckpointRecord | null> {
  try {
    return JSON.parse(await fs.readFile(checkpointFile(projectDir, runId), "utf-8")) as CheckpointRecord;
  } catch {
    return null;
  }
}

/** Read the full snapshot (run + phases + checkpoint + logs) for the status API. */
export async function readRunLedger(projectDir: string, runId: string): Promise<RunLedgerSnapshot | null> {
  const run = await readRun(projectDir, runId);
  if (!run) return null;
  return {
    run,
    phases: await readJsonl<PhaseRecord>(phasesFile(projectDir, runId)),
    checkpoint: await readCheckpoint(projectDir, runId),
    logs: await readJsonl<LogRecord>(logsFile(projectDir, runId)),
  };
}

/** Enumerate run ids for a project (most-recent-first by startedAt). */
export async function listRuns(projectDir: string): Promise<RunRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(runsDir(projectDir));
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  for (const id of entries) {
    const r = await readRun(projectDir, id);
    if (r) runs.push(r);
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

async function readJsonl<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
