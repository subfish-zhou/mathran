import { describe, it, expect } from "vitest";
import { taskSignature, classifyFailure, avoidHintFor } from "./subagent-persistence";

describe("subagent-persistence — pure regulator helpers", () => {
  describe("taskSignature", () => {
    it("is stable across identical inputs", () => {
      const a = taskSignature("solve_proof", { goal: "P->P", depth: 3 });
      const b = taskSignature("solve_proof", { goal: "P->P", depth: 3 });
      expect(a).toBe(b);
      expect(a).toMatch(/^solve_proof::[0-9a-f]{16}$/);
    });

    it("differs when the agent name differs", () => {
      const a = taskSignature("a_tool", { x: 1 });
      const b = taskSignature("b_tool", { x: 1 });
      expect(a).not.toBe(b);
    });

    it("differs when the args differ", () => {
      const a = taskSignature("tool", { x: 1 });
      const b = taskSignature("tool", { x: 2 });
      expect(a).not.toBe(b);
    });

    it("tolerates undefined/missing agent and args without throwing", () => {
      expect(() => taskSignature(undefined, undefined)).not.toThrow();
      expect(taskSignature(undefined, undefined)).toMatch(/^\?::[0-9a-f]{16}$/);
    });

    it("tolerates non-JSON-serializable args (falls back to String())", () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;
      expect(() => taskSignature("tool", cyclic)).not.toThrow();
    });
  });

  describe("classifyFailure", () => {
    it("CONTENT_FILTER: Azure content_filter wording", () => {
      expect(classifyFailure({ errorMsg: "400 The response was filtered due to content_filter" })).toBe("CONTENT_FILTER");
      expect(classifyFailure({ errorMsg: "ResponsibleAIPolicyViolation" })).toBe("CONTENT_FILTER");
    });

    it("DEPTH: bracketed tag from executor + plain wording", () => {
      expect(classifyFailure({ errorMsg: "[DEPTH_LIMIT] Sub-agent recursion depth exceeded (max 5)" })).toBe("DEPTH");
      expect(classifyFailure({ errorMsg: "recursion depth exceeded" })).toBe("DEPTH");
    });

    it("QUOTA: any of the three bracketed quota tags", () => {
      expect(classifyFailure({ errorMsg: "[CONCURRENCY_LIMIT] Max 100 concurrent sub-agents reached" })).toBe("QUOTA");
      expect(classifyFailure({ errorMsg: "[PARENT_QUOTA] per-parent quota" })).toBe("QUOTA");
      expect(classifyFailure({ errorMsg: "[PROVIDER_TPM] token budget exhausted" })).toBe("QUOTA");
    });

    it("TASK_TOO_BIG: stoppedReason takes precedence over msg", () => {
      expect(classifyFailure({ stoppedReason: "tokens" })).toBe("TASK_TOO_BIG");
      expect(classifyFailure({ stoppedReason: "iterations" })).toBe("TASK_TOO_BIG");
      expect(classifyFailure({ stoppedReason: "wall_clock" })).toBe("TASK_TOO_BIG");
    });

    it("TRANSIENT: typical transport errors", () => {
      expect(classifyFailure({ errorMsg: "429 Too Many Requests" })).toBe("TRANSIENT");
      expect(classifyFailure({ errorMsg: "503 Service Unavailable" })).toBe("TRANSIENT");
      expect(classifyFailure({ errorMsg: "fetch failed: ECONNRESET" })).toBe("TRANSIENT");
      expect(classifyFailure({ errorMsg: "socket hang up" })).toBe("TRANSIENT");
    });

    it("UNKNOWN fallback", () => {
      expect(classifyFailure({ errorMsg: "something genuinely unexpected" })).toBe("UNKNOWN");
      expect(classifyFailure({})).toBe("UNKNOWN");
    });
  });

  describe("avoidHintFor", () => {
    it("CONTENT_FILTER, DEPTH, TASK_TOO_BIG → actionable hint", () => {
      expect(avoidHintFor("CONTENT_FILTER")).toMatch(/rephrase/i);
      expect(avoidHintFor("DEPTH")).toMatch(/decompose|recursion-depth/i);
      expect(avoidHintFor("TASK_TOO_BIG")).toMatch(/split|narrow|scope/i);
    });

    it("TRANSIENT and QUOTA → no hint (not the task's fault)", () => {
      // Critical: TRANSIENT must never be warned off — that would punish a task
      // for an unrelated network blip and prevent the retry from succeeding.
      expect(avoidHintFor("TRANSIENT")).toBeUndefined();
      expect(avoidHintFor("QUOTA")).toBeUndefined();
    });

    it("UNKNOWN with detail → echoes truncated detail, without → undefined", () => {
      const hint = avoidHintFor("UNKNOWN", "weird thing happened");
      expect(hint).toMatch(/weird thing happened/);
      expect(avoidHintFor("UNKNOWN")).toBeUndefined();
    });
  });

  // [P1-1 fix] PROCESS_OWNER_ID is the seam that lets multi-process
  // deployments avoid mutual rehydrate-stomping. Verify shape so future
  // refactors keep it usable as a primary-key-ish id.
  describe("PROCESS_OWNER_ID", () => {
    it("is a non-empty string with the hostname:pid:bootMs shape (default)", async () => {
      const { PROCESS_OWNER_ID } = await import("./subagent-persistence");
      expect(typeof PROCESS_OWNER_ID).toBe("string");
      expect(PROCESS_OWNER_ID.length).toBeGreaterThan(0);
      // Default format unless MATHUB_PROCESS_ID env override is set; in test
      // env we don't set the override, so check the colon-shape loosely.
      if (!process.env.MATHUB_PROCESS_ID) {
        expect(PROCESS_OWNER_ID.split(":").length).toBeGreaterThanOrEqual(3);
      }
    });

    it("stays constant within the same process (module singleton)", async () => {
      const a = (await import("./subagent-persistence")).PROCESS_OWNER_ID;
      const b = (await import("./subagent-persistence")).PROCESS_OWNER_ID;
      expect(a).toBe(b);
    });
  });
});
