/**
 * Unit tests for the plan-mode runner (v0.3 §13).
 *
 * Drives `runPlan` against an in-memory fake LLM; no real provider involved.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { runPlan, extractPlanBody, PLAN_SYSTEM_PROMPT } from "./runner.js";
import { PlanStore } from "./store.js";
import type { LLMProvider, LLMRequest, LLMStreamChunk } from "../providers/llm.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-plan-runner-"));
});

/** Build a fake LLM that streams a fixed set of chunks per call. */
function fakeLLM(turns: LLMStreamChunk[][]): LLMProvider & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async describe() {
      return { name: "fake", defaultModel: "test" };
    },
    async chat(_req: LLMRequest) {
      this.calls++;
      const turn = turns[i++] ?? [{ type: "done", finishReason: "stop" }];
      return {
        async *stream() {
          for (const c of turn) yield c;
        },
      };
    },
  } as LLMProvider & { calls: number };
}

describe("extractPlanBody", () => {
  it("returns trimmed full text when no Plan heading is present", () => {
    expect(extractPlanBody("hi there\n\nno heading\n")).toBe("hi there\n\nno heading");
  });

  it("captures everything from the first '# Plan' heading onward", () => {
    const text = "intro paragraph\n\n# Plan\n- step 1\n- step 2\n";
    expect(extractPlanBody(text)).toBe("# Plan\n- step 1\n- step 2");
  });

  it("matches '## Plan' and other heading depths", () => {
    const text = "preface\n\n## Plan\nbody";
    expect(extractPlanBody(text)).toBe("## Plan\nbody");
  });

  it("is case-insensitive on the heading", () => {
    expect(extractPlanBody("# PLAN\nx")).toBe("# PLAN\nx");
  });

  it("handles 'Plan: subtitle' style headings", () => {
    expect(extractPlanBody("# Plan: deep dive\nbody")).toBe("# Plan: deep dive\nbody");
  });

  it("returns empty string on empty input", () => {
    expect(extractPlanBody("")).toBe("");
  });
});

describe("runPlan happy path", () => {
  it("captures the plan body when LLM ends with '# Plan' heading", async () => {
    const llm = fakeLLM([
      [
        { type: "text", delta: "Let me think about this.\n\n" },
        { type: "text", delta: "# Plan\n- step A\n- step B\n" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runPlan({
      objective: "make X faster",
      workspace,
      llm,
      model: "fake",
    });
    expect(r.turns).toBe(1);
    expect(r.aborted).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.body).toBe("# Plan\n- step A\n- step B");
    expect(r.planId).toMatch(/^plan-/);

    // Plan record should be on disk with the same body.
    const store = new PlanStore({ workspace });
    const persisted = await store.get(r.planId);
    expect(persisted?.objective).toBe("make X faster");
    expect(persisted?.status).toBe("draft");
    expect(persisted?.body).toBe("# Plan\n- step A\n- step B");
    expect(persisted?.modelHint).toBe("fake");
  });

  it("uses entire final message when no '# Plan' heading is produced", async () => {
    const llm = fakeLLM([
      [
        { type: "text", delta: "I think we should do X then Y.\n" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runPlan({
      objective: "plan something",
      workspace,
      llm,
      model: "fake",
    });
    expect(r.body).toBe("I think we should do X then Y.");
  });
});

describe("runPlan budget", () => {
  it("stops after maxTurns and reports truncated=true", async () => {
    const turns: LLMStreamChunk[][] = [];
    // Each turn says "tool_calls" so we never naturally stop.
    for (let i = 0; i < 5; i++) {
      turns.push([
        { type: "text", delta: `partial ${i}\n` },
        { type: "done", finishReason: "tool_calls" },
      ]);
    }
    const llm = fakeLLM(turns);
    const r = await runPlan({
      objective: "x",
      workspace,
      llm,
      model: "fake",
      maxTurns: 3,
    });
    expect(r.turns).toBe(3);
    expect(r.truncated).toBe(true);
    expect(r.body).toContain("partial 2");
  });
});

describe("runPlan abort", () => {
  it("returns aborted=true when signal fires before send starts", async () => {
    const ac = new AbortController();
    ac.abort();
    const llm = fakeLLM([
      [
        { type: "text", delta: "you won't see me" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runPlan({
      objective: "x",
      workspace,
      llm,
      model: "fake",
      abortSignal: ac.signal,
    });
    expect(r.aborted).toBe(true);
    expect(r.turns).toBe(0);
  });

  it("returns aborted=true when send throws AbortError mid-stream", async () => {
    // Build an LLM whose stream raises AbortError on demand. Easier than
    // racing: just throw immediately after the first chunk.
    const llm: LLMProvider = {
      async describe() {
        return { name: "fake-abort" };
      },
      async chat() {
        return {
          async *stream() {
            yield { type: "text", delta: "hello" } as LLMStreamChunk;
            const err = new Error("Aborted");
            err.name = "AbortError";
            throw err;
          },
        };
      },
    };
    const r = await runPlan({
      objective: "x",
      workspace,
      llm,
      model: "fake",
    });
    expect(r.aborted).toBe(true);
    // Plan record was created and persisted (with whatever body we got).
    const store = new PlanStore({ workspace });
    const persisted = await store.get(r.planId);
    expect(persisted?.status).toBe("draft");
  });
});

describe("runPlan system prompt", () => {
  it("uses PLAN_SYSTEM_PROMPT as the default and forwards it to the LLM", async () => {
    const seen: LLMRequest[] = [];
    const llm: LLMProvider = {
      async describe() {
        return { name: "fake" };
      },
      async chat(req) {
        seen.push(req);
        return {
          async *stream() {
            yield { type: "text", delta: "ok\n# Plan\nbody" };
            yield { type: "done", finishReason: "stop" };
          },
        };
      },
    };
    await runPlan({ objective: "x", workspace, llm, model: "fake" });
    const sys = seen[0].messages.find((m) => m.role === "system");
    expect(sys?.content).toBe(PLAN_SYSTEM_PROMPT);
    // Tools advertised should be exactly the two read-only built-ins.
    const toolNames = (seen[0].tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual(["read_file_summary", "search"]);
  });
});
