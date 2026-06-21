/**
 * Unit tests for the `propose_plan` chat-mode tool (v0.17 follow-up P2).
 *
 * Parallel coverage to propose-goal.test.ts but for plan mode:
 *
 *   1. Reply parser accepts documented shapes + fails CLOSED on garbage.
 *   2. Reply parser honours the `seed-only` / `run` / `auto-run` suffixes
 *      that override the model-supplied default autoRun.
 *   3. On confirm, a Plan record IS written via PlanStore.create().
 *   4. On cancel, NO plan is written.
 *   5. Tool returns the structured JSON the SSE pump reads.
 *   6. autoRunner is invoked on confirm-with-autoRun, NOT on
 *      confirm-with-seed-only, and NOT on cancel.
 *   7. autoRunner errors are SWALLOWED — the plan record stays on disk.
 *   8. The question text mentions objective, reasoning, and the default
 *      autoRun mode so the user understands what they're confirming.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createProposePlanTool,
  parseProposePlanReply,
  formatProposePlanQuestion,
} from "./propose-plan";
import type { AskUserResolver } from "./ask-user";
import { PlanStore } from "../../plan/store";

describe("parseProposePlanReply", () => {
  it("plain `confirm` honours the default-autoRun argument", () => {
    expect(parseProposePlanReply("confirm", true)).toEqual({
      kind: "confirm",
      autoRun: true,
    });
    expect(parseProposePlanReply("confirm", false)).toEqual({
      kind: "confirm",
      autoRun: false,
    });
  });

  it("`confirm seed-only` overrides autoRun to false even if default was true", () => {
    expect(parseProposePlanReply("confirm seed-only", true)).toEqual({
      kind: "confirm",
      autoRun: false,
    });
  });

  it("`confirm seedonly` (no hyphen) also overrides to false", () => {
    expect(parseProposePlanReply("confirm seedonly", true)).toEqual({
      kind: "confirm",
      autoRun: false,
    });
  });

  it("`confirm run` overrides autoRun to true even if default was false", () => {
    expect(parseProposePlanReply("confirm run", false)).toEqual({
      kind: "confirm",
      autoRun: true,
    });
  });

  it("`confirm auto-run` overrides to true", () => {
    expect(parseProposePlanReply("confirm auto-run", false)).toEqual({
      kind: "confirm",
      autoRun: true,
    });
  });

  it("`confirm autorun` (no hyphen) overrides to true", () => {
    expect(parseProposePlanReply("confirm autorun", false)).toEqual({
      kind: "confirm",
      autoRun: true,
    });
  });

  it("`confirm now` overrides to true", () => {
    expect(parseProposePlanReply("confirm now", false)).toEqual({
      kind: "confirm",
      autoRun: true,
    });
  });

  it.each(["yes", "y", "ok", "go"])(
    "treats `%s` as confirm with default autoRun",
    (word) => {
      expect(parseProposePlanReply(word, true)).toEqual({
        kind: "confirm",
        autoRun: true,
      });
    },
  );

  it.each(["cancel", "no", "n", "abort", "stop"])(
    "treats `%s` as cancel",
    (word) => {
      expect(parseProposePlanReply(word, true)).toEqual({ kind: "cancel" });
    },
  );

  it("CASE-insensitive matching", () => {
    expect(parseProposePlanReply("CONFIRM SEED-ONLY", true)).toEqual({
      kind: "confirm",
      autoRun: false,
    });
    expect(parseProposePlanReply("Cancel", true)).toEqual({ kind: "cancel" });
  });

  it("empty / whitespace → cancel (fail closed)", () => {
    expect(parseProposePlanReply("", true)).toEqual({ kind: "cancel" });
    expect(parseProposePlanReply("   \t  ", true)).toEqual({ kind: "cancel" });
  });

  it("unrecognised reply → cancel (fail closed)", () => {
    expect(parseProposePlanReply("maybe", true)).toEqual({ kind: "cancel" });
    expect(parseProposePlanReply("uhhh sure", true)).toEqual({ kind: "cancel" });
  });

  it("`confirm <gibberish-suffix>` keeps the default autoRun", () => {
    // Unrecognised suffix shouldn't flip the bit — we keep the model's
    // suggestion. This is intentional: the model has more context about
    // whether the work warrants immediate execution than a tail-token
    // pattern can capture.
    expect(parseProposePlanReply("confirm xyz", true)).toEqual({
      kind: "confirm",
      autoRun: true,
    });
    expect(parseProposePlanReply("confirm xyz", false)).toEqual({
      kind: "confirm",
      autoRun: false,
    });
  });
});

describe("formatProposePlanQuestion", () => {
  it("includes objective + reasoning + default-mode label", () => {
    const q = formatProposePlanQuestion({
      objective: "refactor the auth pipeline",
      reasoning: "spans 6 files; user wants to review approach first",
      autoRun: true,
    });
    expect(q).toMatch(/refactor the auth pipeline/);
    expect(q).toMatch(/spans 6 files/);
    expect(q).toMatch(/auto-run/);
    expect(q).toMatch(/`confirm`/);
    expect(q).toMatch(/`confirm run`/);
    expect(q).toMatch(/`confirm seed-only`/);
    expect(q).toMatch(/`cancel`/);
  });

  it("when default is seed-only, the label reflects that", () => {
    const q = formatProposePlanQuestion({
      objective: "x",
      reasoning: "y",
      autoRun: false,
    });
    expect(q).toMatch(/seed only/i);
  });
});

describe("createProposePlanTool — end-to-end", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "propose-plan-"));
  });
  afterEach(async () => {
    try {
      await fs.rm(workspace, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  function makeTool(reply: string, opts?: { autoRunner?: (planId: string, objective: string) => void }) {
    const resolver: AskUserResolver = async () => reply;
    return createProposePlanTool({
      resolver,
      workspace,
      model: "copilot/gpt-5.5",
      autoRunner: opts?.autoRunner,
    });
  }

  it("on confirm: writes a Plan and returns structured payload", async () => {
    const tool = makeTool("confirm seed-only");
    const res = await tool.execute({
      objective: "refactor auth pipeline",
      reasoning: "spans 6 files",
    });
    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload).toMatchObject({
      ok: true,
      objective: "refactor auth pipeline",
      autoRun: false,
    });
    expect(typeof payload.planId).toBe("string");
    expect(payload.planId.length).toBeGreaterThan(0);

    // Plan record IS on disk.
    const store = new PlanStore({ workspace });
    const plans = await store.list();
    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe(payload.planId);
    expect(plans[0].objective).toBe("refactor auth pipeline");
    expect(plans[0].status).toBe("draft");
    expect(plans[0].modelHint).toBe("copilot/gpt-5.5");
  });

  it("on cancel: NO plan is written + content carries `cancelled: true`", async () => {
    const tool = makeTool("cancel");
    const res = await tool.execute({
      objective: "x",
      reasoning: "y",
    });
    expect(res.ok).toBe(false);
    const payload = JSON.parse(res.content);
    expect(payload).toMatchObject({ ok: false, cancelled: true });

    const store = new PlanStore({ workspace });
    const plans = await store.list();
    expect(plans).toHaveLength(0);
  });

  it("missing objective → ok=false, no plan written", async () => {
    const tool = makeTool("confirm");
    const res = await tool.execute({ reasoning: "y" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/objective/);
    const store = new PlanStore({ workspace });
    expect(await store.list()).toHaveLength(0);
  });

  it("missing reasoning → ok=false, no plan written", async () => {
    const tool = makeTool("confirm");
    const res = await tool.execute({ objective: "x" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/reasoning/);
  });

  it("on confirm with autoRunner: invokes autoRunner with planId + objective", async () => {
    const calls: Array<{ planId: string; objective: string }> = [];
    const tool = makeTool("confirm", {
      autoRunner: (planId, objective) => {
        calls.push({ planId, objective });
      },
    });
    const res = await tool.execute({
      objective: "draft the rewrite plan",
      reasoning: "user explicitly asked for an approach doc",
    });
    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.autoRun).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].planId).toBe(payload.planId);
    expect(calls[0].objective).toBe("draft the rewrite plan");
  });

  it("on confirm seed-only with autoRunner: does NOT invoke autoRunner", async () => {
    const calls: Array<{ planId: string; objective: string }> = [];
    const tool = makeTool("confirm seed-only", {
      autoRunner: (planId, objective) => {
        calls.push({ planId, objective });
      },
    });
    const res = await tool.execute({
      objective: "x",
      reasoning: "y",
    });
    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.autoRun).toBe(false);
    expect(calls).toHaveLength(0);

    // Plan IS still on disk in draft state.
    const store = new PlanStore({ workspace });
    expect(await store.list()).toHaveLength(1);
  });

  it("on cancel with autoRunner: does NOT invoke autoRunner", async () => {
    const calls: Array<{ planId: string; objective: string }> = [];
    const tool = makeTool("cancel", {
      autoRunner: (planId, objective) => {
        calls.push({ planId, objective });
      },
    });
    const res = await tool.execute({ objective: "x", reasoning: "y" });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("autoRunner throw does NOT propagate — plan stays seeded", async () => {
    const tool = makeTool("confirm run", {
      autoRunner: () => {
        throw new Error("runner host blew up");
      },
    });
    const res = await tool.execute({ objective: "x", reasoning: "y" });
    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.autoRun).toBe(true);
    const store = new PlanStore({ workspace });
    expect(await store.list()).toHaveLength(1);
  });

  it("autoRun defaults to true when args.autoRun is omitted", async () => {
    const calls: number[] = [];
    const tool = makeTool("confirm", {
      autoRunner: () => {
        calls.push(1);
      },
    });
    const res = await tool.execute({ objective: "x", reasoning: "y" });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content).autoRun).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("args.autoRun=false suppresses the runner unless user explicitly overrides", async () => {
    const calls: number[] = [];
    // Model says no auto-run; user just says `confirm` → default sticks.
    const tool1 = makeTool("confirm", {
      autoRunner: () => calls.push(1),
    });
    await tool1.execute({ objective: "x", reasoning: "y", autoRun: false });
    expect(calls).toHaveLength(0);

    // Model says no auto-run; user explicitly says `confirm run` → run.
    const tool2 = makeTool("confirm run", {
      autoRunner: () => calls.push(2),
    });
    await tool2.execute({ objective: "x", reasoning: "y", autoRun: false });
    expect(calls).toEqual([2]);
  });

  it("hint text changes based on effective autoRun", async () => {
    const r1 = await makeTool("confirm seed-only").execute({
      objective: "x",
      reasoning: "y",
    });
    expect(JSON.parse(r1.content).hint).toMatch(/draft/i);

    const r2 = await makeTool("confirm", {
      autoRunner: () => {},
    }).execute({ objective: "x", reasoning: "y" });
    expect(JSON.parse(r2.content).hint).toMatch(/kicked off in the background/i);
  });

  it("question text actually surfaces objective + reasoning + autoRun label", async () => {
    let captured = "";
    const tool = createProposePlanTool({
      resolver: async (q) => {
        captured = q;
        return "cancel";
      },
      workspace,
      model: "copilot/gpt-5.5",
    });
    await tool.execute({
      objective: "audit every Bar in repo",
      reasoning: "10 files",
      autoRun: false,
    });
    expect(captured).toMatch(/audit every Bar in repo/);
    expect(captured).toMatch(/10 files/);
    expect(captured).toMatch(/seed only/i);
  });
});
