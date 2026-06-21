/**
 * Tests for the `todo_write` built-in tool (v0.17 mathub parity W12).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createTodoWriteTool,
  loadTodos,
  saveTodos,
  applyTodoPatch,
  type TodoList,
} from "./todo-write.js";
import type { ChatScope } from "../store.js";

async function makeTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "todo-write-test-"));
}

const GLOBAL_SCOPE: ChatScope = { kind: "global" };

describe("applyTodoPatch (pure)", () => {
  function empty(): TodoList {
    return { version: 1, items: [], updatedAt: new Date(0).toISOString() };
  }

  it("appends new items when prev is empty and not replacing", () => {
    const next = applyTodoPatch(empty(), {
      items: [
        { text: "read brief" },
        { text: "draft tool", status: "in_progress" },
      ],
    });
    expect(next.items).toHaveLength(2);
    expect(next.items[0].text).toBe("read brief");
    expect(next.items[0].status).toBe("pending");
    expect(next.items[1].status).toBe("in_progress");
    // Each item gets a unique server-assigned id.
    expect(next.items[0].id).not.toBe(next.items[1].id);
    expect(next.items[0].id.length).toBeGreaterThan(0);
  });

  it("updates status of an existing item by id without losing other items", () => {
    const seeded = applyTodoPatch(empty(), {
      items: [{ text: "step 1" }, { text: "step 2" }, { text: "step 3" }],
    });
    const step2 = seeded.items[1];
    const next = applyTodoPatch(seeded, {
      items: [{ id: step2.id, status: "done" }],
    });
    expect(next.items).toHaveLength(3);
    const found = next.items.find((it) => it.id === step2.id)!;
    expect(found.text).toBe("step 2"); // text preserved
    expect(found.status).toBe("done"); // status mutated
    // Other items untouched.
    expect(next.items[0].status).toBe("pending");
    expect(next.items[2].status).toBe("pending");
  });

  it("replaces the whole list when replace=true", () => {
    const seeded = applyTodoPatch(empty(), {
      items: [{ text: "old A" }, { text: "old B" }],
    });
    const next = applyTodoPatch(seeded, {
      replace: true,
      items: [{ text: "new only", status: "done" }],
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0].text).toBe("new only");
    expect(next.items[0].status).toBe("done");
  });

  it("skips empty-text patches with no matching id (defensive)", () => {
    const seeded = applyTodoPatch(empty(), {
      items: [{ text: "keep me" }],
    });
    const next = applyTodoPatch(seeded, {
      items: [{ text: "" }, { id: "nonexistent", status: "done" }, { text: "  " }],
    });
    // The "  " and "" entries skipped. The id="nonexistent" entry is an
    // implicit new item with empty text → also skipped.
    expect(next.items).toHaveLength(1);
    expect(next.items[0].text).toBe("keep me");
  });

  it("coerces unknown status strings to 'pending'", () => {
    const next = applyTodoPatch(empty(), {
      items: [{ text: "x", status: "not-a-real-status" as unknown as string }],
    });
    expect(next.items[0].status).toBe("pending");
  });

  it("preserves order of pre-existing items + appends new ones in patch order", () => {
    const seeded = applyTodoPatch(empty(), {
      items: [{ text: "A" }, { text: "B" }],
    });
    const aId = seeded.items[0].id;
    const next = applyTodoPatch(seeded, {
      items: [{ id: aId, status: "done" }, { text: "C" }, { text: "D" }],
    });
    expect(next.items.map((it) => it.text)).toEqual(["A", "B", "C", "D"]);
    expect(next.items[0].status).toBe("done");
  });
});

describe("loadTodos / saveTodos (round-trip)", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await makeTempWorkspace();
  });

  it("returns an empty list when nothing on disk", async () => {
    const list = await loadTodos(workspace, GLOBAL_SCOPE, "conv-1");
    expect(list.version).toBe(1);
    expect(list.items).toEqual([]);
  });

  it("persists and reloads identically", async () => {
    const seeded = applyTodoPatch(
      { version: 1, items: [], updatedAt: "" },
      { items: [{ text: "alpha" }, { text: "beta", status: "in_progress" }] },
    );
    await saveTodos(workspace, GLOBAL_SCOPE, "conv-1", seeded);
    const loaded = await loadTodos(workspace, GLOBAL_SCOPE, "conv-1");
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items[0].text).toBe("alpha");
    expect(loaded.items[1].status).toBe("in_progress");
  });

  it("recovers from a hand-edited file with missing/garbage fields", async () => {
    const dir = path.join(workspace, ".mathran", "global-chat");
    await fs.mkdir(dir, { recursive: true });
    const broken = {
      version: 1,
      items: [
        { text: "ok-1" },
        null,
        "not-an-object",
        { text: "ok-2", status: "weird-status" },
        { text: "" }, // empty text → dropped
      ],
      updatedAt: "not-an-iso",
    };
    await fs.writeFile(
      path.join(dir, "conv-x.todos.json"),
      JSON.stringify(broken),
      "utf-8",
    );
    const loaded = await loadTodos(workspace, GLOBAL_SCOPE, "conv-x");
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items[0].text).toBe("ok-1");
    expect(loaded.items[1].text).toBe("ok-2");
    expect(loaded.items[1].status).toBe("pending"); // coerced
  });
});

describe("createTodoWriteTool (integration)", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await makeTempWorkspace();
  });

  it("returns ok:false when items is missing or empty", async () => {
    const tool = createTodoWriteTool({
      workspace,
      scope: GLOBAL_SCOPE,
      conversationId: "conv-empty",
    });
    const r1 = await tool.execute({ items: [] });
    expect(r1.ok).toBe(false);
    expect(r1.content).toMatch(/non-empty 'items' array/);
    const r2 = await tool.execute({});
    expect(r2.ok).toBe(false);
  });

  it("writes new items and returns a summary", async () => {
    const tool = createTodoWriteTool({
      workspace,
      scope: GLOBAL_SCOPE,
      conversationId: "conv-1",
    });
    const r = await tool.execute({
      items: [
        { text: "load brief" },
        { text: "draft tool", status: "in_progress" },
        { text: "wire UI" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/3 todos/);
    expect(r.content).toMatch(/in_progress/);
    expect(r.content).toMatch(/pending/);

    const onDisk = await loadTodos(workspace, GLOBAL_SCOPE, "conv-1");
    expect(onDisk.items).toHaveLength(3);
    expect(onDisk.items[0].text).toBe("load brief");
  });

  it("updates an existing item by id across two calls", async () => {
    const tool = createTodoWriteTool({
      workspace,
      scope: GLOBAL_SCOPE,
      conversationId: "conv-2",
    });
    await tool.execute({ items: [{ text: "step A" }] });
    const seeded = await loadTodos(workspace, GLOBAL_SCOPE, "conv-2");
    const aId = seeded.items[0].id;

    await tool.execute({ items: [{ id: aId, status: "done" }] });
    const after = await loadTodos(workspace, GLOBAL_SCOPE, "conv-2");
    expect(after.items[0].id).toBe(aId);
    expect(after.items[0].status).toBe("done");
    expect(after.items[0].text).toBe("step A");
  });

  it("isolates lists across conversations", async () => {
    const t1 = createTodoWriteTool({
      workspace,
      scope: GLOBAL_SCOPE,
      conversationId: "conv-X",
    });
    const t2 = createTodoWriteTool({
      workspace,
      scope: GLOBAL_SCOPE,
      conversationId: "conv-Y",
    });
    await t1.execute({ items: [{ text: "only in X" }] });
    await t2.execute({ items: [{ text: "only in Y" }] });
    const x = await loadTodos(workspace, GLOBAL_SCOPE, "conv-X");
    const y = await loadTodos(workspace, GLOBAL_SCOPE, "conv-Y");
    expect(x.items.map((it) => it.text)).toEqual(["only in X"]);
    expect(y.items.map((it) => it.text)).toEqual(["only in Y"]);
  });

  it("survives an effort scope path with nested project/effort dirs", async () => {
    const effortScope: ChatScope = {
      kind: "effort",
      projectSlug: "math101",
      effortSlug: "warmup",
    };
    const tool = createTodoWriteTool({
      workspace,
      scope: effortScope,
      conversationId: "conv-eff",
    });
    const r = await tool.execute({ items: [{ text: "inside effort" }] });
    expect(r.ok).toBe(true);
    const onDisk = await loadTodos(workspace, effortScope, "conv-eff");
    expect(onDisk.items).toHaveLength(1);
  });
});
