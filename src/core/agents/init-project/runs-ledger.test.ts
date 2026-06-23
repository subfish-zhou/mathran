import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  createRun,
  appendPhase,
  writeCheckpoint,
  appendLog,
  finishRun,
  readRun,
  readCheckpoint,
  readRunLedger,
  listRuns,
  newRunId,
  runDir,
} from "./runs-ledger.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-run-"));
});
afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe("runs ledger", () => {
  it("mints unique run ids", () => {
    expect(newRunId()).toMatch(/^run-[0-9a-f]{12}$/);
    expect(newRunId()).not.toBe(newRunId());
  });

  it("creates a run with running status and run.json on disk", async () => {
    const run = await createRun(projectDir, { input: { title: "Twin Primes" } });
    expect(run.status).toBe("running");
    expect(run.agentType).toBe("init-project");
    const raw = await fs.readFile(path.join(runDir(projectDir, run.runId), "run.json"), "utf-8");
    expect(JSON.parse(raw).input.title).toBe("Twin Primes");
  });

  it("appends phase records to phases.jsonl", async () => {
    const run = await createRun(projectDir);
    await appendPhase(projectDir, run.runId, "seed_research", "start");
    await appendPhase(projectDir, run.runId, "seed_research", "end", { papers: 3 });
    const snap = await readRunLedger(projectDir, run.runId);
    expect(snap?.phases.length).toBe(2);
    expect(snap?.phases[1]).toMatchObject({ phase: "seed_research", event: "end", data: { papers: 3 } });
  });

  it("writes and reads a checkpoint for resume", async () => {
    const run = await createRun(projectDir);
    await writeCheckpoint(projectDir, run.runId, "deep_crawl", { queries: ["a", "b"] });
    const cp = await readCheckpoint(projectDir, run.runId);
    expect(cp?.phase).toBe("deep_crawl");
    expect(cp?.data.queries).toEqual(["a", "b"]);
  });

  it("appends logs to logs.jsonl", async () => {
    const run = await createRun(projectDir);
    await appendLog(projectDir, run.runId, "llm_call", "concept extraction", { tokens: 1200 });
    const snap = await readRunLedger(projectDir, run.runId);
    expect(snap?.logs.length).toBe(1);
    expect(snap?.logs[0]).toMatchObject({ kind: "llm_call", message: "concept extraction" });
  });

  it("finishes a run as completed with finishedAt", async () => {
    const run = await createRun(projectDir);
    await finishRun(projectDir, run.runId, "completed");
    const r = await readRun(projectDir, run.runId);
    expect(r?.status).toBe("completed");
    expect(r?.finishedAt).toBeTruthy();
  });

  it("finishes a run as error with the error message", async () => {
    const run = await createRun(projectDir);
    await finishRun(projectDir, run.runId, "error", "boom");
    const r = await readRun(projectDir, run.runId);
    expect(r?.status).toBe("error");
    expect(r?.error).toBe("boom");
  });

  it("returns null when reading a missing run", async () => {
    expect(await readRun(projectDir, "run-deadbeef")).toBeNull();
    expect(await readRunLedger(projectDir, "run-deadbeef")).toBeNull();
  });

  it("lists runs most-recent-first", async () => {
    const a = await createRun(projectDir, { runId: "run-000000000001" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createRun(projectDir, { runId: "run-000000000002" });
    const runs = await listRuns(projectDir);
    expect(runs.map((r) => r.runId)).toEqual([b.runId, a.runId]);
  });

  it("produces a full snapshot for the status API", async () => {
    const run = await createRun(projectDir, { input: { title: "X" } });
    await appendPhase(projectDir, run.runId, "build_wiki", "start");
    await writeCheckpoint(projectDir, run.runId, "build_wiki", { pages: 1 });
    await appendLog(projectDir, run.runId, "phase", "wiki built");
    await finishRun(projectDir, run.runId, "completed");
    const snap = await readRunLedger(projectDir, run.runId);
    expect(snap?.run.status).toBe("completed");
    expect(snap?.phases.length).toBe(1);
    expect(snap?.checkpoint?.phase).toBe("build_wiki");
    expect(snap?.logs.length).toBe(1);
  });

  it("writeJsonAtomic: round-trips run.json correctly after an update", async () => {
    const run = await createRun(projectDir, { input: { title: "Atomic" } });
    // finishRun overwrites run.json via the atomic writer.
    await finishRun(projectDir, run.runId, "completed");
    const r = await readRun(projectDir, run.runId);
    expect(r?.status).toBe("completed");
    expect(r?.input?.title).toBe("Atomic");
    // No leftover temp files pollute the run dir after a clean write.
    const entries = await fs.readdir(runDir(projectDir, run.runId));
    expect(entries.some((e) => e.includes(".tmp."))).toBe(false);
  });

  it("writeJsonAtomic: a stale .tmp sibling never corrupts the live file", async () => {
    const run = await createRun(projectDir);
    const dir = runDir(projectDir, run.runId);
    // Simulate a crash mid-write: a half-written temp file is left behind.
    await fs.writeFile(path.join(dir, "run.json.tmp.deadbe"), "{ truncated", "utf-8");
    // The live run.json must still parse to the last good value, and a
    // subsequent atomic write must succeed regardless of the stale tmp.
    const before = await readRun(projectDir, run.runId);
    expect(before?.status).toBe("running");
    await finishRun(projectDir, run.runId, "completed");
    const after = await readRun(projectDir, run.runId);
    expect(after?.status).toBe("completed");
  });
});
