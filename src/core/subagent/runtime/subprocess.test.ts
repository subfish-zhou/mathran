/**
 * Tests for the subprocess subagent runtime (v0.3 §16).
 *
 * These tests spawn real Node child processes. They run the
 * `subagent-host.ts` entry through tsx (matching production behavior).
 *
 * Caveats:
 *   - Tests cannot inject a custom registry into the child; the child
 *     always loads `defaultSubagentRegistry()`. So end-to-end tests use
 *     real runners (`search`, `compact`, `read_summarize`, `research`)
 *     against stubbed parent-side LLMs/schedulers.
 *   - Spin-up cost is ~hundreds of ms per test (tsx loader + import). We
 *     keep test count low and use generous timeouts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { SubprocessRuntime } from "./subprocess.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";
import type {
  SubagentResult,
  SubagentTask,
} from "../types.js";
import type { SchedulerLike } from "./subprocess.js";
import { writeArtifact } from "../artifact.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

class FakeLLM implements LLMProvider {
  readonly seen: LLMRequest[] = [];
  constructor(private readonly response: string) {}
  async describe() {
    return { name: "fake-llm" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.seen.push(req);
    const resp = this.response;
    return {
      async *stream(): AsyncIterable<LLMStreamChunk> {
        yield { type: "text", delta: resp };
        yield { type: "done", finishReason: "stop" };
      },
    };
  }
}

class StubScheduler implements SchedulerLike {
  readonly seen: SubagentTask[] = [];
  constructor(
    private readonly canned: (task: SubagentTask) => Partial<SubagentResult>,
  ) {}
  async dispatch(task: SubagentTask): Promise<SubagentResult> {
    this.seen.push(task);
    const part = this.canned(task);
    const now = new Date().toISOString();
    return {
      runId: part.runId ?? `sub-stubmock`,
      type: task.type,
      status: part.status ?? "ok",
      summary: part.summary ?? "",
      artifactPath: part.artifactPath ?? null,
      stats: part.stats ?? { startedAt: now, endedAt: now, durationMs: 0 },
      ...(part.errorMessage ? { errorMessage: part.errorMessage } : {}),
    };
  }
}

// ─── Workspace fixture ──────────────────────────────────────────────────────

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-subproc-"));
});
afterEach(async () => {
  if (workspace) {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SubprocessRuntime — search runner round-trip", () => {
  it(
    "runs the real `search` runner in a forked child and returns its result",
    { timeout: 30_000 },
    async () => {
      // Drop a file the search will hit.
      await fs.writeFile(
        path.join(workspace, "hit.txt"),
        "needle in a haystack\nanother line\n",
        "utf8",
      );
      const runtime = new SubprocessRuntime();
      const res = await runtime.run({
        type: "search",
        runId: "sub-test1",
        workspace,
        input: { query: "needle" },
      });
      expect(res.runId).toBe("sub-test1");
      expect(res.type).toBe("search");
      expect(res.status === "ok" || res.status === "cap_exceeded").toBe(true);
      // The summary should mention the file or the query.
      expect(res.summary).toMatch(/needle|hit\.txt/i);
      expect(typeof res.stats.startedAt).toBe("string");
      expect(res.stats.durationMs).toBeGreaterThanOrEqual(0);
    },
  );
});

describe("SubprocessRuntime — LLM RPC forwarding", () => {
  it(
    "forwards `llm.chat` calls back to the parent's LLM provider",
    { timeout: 30_000 },
    async () => {
      const fakeLlm = new FakeLLM("forced summary text");
      const messages: LLMMessage[] = [
        { role: "system", content: "S" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
        { role: "user", content: "u4" },
        { role: "assistant", content: "a4" },
        { role: "user", content: "u5" },
        { role: "assistant", content: "a5" },
        { role: "user", content: "u6" },
        { role: "assistant", content: "a6" },
        { role: "user", content: "u7" },
        { role: "assistant", content: "a7" },
      ];
      const runtime = new SubprocessRuntime();
      const res = await runtime.run({
        type: "compact",
        runId: "sub-test2",
        input: { messages, keepRecentRounds: 2 },
        llm: fakeLlm,
        writeArtifact: (rid, name, content) =>
          writeArtifact(workspace, rid, name, content),
      });
      expect(res.status).toBe("ok");
      // The parent's LLM was called at least once.
      expect(fakeLlm.seen.length).toBeGreaterThanOrEqual(1);
      // The summary text must round-trip back into the artifact.
      const artifactPath = res.artifactPath;
      expect(artifactPath).not.toBeNull();
      const onDisk = await fs.readFile(
        path.join(workspace, artifactPath as string),
        "utf8",
      );
      const parsed = JSON.parse(onDisk) as { summaryText: string };
      expect(parsed.summaryText).toBe("forced summary text");
    },
  );
});

describe("SubprocessRuntime — scheduler RPC forwarding", () => {
  it(
    "forwards `scheduler.dispatch` calls back to the parent (research runner)",
    { timeout: 30_000 },
    async () => {
      const fakeLlm = new FakeLLM(
        // Round 1: `done` so synthesis runs immediately and we don't
        // round-trip a real search/read.
        '{"action":"done"}',
      );
      const sched = new StubScheduler(() => ({ status: "ok", summary: "" }));
      const runtime = new SubprocessRuntime();
      const res = await runtime.run({
        type: "research",
        runId: "sub-test3",
        workspace,
        input: {
          question: "What is mathran?",
          workspace,
          modelHint: "fake",
        },
        llm: fakeLlm,
        scheduler: sched,
        writeArtifact: (rid, name, content) =>
          writeArtifact(workspace, rid, name, content),
      });
      // Planner's first reply was "done", so 0 dispatches; synthesis call
      // is the second LLM round-trip.
      expect(sched.seen).toHaveLength(0);
      expect(fakeLlm.seen.length).toBeGreaterThanOrEqual(1);
      expect(res.status === "ok" || res.status === "cap_exceeded").toBe(true);
    },
  );
});

describe("SubprocessRuntime — abort and timeout", () => {
  it(
    "abortSignal triggers SIGTERM and returns an aborted error",
    { timeout: 30_000 },
    async () => {
      // research with no scheduler → input validation fails fast → status:error.
      // Use compact instead with a slow LLM so we're definitely mid-run.
      const slowLlm: LLMProvider = {
        async describe() {
          return { name: "slow" };
        },
        async chat(): Promise<LLMResponse> {
          // Never resolve; abort will tear it down.
          await new Promise(() => {});
          return null as unknown as LLMResponse;
        },
      };
      const messages: LLMMessage[] = [
        { role: "system", content: "S" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
        { role: "user", content: "u4" },
        { role: "assistant", content: "a4" },
        { role: "user", content: "u5" },
        { role: "assistant", content: "a5" },
        { role: "user", content: "u6" },
        { role: "assistant", content: "a6" },
        { role: "user", content: "u7" },
        { role: "assistant", content: "a7" },
      ];
      const runtime = new SubprocessRuntime();
      const ac = new AbortController();
      const t0 = Date.now();
      const promise = runtime.run({
        type: "compact",
        runId: "sub-abort1",
        input: { messages, keepRecentRounds: 2 },
        llm: slowLlm,
        abortSignal: ac.signal,
        writeArtifact: (rid, name, content) =>
          writeArtifact(workspace, rid, name, content),
      });
      // Trigger abort after a short delay.
      setTimeout(() => ac.abort(), 500);
      const res = await promise;
      const elapsed = Date.now() - t0;
      // Should resolve within a reasonable window (definitely <10s).
      expect(elapsed).toBeLessThan(10_000);
      expect(res.status === "error" || res.status === "timeout").toBe(true);
      expect(res.errorMessage).toBeTruthy();
    },
  );

  it(
    "timeoutMs fires and kills the child",
    { timeout: 30_000 },
    async () => {
      const slowLlm: LLMProvider = {
        async describe() {
          return { name: "slow" };
        },
        async chat(): Promise<LLMResponse> {
          await new Promise(() => {});
          return null as unknown as LLMResponse;
        },
      };
      const messages: LLMMessage[] = Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `m${i}`,
      }));
      messages.unshift({ role: "system", content: "S" });
      const runtime = new SubprocessRuntime();
      const res = await runtime.run({
        type: "compact",
        runId: "sub-timeout1",
        input: { messages, keepRecentRounds: 2 },
        llm: slowLlm,
        timeoutMs: 600,
        writeArtifact: (rid, name, content) =>
          writeArtifact(workspace, rid, name, content),
      });
      expect(res.status).toBe("timeout");
      expect(res.errorMessage).toMatch(/timed out/);
    },
  );
});

describe("SubprocessRuntime — error paths", () => {
  it(
    "child exit without result → status error with stderr tail",
    { timeout: 30_000 },
    async () => {
      // Spawn a script that immediately exits without protocol output.
      const fakeHost = path.join(workspace, "fake-host.cjs");
      await fs.writeFile(
        fakeHost,
        `process.stderr.write("boom from fake host"); process.exit(7);\n`,
        "utf8",
      );
      // Override spawn to skip the tsx loader for our plain-JS fake host.
      const cp = await import("node:child_process");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const customSpawn = ((..._args: unknown[]) => {
        return cp.spawn(
          process.execPath,
          [fakeHost],
          (_args[2] ?? {}) as never,
        );
      }) as unknown as typeof cp.spawn;
      const customRuntime = new SubprocessRuntime({
        hostPath: fakeHost,
        readyTimeoutMs: 4_000,
        spawn: customSpawn,
      });
      const res = await customRuntime.run({
        type: "search",
        runId: "sub-err1",
        input: {},
      });
      expect(res.status).toBe("error");
      expect(res.errorMessage).toBeTruthy();
    },
  );

  it(
    "unknown runner type → child exits cleanly with error status",
    { timeout: 30_000 },
    async () => {
      const runtime = new SubprocessRuntime();
      const res = await runtime.run({
        type: "definitely-not-a-real-type" as never,
        runId: "sub-err2",
        input: {},
      });
      expect(res.status).toBe("error");
      expect(res.errorMessage).toMatch(/unknown runner/);
    },
  );

  it(
    "two sequential runs each get their own child",
    { timeout: 30_000 },
    async () => {
      await fs.writeFile(
        path.join(workspace, "a.txt"),
        "alpha alpha\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, "b.txt"),
        "beta beta\n",
        "utf8",
      );
      const runtime = new SubprocessRuntime();
      const r1 = await runtime.run({
        type: "search",
        runId: "sub-seq1",
        workspace,
        input: { query: "alpha" },
      });
      const r2 = await runtime.run({
        type: "search",
        runId: "sub-seq2",
        workspace,
        input: { query: "beta" },
      });
      expect(r1.runId).toBe("sub-seq1");
      expect(r2.runId).toBe("sub-seq2");
      expect(r1.summary).toMatch(/a\.txt|alpha/);
      expect(r2.summary).toMatch(/b\.txt|beta/);
    },
  );
});
