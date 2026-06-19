/**
 * Tests for the research subagent runner (v0.3 §17).
 *
 * Strategy: drive the runner directly with mock LLM and mock scheduler so
 * we can script the planner's JSON replies and observe every dispatch
 * without touching disk-heavy search/read paths.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_MAX_ROUNDS,
  PLANNER_SYSTEM,
  SUBDISPATCH_HARD_CAP_BYTES,
  SYNTHESIS_SYSTEM,
  formatFindings,
  parsePlannerAction,
  researchRunner,
  type ResearchInput,
  type ResearchScheduler,
} from "./research.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";
import type {
  SubagentContext,
  SubagentResult,
  SubagentTask,
} from "../types.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

/**
 * ScriptedLLM: replies with a queued list of raw text strings, one per
 * `chat()` call. Records every request so tests can assert prompts +
 * `tools: []` invariants.
 */
class ScriptedLLM implements LLMProvider {
  readonly seen: LLMRequest[] = [];
  shouldThrow: Error | null = null;
  shouldThrowOnNthCall: number | null = null; // 1-indexed
  constructor(private readonly responses: string[]) {}
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
    const text =
      this.responses[Math.min(this.seen.length - 1, this.responses.length - 1)] ??
      "";
    return {
      async *stream(): AsyncIterable<LLMStreamChunk> {
        yield { type: "text", delta: text };
        yield { type: "done", finishReason: "stop" };
      },
    };
  }
}

/** RecordingScheduler: records every dispatch and returns canned results. */
class RecordingScheduler implements ResearchScheduler {
  readonly seen: SubagentTask[] = [];
  constructor(
    private readonly responder: (task: SubagentTask) => Partial<SubagentResult>,
  ) {}
  async dispatch(task: SubagentTask): Promise<SubagentResult> {
    this.seen.push(task);
    const part = this.responder(task);
    const now = new Date().toISOString();
    return {
      runId: `sub-mock${this.seen.length.toString().padStart(4, "0")}`,
      type: task.type,
      status: part.status ?? "ok",
      summary: part.summary ?? "",
      artifactPath: part.artifactPath ?? null,
      stats: { startedAt: now, endedAt: now, durationMs: 0 },
      ...(part.errorMessage ? { errorMessage: part.errorMessage } : {}),
    };
  }
}

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-research-"));
});
afterEach(async () => {
  if (workspace) {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

/** Build a SubagentContext that writes artifacts under workspace/.mathran. */
function makeContext(
  ws: string,
  signal: AbortSignal = new AbortController().signal,
  runId = "sub-test1234",
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

// ─── parsePlannerAction unit tests ──────────────────────────────────────────

describe("research — parsePlannerAction", () => {
  it("parses a clean search action", () => {
    const a = parsePlannerAction(
      '{"action":"search","query":"goalRunner","glob":"src/**/*.ts"}',
    );
    expect(a).toEqual({
      kind: "search",
      query: "goalRunner",
      glob: "src/**/*.ts",
    });
  });

  it("parses a search without glob", () => {
    const a = parsePlannerAction('{"action":"search","query":"foo"}');
    expect(a).toEqual({ kind: "search", query: "foo" });
  });

  it("parses a clean read action", () => {
    const a = parsePlannerAction('{"action":"read","path":"src/x.ts"}');
    expect(a).toEqual({ kind: "read", path: "src/x.ts" });
  });

  it("parses a clean done action", () => {
    expect(parsePlannerAction('{"action":"done"}')).toEqual({ kind: "done" });
  });

  it("strips ```json fences", () => {
    const a = parsePlannerAction(
      '```json\n{"action":"search","query":"x"}\n```',
    );
    expect(a).toEqual({ kind: "search", query: "x" });
  });

  it("strips generic ``` fences", () => {
    const a = parsePlannerAction(
      '```\n{"action":"read","path":"a/b.md"}\n```',
    );
    expect(a).toEqual({ kind: "read", path: "a/b.md" });
  });

  it("regex-extracts a JSON block surrounded by prose", () => {
    const a = parsePlannerAction(
      'Sure, here you go: {"action":"search","query":"foo"} hope that helps!',
    );
    expect(a).toEqual({ kind: "search", query: "foo" });
  });

  it("falls back to done on unparseable text", () => {
    expect(parsePlannerAction("not json at all")).toEqual({ kind: "done" });
    expect(parsePlannerAction("")).toEqual({ kind: "done" });
    expect(parsePlannerAction("```json\n{invalid\n```")).toEqual({
      kind: "done",
    });
  });

  it("falls back to done on unknown action verb", () => {
    expect(
      parsePlannerAction('{"action":"hack-the-planet","query":"x"}'),
    ).toEqual({ kind: "done" });
  });

  it("falls back to done when required fields are missing", () => {
    expect(parsePlannerAction('{"action":"search"}')).toEqual({ kind: "done" });
    expect(parsePlannerAction('{"action":"read"}')).toEqual({ kind: "done" });
  });
});

// ─── formatFindings ─────────────────────────────────────────────────────────

describe("research — formatFindings", () => {
  it("renders the empty state", () => {
    expect(formatFindings([])).toBe("(none yet)");
  });
  it("renders rounds with action + status + summary", () => {
    const txt = formatFindings([
      {
        round: 1,
        action: { kind: "search", query: "foo" },
        status: "ok",
        summary: "found 3 hits",
        artifactPath: null,
      },
      {
        round: 2,
        action: { kind: "read", path: "x.ts" },
        status: "ok",
        summary: "summary text",
        artifactPath: null,
      },
    ]);
    expect(txt).toContain("Round 1");
    expect(txt).toContain('search "foo"');
    expect(txt).toContain("[ok]");
    expect(txt).toContain("found 3 hits");
    expect(txt).toContain("Round 2");
    expect(txt).toContain("read x.ts");
    expect(txt).toContain("summary text");
  });
});

// ─── Runner integration tests ───────────────────────────────────────────────

describe("research runner — happy path 2-round", () => {
  it("plans search → plans read → done → synthesizes a report", async () => {
    const llm = new ScriptedLLM([
      // Round 1: plan a search
      '{"action":"search","query":"goalRunner"}',
      // Round 2: plan a read
      '{"action":"read","path":"src/core/goal.ts"}',
      // Round 3: done
      '{"action":"done"}',
      // Synthesis
      "# Research Report\n\n## Question\nQ\n\n## Findings\n- (round 1) ...\n\n## Answer\nThe goalRunner is the orchestrator.\n",
    ]);
    const sched = new RecordingScheduler((task) => {
      if (task.type === "search") {
        return {
          status: "ok",
          summary: "found 5 matches in src/core/goal.ts",
          artifactPath: ".mathran/subagents/sub-aaaa/matches.jsonl",
        };
      }
      if (task.type === "read_summarize") {
        return {
          status: "ok",
          summary: "goalRunner orchestrates plans and dispatches subagents.",
          artifactPath: ".mathran/subagents/sub-bbbb/source.txt",
        };
      }
      return { status: "error", summary: "unknown" };
    });

    const ctx = makeContext(workspace);
    const input: ResearchInput = {
      question: "What is the goalRunner?",
      workspace,
      llm,
      scheduler: sched,
    };
    const result = await researchRunner.run(
      { type: "research", input: input as unknown as Record<string, unknown> },
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("## Answer");
    expect(result.artifactPath).toMatch(
      /^\.mathran\/subagents\/sub-test1234\/report\.md$/,
    );

    // Scheduler dispatched exactly twice (search + read). NOT three times —
    // the round-3 done action should not produce a dispatch.
    expect(sched.seen.length).toBe(2);
    expect(sched.seen[0].type).toBe("search");
    expect(sched.seen[0].input.query).toBe("goalRunner");
    expect(sched.seen[0].input.workspace).toBe(workspace);
    expect(sched.seen[0].hardCapBytes).toBe(SUBDISPATCH_HARD_CAP_BYTES);
    expect(sched.seen[1].type).toBe("read_summarize");
    expect(sched.seen[1].input.path).toBe("src/core/goal.ts");
    expect(sched.seen[1].input.question).toBe("What is the goalRunner?");

    // EVERY LLM request used tools: [] — the anti-recursion invariant.
    expect(llm.seen.length).toBe(4); // 3 plan + 1 synthesis
    for (const req of llm.seen) {
      expect(req.tools).toEqual([]);
    }
    // Planner system prompt + synthesizer system prompt verbatim.
    expect(llm.seen[0].messages[0].content).toBe(PLANNER_SYSTEM);
    expect(llm.seen[3].messages[0].content).toBe(SYNTHESIS_SYSTEM);

    // The artifact on disk has the full report.
    const onDisk = await fs.readFile(
      path.join(workspace, result.artifactPath!),
      "utf8",
    );
    expect(onDisk).toContain("## Answer");
  });
});

describe("research runner — synthesis-only path", () => {
  it("planner says done in round 1 → no scheduler dispatches; synthesis still runs", async () => {
    const llm = new ScriptedLLM([
      '{"action":"done"}',
      "# Research Report\n\n## Answer\nNo work needed.\n",
    ]);
    const sched = new RecordingScheduler(() => ({
      status: "ok",
      summary: "should not happen",
    }));

    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "Trivial question",
          workspace,
          llm,
          scheduler: sched,
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace),
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("## Answer");
    expect(sched.seen.length).toBe(0);
    // Two LLM calls: planner + synthesizer.
    expect(llm.seen.length).toBe(2);
  });
});

describe("research runner — maxRounds cap", () => {
  it("planner never says done → loop hits maxRounds → synthesis still runs", async () => {
    const llm = new ScriptedLLM([
      '{"action":"search","query":"a"}',
      '{"action":"search","query":"b"}',
      // (synthesis call is the third one)
      "# Research Report\n\n## Answer\nGot 2 findings.\n",
    ]);
    const sched = new RecordingScheduler(() => ({
      status: "ok",
      summary: "ok",
    }));
    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "Q",
          workspace,
          llm,
          scheduler: sched,
          maxRounds: 2,
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace),
    );
    expect(result.status).toBe("ok");
    expect(sched.seen.length).toBe(2);
    // 2 plan calls + 1 synthesis call.
    expect(llm.seen.length).toBe(3);
  });
});

describe("research runner — abort mid-loop", () => {
  it("aborting between rounds exits the loop; synthesis still attempts", async () => {
    const ac = new AbortController();
    const llm = new ScriptedLLM([
      // Round 1: plan a search
      '{"action":"search","query":"foo"}',
      // Synthesis (we abort BEFORE round 2 plans)
      "# Research Report\n\n## Answer\nPartial.\n",
    ]);
    const sched = new RecordingScheduler(() => {
      // Abort right after the first dispatch completes.
      ac.abort();
      return { status: "ok", summary: "one finding" };
    });
    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "Q",
          workspace,
          llm,
          scheduler: sched,
          maxRounds: 5,
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace, ac.signal),
    );
    // Loop saw round 1 (search), then aborted → only one dispatch.
    expect(sched.seen.length).toBe(1);
    // Synthesis still ran and the runner returned ok.
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("## Answer");
  });

  it("returns status=error when synthesis itself sees abort", async () => {
    const ac = new AbortController();
    ac.abort(); // pre-aborted: runner exits early before any LLM call
    const llm = new ScriptedLLM(["# unused"]);
    const sched = new RecordingScheduler(() => ({ status: "ok", summary: "" }));
    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "Q",
          workspace,
          llm,
          scheduler: sched,
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace, ac.signal),
    );
    expect(result.status).toBe("error");
    expect(result.errorMessage).toMatch(/abort/i);
    expect(llm.seen.length).toBe(0);
    expect(sched.seen.length).toBe(0);
  });

  it("returns status=error when the synthesizer LLM throws abort", async () => {
    // Loop runs (maxRounds=1, planner says done) → synthesizer LLM throws an
    // AbortError → runner returns error.
    const llm = new ScriptedLLM(['{"action":"done"}', "unused"]);
    llm.shouldThrowOnNthCall = 2;
    llm.shouldThrow = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const sched = new RecordingScheduler(() => ({ status: "ok", summary: "" }));

    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "Q",
          workspace,
          llm,
          scheduler: sched,
          maxRounds: 1,
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace),
    );
    expect(result.status).toBe("error");
    expect(result.errorMessage).toMatch(/abort/i);
  });
});

describe("research runner — malformed planner JSON", () => {
  it("treats malformed JSON as done and proceeds to synthesis", async () => {
    const llm = new ScriptedLLM([
      "```json\n{invalid\n```",
      "# Research Report\n\n## Answer\nfallback.\n",
    ]);
    const sched = new RecordingScheduler(() => ({ status: "ok", summary: "" }));
    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "Q",
          workspace,
          llm,
          scheduler: sched,
          maxRounds: 3,
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace),
    );
    expect(result.status).toBe("ok");
    // No dispatches because planner fell back to done.
    expect(sched.seen.length).toBe(0);
    // Two LLM calls: malformed-plan + synthesis.
    expect(llm.seen.length).toBe(2);
  });
});

describe("research runner — read dedup", () => {
  it("two consecutive reads of the same path → second one skipped", async () => {
    const llm = new ScriptedLLM([
      // Round 1: read x.ts
      '{"action":"read","path":"x.ts"}',
      // Round 2: read x.ts AGAIN (should be skipped — no double dispatch)
      '{"action":"read","path":"x.ts"}',
      // Round 3: done
      '{"action":"done"}',
      // Synthesis
      "# Research Report\n\n## Answer\nfine.\n",
    ]);
    const sched = new RecordingScheduler(() => ({
      status: "ok",
      summary: "x.ts content summary",
    }));

    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "What is x.ts?",
          workspace,
          llm,
          scheduler: sched,
          maxRounds: 5,
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace),
    );
    expect(result.status).toBe("ok");
    // ONLY one dispatch — the dup was skipped.
    expect(sched.seen.length).toBe(1);
    expect(sched.seen[0].type).toBe("read_summarize");
  });
});

describe("research runner — sub-dispatch failure does not abort", () => {
  it("scheduler returns status=error → runner records it and continues", async () => {
    const llm = new ScriptedLLM([
      '{"action":"search","query":"alpha"}',
      '{"action":"search","query":"beta"}',
      '{"action":"done"}',
      "# Research Report\n\n## Answer\ngot what we could.\n",
    ]);
    let callIdx = 0;
    const sched = new RecordingScheduler(() => {
      callIdx++;
      if (callIdx === 1) {
        return {
          status: "error",
          summary: "",
          errorMessage: "search failed: glob crashed",
        };
      }
      return { status: "ok", summary: "beta found 1 hit" };
    });

    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "Q",
          workspace,
          llm,
          scheduler: sched,
          maxRounds: 5,
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace),
    );
    expect(result.status).toBe("ok");
    expect(sched.seen.length).toBe(2); // ran both searches despite the first failing
    // Both findings were folded into the synthesis prompt.
    const synthesisReq = llm.seen[3];
    const userMsg = synthesisReq.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("Round 1");
    expect(userMsg?.content).toContain("Round 2");
    expect(userMsg?.content).toMatch(/error|search failed/i);
  });
});

describe("research runner — input validation", () => {
  it("rejects empty question", async () => {
    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "",
          workspace,
          llm: new ScriptedLLM([]),
          scheduler: new RecordingScheduler(() => ({ status: "ok" })),
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace),
    );
    expect(result.status).toBe("error");
    expect(result.errorMessage).toMatch(/question/);
  });
  it("rejects missing scheduler", async () => {
    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "Q",
          workspace,
          llm: new ScriptedLLM([]),
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace),
    );
    expect(result.status).toBe("error");
    expect(result.errorMessage).toMatch(/scheduler/);
  });
  it("rejects missing llm", async () => {
    const result = await researchRunner.run(
      {
        type: "research",
        input: {
          question: "Q",
          workspace,
          scheduler: new RecordingScheduler(() => ({ status: "ok" })),
        } as unknown as Record<string, unknown>,
      },
      makeContext(workspace),
    );
    expect(result.status).toBe("error");
    expect(result.errorMessage).toMatch(/llm/);
  });
});

describe("research runner — registration", () => {
  it("exposes type='research'", () => {
    expect(researchRunner.type).toBe("research");
  });
  it("DEFAULT_MAX_ROUNDS is 4", () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(4);
  });
});
