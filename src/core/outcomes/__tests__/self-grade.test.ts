import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  selfGradeGoal,
  triggerSelfGrade,
  resolutionFromCompletion,
  buildTraceFromHistory,
} from "../self-grade.js";
import { readOutcome, readIndex } from "../store.js";
import type { LLMMessage, LLMProvider, LLMRequest } from "../../providers/llm.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-selfgrade-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A provider that streams a single fixed text reply. */
function textLLM(reply: string): LLMProvider {
  return {
    async describe() {
      return { name: "fake", defaultModel: "test" };
    },
    async chat(_req: LLMRequest) {
      return {
        async *stream() {
          yield { type: "text" as const, delta: reply };
          yield { type: "done" as const, finishReason: "stop" as const };
        },
      };
    },
  };
}

/** A provider whose chat() rejects — exercises the failure path. */
function errorLLM(): LLMProvider {
  return {
    async describe() {
      return { name: "fake", defaultModel: "test" };
    },
    async chat(_req: LLMRequest): Promise<never> {
      throw new Error("simulated transport failure");
    },
  };
}

const GOOD_REPLY =
  '{"rubric":{"correctness":5,"completeness":4,"efficiency":4},"lessons":"Used TDD; ran tests each round.","contextTags":["TypeScript","Refactor"]}';

describe("resolutionFromCompletion", () => {
  it("maps done→complete and give_up→abandoned", () => {
    expect(resolutionFromCompletion("done")).toBe("complete");
    expect(resolutionFromCompletion("give_up")).toBe("abandoned");
  });
});

describe("buildTraceFromHistory", () => {
  it("flattens assistant/tool/user turns and skips system", () => {
    const history: LLMMessage[] = [
      { role: "system", content: "secret system prompt" },
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: "on it",
        toolCalls: [{ id: "1", name: "bash", arguments: '{"cmd":"ls"}' }],
      },
      { role: "tool", name: "bash", content: "file.txt" },
    ];
    const trace = buildTraceFromHistory(history);
    expect(trace).not.toContain("secret system prompt");
    expect(trace).toContain("USER: do the thing");
    expect(trace).toContain("ASSISTANT: on it");
    expect(trace).toContain("tool bash");
    expect(trace).toContain("TOOL[bash]: file.txt");
  });
});

describe("selfGradeGoal", () => {
  it("writes a graded outcome on success", async () => {
    const outcome = await selfGradeGoal({
      workspace,
      goalId: "g1",
      objective: "refactor the parser",
      resolution: "complete",
      endReason: "done",
      startedAt: 100,
      endedAt: 200,
      history: [{ role: "assistant", content: "did it" }],
      llm: textLLM(GOOD_REPLY),
      model: "test",
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.averageScore).toBeCloseTo(4.3, 5);
    // Tags are lowercased + trimmed.
    expect(outcome!.contextTags).toEqual(["typescript", "refactor"]);

    const onDisk = await readOutcome(workspace, "g1");
    expect(onDisk?.lessons).toContain("TDD");
    const index = await readIndex(workspace);
    expect(index).toHaveLength(1);
  });

  it("returns null and writes nothing when the LLM throws (failure path)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await selfGradeGoal({
      workspace,
      goalId: "g-err",
      objective: "x",
      resolution: "complete",
      startedAt: 1,
      endedAt: 2,
      history: [{ role: "assistant", content: "hi" }],
      llm: errorLLM(),
      model: "test",
    });

    expect(result).toBeNull();
    expect(await readOutcome(workspace, "g-err")).toBeNull();
    expect(await readIndex(workspace)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("self-grade failed");
  });

  it("returns null on malformed grader JSON (no throw)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await selfGradeGoal({
      workspace,
      goalId: "g-bad",
      objective: "x",
      resolution: "complete",
      startedAt: 1,
      endedAt: 2,
      history: [{ role: "assistant", content: "hi" }],
      llm: textLLM("totally not json"),
      model: "test",
    });
    expect(result).toBeNull();
    expect(await readOutcome(workspace, "g-bad")).toBeNull();
  });
});

describe("triggerSelfGrade", () => {
  it("is fire-and-forget and never throws even with a broken provider", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Should return synchronously without awaiting / throwing.
    expect(() =>
      triggerSelfGrade({
        workspace,
        goalId: "g-bg",
        objective: "x",
        resolution: "complete",
        startedAt: 1,
        endedAt: 2,
        history: [{ role: "assistant", content: "hi" }],
        llm: errorLLM(),
        model: "test",
      }),
    ).not.toThrow();
    // Give the background promise a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(await readOutcome(workspace, "g-bg")).toBeNull();
  });
});
