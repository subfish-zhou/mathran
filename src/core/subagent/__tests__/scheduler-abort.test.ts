import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { SubagentRegistry } from "../registry.js";
import { SubagentScheduler } from "../scheduler.js";
import type { SubagentRunner } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A runner that exposes the `ctx.signal` it was handed so the test can assert
 * the external abort was wired through to it (the cooperative-cancel contract).
 */
function signalCapturingRunner(): {
  runner: SubagentRunner;
  signal: () => AbortSignal | null;
} {
  let captured: AbortSignal | null = null;
  const runner: SubagentRunner = {
    type: "research",
    async run(_task, ctx) {
      captured = ctx.signal;
      for (let i = 0; i < 100; i++) {
        if (ctx.signal.aborted) {
          return { status: "error", summary: "", artifactPath: null, errorMessage: "aborted by runner" };
        }
        await sleep(10);
      }
      return { status: "ok", summary: "finished", artifactPath: null };
    },
  };
  return { runner, signal: () => captured };
}

describe("SubagentScheduler — external abort signal (#3)", () => {
  let workspace: string;
  let registry: SubagentRegistry;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-sched-abort-"));
    registry = new SubagentRegistry();
  });

  it("aborting the signal mid-run wires the abort through to the runner's ctx.signal and ends the dispatch", async () => {
    const { runner, signal } = signalCapturingRunner();
    registry.register(runner);
    const sched = new SubagentScheduler({ workspace, registry });
    const controller = new AbortController();
    const p = sched.dispatch({ type: "research", input: {} }, { signal: controller.signal });
    await sleep(25);
    controller.abort();
    const res = await p;
    // The runner received a signal and it reflects the external abort.
    expect(signal()).not.toBeNull();
    expect(signal()!.aborted).toBe(true);
    expect(res.status).toBe("error");
  });

  it("an already-aborted signal short-circuits immediately", async () => {
    // A runner that never resolves on its own — only the abort race can end it.
    registry.register({
      type: "research",
      async run() {
        await sleep(10_000);
        return { status: "ok", summary: "never", artifactPath: null };
      },
    });
    const sched = new SubagentScheduler({ workspace, registry });
    const controller = new AbortController();
    controller.abort();
    const res = await sched.dispatch(
      { type: "research", input: {} },
      { signal: controller.signal },
    );
    expect(res.status).toBe("error");
    expect(res.errorMessage).toMatch(/abort/i);
  });

  it("dispatch without a signal is unaffected (backward compatible)", async () => {
    registry.register({
      type: "search",
      async run() {
        return { status: "ok", summary: "hi", artifactPath: null };
      },
    });
    const sched = new SubagentScheduler({ workspace, registry });
    const res = await sched.dispatch({ type: "search", input: {} });
    expect(res.status).toBe("ok");
    expect(res.summary).toBe("hi");
  });
});
