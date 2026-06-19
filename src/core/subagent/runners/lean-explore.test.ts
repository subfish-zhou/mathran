/**
 * Tests for the lean_explore subagent runner (v0.3 §18).
 *
 * Strategy: drive the runner with a scripted LLM and a mock `_leanCheck`
 * seam so we can:
 *   - script proof generations per (lemma, strategy)
 *   - return canned ok/stderr per attempt without running real Lean
 *   - assert anti-recursion (`tools: []`) across every LLM call
 *   - verify concurrency (overlap timestamps)
 *   - verify abort propagation (sharedAbort cancels in-flight work)
 *   - verify the artifact JSONL captures winners / losers / aborted
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  brainstormStrategies,
  clampParallelism,
  DEFAULT_PARALLELISM,
  FALLBACK_STRATEGIES,
  formatAttemptsJsonl,
  generateProof,
  leanExploreRunner,
  MAX_PARALLELISM,
  parseStrategiesLenient,
  pickClosestIndex,
  stripFences,
  type LeanCheckSeam,
  type LeanExploreAttemptRecord,
  type LeanExploreInput,
} from "./lean-explore.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";
import type { SubagentContext, SubagentTask } from "../types.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

class ScriptedLLM implements LLMProvider {
  readonly seen: LLMRequest[] = [];
  shouldThrow: Error | null = null;
  shouldThrowOnNthCall: number | null = null;
  constructor(
    private readonly responses: string[] = [],
    private readonly responder?: (req: LLMRequest) => string,
  ) {}
  async describe() {
    return { name: "scripted-llm" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.seen.push(req);
    if (
      this.shouldThrowOnNthCall !== null &&
      this.seen.length === this.shouldThrowOnNthCall
    ) {
      throw this.shouldThrow ?? new Error("scripted throw");
    }
    if (this.shouldThrow && this.shouldThrowOnNthCall === null) {
      throw this.shouldThrow;
    }
    const text = this.responder
      ? this.responder(req)
      : this.responses[Math.min(this.seen.length - 1, this.responses.length - 1)] ??
        "";
    return {
      async *stream(): AsyncIterable<LLMStreamChunk> {
        yield { type: "text", delta: text };
        yield { type: "done", finishReason: "stop" };
      },
    };
  }
}

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-leanexplore-"));
});
afterEach(async () => {
  if (workspace) {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

function makeContext(
  ws: string,
  signal: AbortSignal = new AbortController().signal,
  runId = "sub-leantest",
): SubagentContext {
  return {
    workspace: ws,
    runId,
    signal,
    async writeArtifact(name, content) {
      const dir = path.join(ws, ".mathran", "subagents", runId);
      await fs.mkdir(dir, { recursive: true });
      const abs = path.join(dir, name);
      await fs.writeFile(abs, content);
      return path.relative(ws, abs).split(path.sep).join("/");
    },
  };
}

function buildInput(
  ws: string,
  llm: LLMProvider,
  leanCheck: LeanCheckSeam,
  overrides: Partial<LeanExploreInput> = {},
): LeanExploreInput {
  return {
    lemma: "theorem t : 1 + 1 = 2 := by sorry",
    strategies: ["a", "b", "c"],
    parallelism: 3,
    workspace: ws,
    llm,
    _leanCheck: leanCheck,
    ...overrides,
  };
}

async function readAttemptsJsonl(
  ws: string,
  runId: string,
): Promise<LeanExploreAttemptRecord[]> {
  const file = path.join(ws, ".mathran", "subagents", runId, "attempts.jsonl");
  const buf = await fs.readFile(file, "utf-8");
  return buf
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LeanExploreAttemptRecord);
}

// ─── Pure-helper unit tests ──────────────────────────────────────────────────

describe("lean_explore — pure helpers", () => {
  it("clampParallelism: defaults / clamps", () => {
    expect(clampParallelism(undefined)).toBe(DEFAULT_PARALLELISM);
    expect(clampParallelism(0)).toBe(1);
    expect(clampParallelism(1)).toBe(1);
    expect(clampParallelism(3)).toBe(3);
    expect(clampParallelism(MAX_PARALLELISM)).toBe(MAX_PARALLELISM);
    expect(clampParallelism(99)).toBe(MAX_PARALLELISM);
    expect(clampParallelism(NaN)).toBe(DEFAULT_PARALLELISM);
  });

  it("stripFences: removes ```lean fences", () => {
    expect(stripFences("```lean\ntheorem t : True := trivial\n```")).toBe(
      "theorem t : True := trivial",
    );
  });

  it("stripFences: removes generic ``` fences", () => {
    expect(stripFences("```\nfoo\n```")).toBe("foo");
  });

  it("stripFences: returns trimmed input when no fence", () => {
    expect(stripFences("  hello\n")).toBe("hello");
  });

  it("parseStrategiesLenient: parses clean JSON array", () => {
    expect(parseStrategiesLenient('["simp", "ring"]')).toEqual([
      "simp",
      "ring",
    ]);
  });

  it("parseStrategiesLenient: strips ```json fences", () => {
    expect(parseStrategiesLenient('```json\n["a", "b"]\n```')).toEqual([
      "a",
      "b",
    ]);
  });

  it("parseStrategiesLenient: regex-extracts inner array from prose", () => {
    expect(parseStrategiesLenient('Sure! Here you go: ["x","y"] OK')).toEqual([
      "x",
      "y",
    ]);
  });

  it("parseStrategiesLenient: returns null on garbage / empty", () => {
    expect(parseStrategiesLenient("not json at all")).toBeNull();
    expect(parseStrategiesLenient("")).toBeNull();
    expect(parseStrategiesLenient("{}")).toBeNull();
    expect(parseStrategiesLenient("[]")).toBeNull();
  });

  it("pickClosestIndex: shortest non-empty stderr wins; empty ranks worst", () => {
    const records: LeanExploreAttemptRecord[] = [
      {
        strategy: "a",
        proof: "",
        ok: false,
        stderrHead4k: "longish error msg",
        durationMs: 1,
        role: "loser",
      },
      {
        strategy: "b",
        proof: "",
        ok: false,
        stderrHead4k: "short",
        durationMs: 1,
        role: "loser",
      },
      {
        strategy: "c",
        proof: "",
        ok: false,
        stderrHead4k: "",
        durationMs: 1,
        role: "aborted",
      },
    ];
    expect(pickClosestIndex(records)).toBe(1);
  });

  it("pickClosestIndex: -1 when no failed attempts", () => {
    const records: LeanExploreAttemptRecord[] = [
      {
        strategy: "a",
        proof: "",
        ok: true,
        stderrHead4k: "",
        durationMs: 1,
        role: "winner",
      },
    ];
    expect(pickClosestIndex(records)).toBe(-1);
  });

  it("formatAttemptsJsonl: one JSON object per line", () => {
    const records: LeanExploreAttemptRecord[] = [
      {
        strategy: "a",
        proof: "p1",
        ok: true,
        stderrHead4k: "",
        durationMs: 5,
        role: "winner",
      },
      {
        strategy: "b",
        proof: "p2",
        ok: false,
        stderrHead4k: "err",
        durationMs: 6,
        role: "loser",
      },
    ];
    const out = formatAttemptsJsonl(records);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).strategy).toBe("a");
    expect(JSON.parse(lines[1]).ok).toBe(false);
  });
});

// ─── brainstormStrategies (helper) ───────────────────────────────────────────

describe("lean_explore — brainstormStrategies", () => {
  it("uses LLM array when parsable; tools:[]", async () => {
    const llm = new ScriptedLLM(['["foo", "bar", "baz"]']);
    const out = await brainstormStrategies(
      llm,
      "theorem t : True := by sorry",
      3,
      undefined,
      new AbortController().signal,
    );
    expect(out).toEqual(["foo", "bar", "baz"]);
    expect(llm.seen[0].tools).toEqual([]);
  });

  it("falls back to FALLBACK_STRATEGIES on garbage reply", async () => {
    const llm = new ScriptedLLM(["I cannot help with that"]);
    const out = await brainstormStrategies(
      llm,
      "lemma",
      3,
      undefined,
      new AbortController().signal,
    );
    expect(out).toEqual(FALLBACK_STRATEGIES.slice(0, 3));
  });

  it("pads with fallbacks when LLM returns fewer than asked", async () => {
    const llm = new ScriptedLLM(['["only_one"]']);
    const out = await brainstormStrategies(
      llm,
      "lemma",
      3,
      undefined,
      new AbortController().signal,
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("only_one");
  });
});

// ─── generateProof (helper) ──────────────────────────────────────────────────

describe("lean_explore — generateProof", () => {
  it("strips ```lean fences and returns the inner code", async () => {
    const llm = new ScriptedLLM(["```lean\ntheorem t : True := trivial\n```"]);
    const proof = await generateProof(
      llm,
      "theorem t : True := by sorry",
      "trivial",
      undefined,
      new AbortController().signal,
    );
    expect(proof).toBe("theorem t : True := trivial");
    expect(llm.seen[0].tools).toEqual([]);
  });

  it("returns raw text when no fence (lean-check rejects later)", async () => {
    const llm = new ScriptedLLM(["I refuse to write Lean"]);
    const proof = await generateProof(
      llm,
      "lemma",
      "s",
      undefined,
      new AbortController().signal,
    );
    expect(proof).toBe("I refuse to write Lean");
  });
});

// ─── Runner end-to-end ───────────────────────────────────────────────────────

describe("lean_explore — runner: happy path (winner)", () => {
  it("first ok=true attempt becomes the winner; summary names it", async () => {
    const llm = new ScriptedLLM([], (req) => {
      const user = req.messages.find((m) => m.role === "user")?.content ?? "";
      const m = user.match(/STRATEGY:\n(\S+)/);
      const tag = m ? m[1] : "x";
      return "```lean\nproof_for_" + tag + "\n```";
    });
    const leanCheck: LeanCheckSeam = async (code) => {
      if (/proof_for_win/.test(code)) return { ok: true, stderr: "" };
      return { ok: false, stderr: "type mismatch" };
    };
    const input = buildInput(workspace, llm, leanCheck, {
      strategies: ["lose1", "win", "lose2"],
    });
    const ctx = makeContext(workspace, new AbortController().signal, "sub-w1");
    const task: SubagentTask = {
      type: "lean_explore",
      input: input as unknown as Record<string, unknown>,
    };
    const res = await leanExploreRunner.run(task, ctx);

    expect(res.status).toBe("ok");
    expect(res.summary).toContain("succeeded");
    expect(res.summary).toContain("win");
    expect(res.artifactPath).toMatch(/attempts\.jsonl$/);

    const records = await readAttemptsJsonl(workspace, "sub-w1");
    expect(records).toHaveLength(3);
    const winner = records.find((r) => r.role === "winner");
    expect(winner?.strategy).toBe("win");
    expect(winner?.ok).toBe(true);
    expect(winner?.proof).toBe("proof_for_win");

    for (const req of llm.seen) {
      expect(req.tools).toEqual([]);
    }
  });
});

describe("lean_explore — runner: all attempts fail", () => {
  it("returns ok with 'none compiled' summary; all roles=loser", async () => {
    const llm = new ScriptedLLM([], () => "```lean\nbad\n```");
    const leanCheck: LeanCheckSeam = async () => ({
      ok: false,
      stderr: "could not unify",
    });
    const input = buildInput(workspace, llm, leanCheck, {
      strategies: ["a", "b", "c"],
    });
    const ctx = makeContext(
      workspace,
      new AbortController().signal,
      "sub-fail1",
    );
    const res = await leanExploreRunner.run(
      { type: "lean_explore", input: input as unknown as Record<string, unknown> },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(res.summary).toContain("none compiled");
    expect(res.summary).toContain("Closest:");

    const records = await readAttemptsJsonl(workspace, "sub-fail1");
    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.role).toBe("loser");
      expect(r.ok).toBe(false);
    }
  });
});

describe("lean_explore — runner: pre-supplied strategies bypass brainstorm", () => {
  it("does not call brainstorm LLM when strategies provided", async () => {
    const llm = new ScriptedLLM([], () => "```lean\np\n```");
    const leanCheck: LeanCheckSeam = async () => ({ ok: true, stderr: "" });
    const input = buildInput(workspace, llm, leanCheck, {
      strategies: ["foo", "bar"],
      parallelism: 2,
    });
    const ctx = makeContext(
      workspace,
      new AbortController().signal,
      "sub-bypass",
    );
    await leanExploreRunner.run({ type: "lean_explore", input: input as unknown as Record<string, unknown> }, ctx);

    expect(llm.seen).toHaveLength(2);
    for (const req of llm.seen) {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      expect(sys).toContain("prover");
      expect(sys).not.toContain("strategist");
    }
  });
});

describe("lean_explore — runner: brainstorm parse fallback", () => {
  it("uses FALLBACK_STRATEGIES when brainstorm reply is garbage", async () => {
    const seenSystems: string[] = [];
    const llm = new ScriptedLLM([], (req) => {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      seenSystems.push(sys);
      if (sys.includes("strategist")) return "totally not json";
      return "```lean\np\n```";
    });
    const leanCheck: LeanCheckSeam = async () => ({
      ok: false,
      stderr: "fail",
    });
    const input = buildInput(workspace, llm, leanCheck, {
      strategies: undefined,
      parallelism: 3,
    });
    const ctx = makeContext(
      workspace,
      new AbortController().signal,
      "sub-fallback",
    );
    const res = await leanExploreRunner.run(
      { type: "lean_explore", input: input as unknown as Record<string, unknown> },
      ctx,
    );

    expect(res.status).toBe("ok");
    expect(llm.seen).toHaveLength(4); // 1 brainstorm + 3 generateProof
    expect(seenSystems[0]).toContain("strategist");

    const records = await readAttemptsJsonl(workspace, "sub-fallback");
    expect(records.map((r) => r.strategy)).toEqual(
      FALLBACK_STRATEGIES.slice(0, 3),
    );
  });
});

describe("lean_explore — runner: validation", () => {
  it("empty lemma → status=error", async () => {
    const llm = new ScriptedLLM(["x"]);
    const leanCheck: LeanCheckSeam = async () => ({ ok: true, stderr: "" });
    const input = buildInput(workspace, llm, leanCheck, { lemma: "" });
    const ctx = makeContext(workspace);
    const res = await leanExploreRunner.run(
      { type: "lean_explore", input: input as unknown as Record<string, unknown> },
      ctx,
    );
    expect(res.status).toBe("error");
    expect(res.errorMessage).toMatch(/lemma/);
  });

  it("missing _leanCheck → status=error", async () => {
    const llm = new ScriptedLLM(["x"]);
    const input: LeanExploreInput = {
      lemma: "lemma",
      strategies: ["a"],
      workspace,
      llm,
    };
    const ctx = makeContext(workspace);
    const res = await leanExploreRunner.run(
      { type: "lean_explore", input: input as unknown as Record<string, unknown> },
      ctx,
    );
    expect(res.status).toBe("error");
    expect(res.errorMessage).toMatch(/_leanCheck/);
  });

  it("parallelism=10 clamps to MAX_PARALLELISM (does not error)", async () => {
    const llm = new ScriptedLLM([], () => "```lean\np\n```");
    const leanCheck: LeanCheckSeam = async () => ({ ok: true, stderr: "" });
    const input = buildInput(workspace, llm, leanCheck, {
      strategies: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"],
      parallelism: 10,
    });
    const ctx = makeContext(
      workspace,
      new AbortController().signal,
      "sub-clamp",
    );
    const res = await leanExploreRunner.run(
      { type: "lean_explore", input: input as unknown as Record<string, unknown> },
      ctx,
    );
    expect(res.status).toBe("ok");
    const records = await readAttemptsJsonl(workspace, "sub-clamp");
    expect(records.length).toBe(MAX_PARALLELISM);
    expect(records.map((r) => r.strategy)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
    ]);
  });
});

describe("lean_explore — runner: abort propagation", () => {
  it("external abort interrupts in-flight attempts (no winner → error)", async () => {
    const llm = new ScriptedLLM([], () => "```lean\np\n```");
    let leanReleased = false;
    const leanCheck: LeanCheckSeam = (_code, opts) =>
      new Promise<{ ok: boolean; stderr: string }>((resolve, reject) => {
        const sig = opts?.abortSignal;
        const onAbort = () => {
          leanReleased = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        if (sig?.aborted) onAbort();
        else sig?.addEventListener("abort", onAbort, { once: true });
        // never resolves on its own
      });
    const ctlr = new AbortController();
    const ctx = makeContext(workspace, ctlr.signal, "sub-abort");
    const input = buildInput(workspace, llm, leanCheck, {
      strategies: ["a", "b", "c"],
    });

    const p = leanExploreRunner.run({ type: "lean_explore", input: input as unknown as Record<string, unknown> }, ctx);
    await new Promise((r) => setTimeout(r, 30));
    ctlr.abort();
    const res = await p;

    expect(leanReleased).toBe(true);
    expect(res.status).toBe("error");
    expect(res.errorMessage).toMatch(/aborted/);
  });
});

describe("lean_explore — runner: anti-recursion invariant", () => {
  it("EVERY LLM request has tools: []", async () => {
    const llm = new ScriptedLLM([], (req) => {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("strategist")) return '["x","y","z"]';
      return "```lean\nproof\n```";
    });
    const leanCheck: LeanCheckSeam = async () => ({ ok: true, stderr: "" });
    const input = buildInput(workspace, llm, leanCheck, {
      strategies: undefined,
      parallelism: 3,
    });
    const ctx = makeContext(
      workspace,
      new AbortController().signal,
      "sub-norec",
    );
    await leanExploreRunner.run({ type: "lean_explore", input: input as unknown as Record<string, unknown> }, ctx);

    expect(llm.seen.length).toBeGreaterThan(0);
    for (const req of llm.seen) {
      expect(req.tools).toEqual([]);
    }
  });
});

describe("lean_explore — runner: concurrency", () => {
  it("3 attempts run in parallel (overlap via gated leanCheck)", async () => {
    const llm = new ScriptedLLM([], () => "```lean\np\n```");

    // Gate: leanCheck enters and waits on `gate`. If attempts ran
    // serially, only one could ever be waiting at a time, and the test
    // would never see all three `enters.size === 3`. Parallel execution
    // → all three enter the seam before we release.
    const enters = new Set<number>();
    let resolveAllEntered!: () => void;
    const allEntered = new Promise<void>((res) => {
      resolveAllEntered = res;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    let counter = 0;
    const leanCheck: LeanCheckSeam = async () => {
      const myId = counter++;
      enters.add(myId);
      if (enters.size === 3) resolveAllEntered();
      await gate;
      return { ok: false, stderr: "nope" };
    };

    const input = buildInput(workspace, llm, leanCheck, {
      strategies: ["s1", "s2", "s3"],
      parallelism: 3,
    });
    const ctx = makeContext(
      workspace,
      new AbortController().signal,
      "sub-conc",
    );
    const runP = leanExploreRunner.run(
      { type: "lean_explore", input: input as unknown as Record<string, unknown> },
      ctx,
    );
    // All 3 attempts must reach the leanCheck seam concurrently.
    await allEntered;
    expect(enters.size).toBe(3);
    releaseGate();
    const res = await runP;
    expect(res.status).toBe("ok");
    expect(res.summary).toContain("none compiled");
  });
});
