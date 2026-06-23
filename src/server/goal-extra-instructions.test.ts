/**
 * goal-defaults-timer (part 3/3): POST /api/goals must accept an
 * optional `extraInstructions` body field, trim it, and persist it on
 * the resulting Goal record.
 *
 * We intentionally avoid the SSE pipeline here — the runner-side use of
 * `extraInstructions` (system-prompt splice) is covered in
 * runner.test.ts. This test pins ONLY the HTTP contract:
 *
 *   - string  -> persisted verbatim (with surrounding whitespace kept,
 *                 only the empty-check is trimmed)
 *   - empty/  -> field omitted on the goal record
 *     whitespace
 *   - missing -> field omitted on the goal record
 *   - wrong   -> ignored (no 400)
 *     type
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { startServer } from "./serve.js";

let workspace: string;
let server: { url: string; close: () => Promise<void> };
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "mathran-goal-extra-"),
  );
  // We DO NOT inject a fake LLM here — POST /api/goals only writes the
  // Goal record on disk, it never reaches the provider. That's exactly
  // what we want to keep the test focused.
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function createGoalReq(body: unknown): Promise<{ status: number; goal: any }> {
  const res = await fetch(`${base}/api/goals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, goal: json.goal };
}

describe("POST /api/goals — extraInstructions plumbing", () => {
  it("persists extraInstructions when a non-empty string is provided", async () => {
    const { status, goal } = await createGoalReq({
      objective: "test extraInstructions persistence",
      extraInstructions: "Respond only in haiku.",
    });
    expect(status).toBe(201);
    expect(goal.extraInstructions).toBe("Respond only in haiku.");
  });

  it("omits extraInstructions when the body field is empty/whitespace", async () => {
    const { status: s1, goal: g1 } = await createGoalReq({
      objective: "blank extraInstructions",
      extraInstructions: "",
    });
    expect(s1).toBe(201);
    expect(g1.extraInstructions).toBeUndefined();

    const { status: s2, goal: g2 } = await createGoalReq({
      objective: "whitespace extraInstructions",
      extraInstructions: "   \n  \t",
    });
    expect(s2).toBe(201);
    expect(g2.extraInstructions).toBeUndefined();
  });

  it("omits extraInstructions when the body field is missing", async () => {
    const { status, goal } = await createGoalReq({
      objective: "missing extraInstructions",
    });
    expect(status).toBe(201);
    expect(goal.extraInstructions).toBeUndefined();
  });

  it("ignores extraInstructions of the wrong type (no 400)", async () => {
    // Future-friendly: a client that sends a structured hint we don't
    // yet understand should still get its goal created (with the field
    // simply dropped), not a hard 400.
    const { status, goal } = await createGoalReq({
      objective: "wrong-type extraInstructions",
      extraInstructions: { hint: "no" },
    });
    expect(status).toBe(201);
    expect(goal.extraInstructions).toBeUndefined();
  });
});
