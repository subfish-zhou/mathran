/**
 * Built-in `todo_write` tool (v0.17 mathub parity W12).
 *
 * Lightweight "in-conversation TODO list" — the LLM keeps a short, ordered
 * list of steps for the current turn and updates statuses (`pending` →
 * `in_progress` → `done`) as it works. Inspired by Cursor's `update_plan`
 * and Claude Code's `TodoWrite`: the goal is *visible structure*, not
 * heavyweight project management. The user sees the plan unfold in real
 * time in the right rail; the assistant uses the list to stay on-track
 * across a long round / multi-tool turn.
 *
 * Surface:
 *   - One JSON file per conversation: `<scopeDir>/<conversationId>.todos.json`
 *   - Atomic-write-on-mutate so a crash mid-tool-call can't corrupt the file
 *   - Tool result is a short human-readable summary ("3 todos · 1 done, 1 in_progress, 1 pending")
 *   - The SSE pump in `serve.ts` detects a successful `todo_write` tool result
 *     and emits a `todos` SSE event with the freshly loaded list, so the SPA
 *     can re-render the panel without a separate GET.
 *
 * Design notes:
 *   - Pure persistence: this tool doesn't yield ChatEvents itself (ChatSession
 *     can't yield events from inside a tool). The host SSE layer reads the
 *     disk file after each successful call and pushes a `todos` frame —
 *     achieving the same UX as Cursor's plan-tool without coupling to
 *     ChatSession internals.
 *   - Per-conversation, not per-scope: each thread has its own TODO list.
 *     Switching threads in the SPA loads the list via `GET <chatBase>/:id/todos`.
 *   - `replace: true` swaps the whole list; otherwise items are merged by `id`
 *     (preserving existing entries that aren't in the patch). This matches
 *     how the LLM tends to think — "add a new step" vs "rewrite the plan".
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolSpec } from "../session.js";
import { scopeDir, withFileLock, type ChatScope } from "../store.js";
import { atomicWriteFile } from "../atomic-write.js";

/** Status values the model is allowed to emit. Keep this list short — Cursor
 *  / Claude-Code both use exactly four states and the SPA renders an icon
 *  per state. */
export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

/** One TODO item. `id` is server-assigned on first write so the model can
 *  refer to it by id on later calls. */
export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  /** ISO-8601 timestamp of when the item was first added. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent status / text mutation. */
  updatedAt: string;
}

/** Whole-conversation TODO list. `version` lets us bump the schema later
 *  without breaking on-disk files. */
export interface TodoList {
  version: 1;
  items: TodoItem[];
  /** Last mutation time, for the SPA to show "Updated 12s ago" if needed. */
  updatedAt: string;
}

const STATUS_VALUES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "done",
  "cancelled",
];

/** Build the on-disk path for a conversation's TODO list. */
function todosFile(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
): string {
  return path.join(scopeDir(workspace, scope), `${conversationId}.todos.json`);
}

/** Load the persisted TODO list, or return an empty list if none exists. */
export async function loadTodos(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
): Promise<TodoList> {
  try {
    const raw = await fs.readFile(
      todosFile(workspace, scope, conversationId),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as Partial<TodoList>;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      Array.isArray(parsed.items)
    ) {
      // Re-coerce each item to defend against hand-edited files.
      const items: TodoItem[] = [];
      for (const it of parsed.items) {
        if (!it || typeof it !== "object") continue;
        const id =
          typeof (it as TodoItem).id === "string" && (it as TodoItem).id
            ? (it as TodoItem).id
            : randomUUID();
        const text =
          typeof (it as TodoItem).text === "string" ? (it as TodoItem).text : "";
        if (!text) continue;
        const status: TodoStatus = STATUS_VALUES.includes(
          (it as TodoItem).status as TodoStatus,
        )
          ? ((it as TodoItem).status as TodoStatus)
          : "pending";
        const createdAt =
          typeof (it as TodoItem).createdAt === "string"
            ? (it as TodoItem).createdAt
            : new Date().toISOString();
        const updatedAt =
          typeof (it as TodoItem).updatedAt === "string"
            ? (it as TodoItem).updatedAt
            : createdAt;
        items.push({ id, text, status, createdAt, updatedAt });
      }
      return {
        version: 1,
        items,
        updatedAt:
          typeof parsed.updatedAt === "string"
            ? parsed.updatedAt
            : new Date().toISOString(),
      };
    }
  } catch {
    /* missing or unparseable → empty list */
  }
  return emptyTodoList();
}

function emptyTodoList(): TodoList {
  return { version: 1, items: [], updatedAt: new Date().toISOString() };
}

/** Persist a TODO list atomically. Creates the parent directory if needed. */
export async function saveTodos(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
  list: TodoList,
): Promise<void> {
  const file = todosFile(workspace, scope, conversationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify(list, null, 2));
}

/** Tool-call input shape (validated leniently — the model can omit `id` on
 *  brand-new items, and omit `status` for `pending`). */
interface TodoWriteArgs {
  /** When true, the patch *replaces* the entire list. When false/omitted,
   *  items are merged by `id` — existing items not in the patch are kept. */
  replace?: boolean;
  /** The patch. Each item may carry an `id` (for updates) or omit it (for
   *  brand-new entries). */
  items: Array<{
    id?: string;
    text?: string;
    status?: string;
  }>;
}

/** Produce a one-line summary the LLM sees as the tool result. */
function summarize(list: TodoList): string {
  if (list.items.length === 0) return "todo list is empty";
  const counts: Record<TodoStatus, number> = {
    pending: 0,
    in_progress: 0,
    done: 0,
    cancelled: 0,
  };
  for (const it of list.items) counts[it.status] += 1;
  const parts: string[] = [];
  if (counts.done) parts.push(`${counts.done} done`);
  if (counts.in_progress) parts.push(`${counts.in_progress} in_progress`);
  if (counts.pending) parts.push(`${counts.pending} pending`);
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
  return `${list.items.length} todos · ${parts.join(", ")}`;
}

/**
 * Render the current TODO list as a short markdown reminder that
 * `ChatSession` injects as a transient system message before every LLM
 * request. This is the fix for the 2026-06-30 plan-tracker bug where the
 * model wrote a plan once and then forgot to update statuses because no
 * subsequent context contained the plan's live state.
 *
 * Returns `null` when there's nothing useful to inject:
 *   - list is empty (the model never called `todo_write` this conversation)
 *   - every item is `done` or `cancelled` (plan is finished — no reminder
 *     needed, and showing a wall of ✓✓✓✓ would just waste tokens)
 *
 * Otherwise returns a compact reminder of the form:
 *
 *   Current TODO list (3 items · 1 in_progress, 1 pending, 1 done):
 *     [done]        Locate occurrences of normal generalized cone
 *     [in_progress] Fetch arXiv LaTeX source
 *     [pending]     Extract definition / theorem context
 *
 *   Reminder: before your next action, call `todo_write` to mark the
 *   in_progress item `done` (or `cancelled`) and the next item
 *   `in_progress`. Keep at most ONE item in_progress at a time. When
 *   every item is done, you don't need to mention the plan further.
 *
 * The wording is deliberately imperative ("call todo_write…") so the
 * model has a concrete instruction rather than a passive observation.
 */
export function renderTodoSnapshot(list: TodoList | null): string | null {
  if (!list || list.items.length === 0) return null;
  const live = list.items.filter(
    (it) => it.status === "pending" || it.status === "in_progress",
  );
  if (live.length === 0) return null;

  const counts: Record<TodoStatus, number> = {
    pending: 0,
    in_progress: 0,
    done: 0,
    cancelled: 0,
  };
  for (const it of list.items) counts[it.status] += 1;
  const countParts: string[] = [];
  if (counts.in_progress) countParts.push(`${counts.in_progress} in_progress`);
  if (counts.pending) countParts.push(`${counts.pending} pending`);
  if (counts.done) countParts.push(`${counts.done} done`);
  if (counts.cancelled) countParts.push(`${counts.cancelled} cancelled`);
  const header = `Current TODO list (${list.items.length} items · ${countParts.join(", ")}):`;

  // Right-pad the status tag so the text aligns visually in the prompt.
  const tagWidth = Math.max(
    ...list.items.map((it) => it.status.length),
  );
  const lines = list.items.map((it) => {
    const tag = `[${it.status}]`.padEnd(tagWidth + 2);
    // Truncate very long item text so the reminder stays compact.
    const text = it.text.length > 120 ? `${it.text.slice(0, 117)}…` : it.text;
    return `  ${tag} ${text}`;
  });

  const trailer =
    "Reminder: before your next action, call `todo_write` to update " +
    "statuses (pending → in_progress → done, or cancelled if scrapped). " +
    "Keep at most ONE item in_progress at a time. Skip this reminder " +
    "once every item is done.";

  return [header, ...lines, "", trailer].join("\n");
}

/** Coerce a raw status string to a `TodoStatus`, defaulting to `pending` on
 *  anything we don't recognise. */
function coerceStatus(raw: unknown): TodoStatus {
  if (typeof raw !== "string") return "pending";
  return STATUS_VALUES.includes(raw as TodoStatus)
    ? (raw as TodoStatus)
    : "pending";
}

/**
 * Apply a `todo_write` patch to the current list. Pure (no I/O) so we can
 * unit-test it directly without the tool wrapper.
 *
 * Merge semantics:
 *   - `replace: true` → list.items := patch.items (new ids minted as needed)
 *   - default → patch items with a matching id update text/status; patch
 *     items without an id (or with an unknown id) are appended.
 *
 * Edge cases:
 *   - patch item with empty `text` AND missing/unknown `id` → skipped
 *   - patch item that updates text to empty string → skipped (defensive;
 *     deleting via empty text is a footgun, the model should mark it
 *     `cancelled` instead)
 */
export function applyTodoPatch(prev: TodoList, args: TodoWriteArgs): TodoList {
  const now = new Date().toISOString();
  const patch = Array.isArray(args.items) ? args.items : [];

  if (args.replace) {
    const items: TodoItem[] = [];
    for (const raw of patch) {
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      if (!text) continue;
      const id =
        typeof raw.id === "string" && raw.id.trim() ? raw.id : randomUUID();
      items.push({
        id,
        text,
        status: coerceStatus(raw.status),
        createdAt: now,
        updatedAt: now,
      });
    }
    return { version: 1, items, updatedAt: now };
  }

  // Merge mode: index existing items by id, apply patch, append new ones.
  const byId = new Map<string, TodoItem>();
  for (const it of prev.items) byId.set(it.id, { ...it });
  const order: string[] = prev.items.map((it) => it.id);

  for (const raw of patch) {
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : null;
    if (id && byId.has(id)) {
      const cur = byId.get(id)!;
      const text =
        typeof raw.text === "string" && raw.text.trim() ? raw.text.trim() : cur.text;
      const status = raw.status !== undefined ? coerceStatus(raw.status) : cur.status;
      // Only stamp updatedAt if something actually changed.
      const changed = text !== cur.text || status !== cur.status;
      byId.set(id, {
        ...cur,
        text,
        status,
        updatedAt: changed ? now : cur.updatedAt,
      });
    } else {
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      if (!text) continue;
      const newId = id ?? randomUUID();
      byId.set(newId, {
        id: newId,
        text,
        status: coerceStatus(raw.status),
        createdAt: now,
        updatedAt: now,
      });
      order.push(newId);
    }
  }

  const items: TodoItem[] = order
    .filter((id) => byId.has(id))
    .map((id) => byId.get(id)!);
  return { version: 1, items, updatedAt: now };
}

/** Options for `createTodoWriteTool`. */
export interface CreateTodoWriteToolOptions {
  workspace: string;
  scope: ChatScope;
  conversationId: string;
}

const DEFAULT_DESCRIPTION =
  "Maintain a short, ordered TODO list for the current task so the user " +
  "can see your plan unfold in real time. Use it when the task has " +
  "MULTIPLE steps (4+) or non-trivial structure — single-shot edits / " +
  "answers DON'T need it. Each call may add new items, update existing " +
  "items' status (pending → in_progress → done / cancelled), or " +
  "(with replace=true) swap the entire list. Keep items short (one line) " +
  "and concrete. Update statuses as you work: mark an item in_progress " +
  "when you start it, done when finished. Avoid more than ONE in_progress " +
  "item at a time.";

/**
 * Build the `todo_write` tool spec, bound to a specific conversation.
 *
 * The factory closes over `(workspace, scope, conversationId)` so each
 * cached `ChatSession` gets its own tool instance writing to the right
 * file. The host SSE layer reads from the same path after each successful
 * call and emits a `todos` event so the SPA can re-render.
 */
export function createTodoWriteTool(opts: CreateTodoWriteToolOptions): ToolSpec {
  const { workspace, scope, conversationId } = opts;
  return {
    name: "todo_write",
    riskClass: "write",
    readOnly: false,
    description: DEFAULT_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        replace: {
          type: "boolean",
          description:
            "When true, the entire list is replaced with the items array. " +
            "When false / omitted, items are merged by id — existing items " +
            "not in the patch are preserved.",
        },
        items: {
          type: "array",
          description:
            "The patch. Each item may carry an existing `id` (to update) " +
            "or omit it (to append a new TODO). Items with empty `text` " +
            "and no matching id are skipped.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Stable id of an existing item to update. Omit for new items.",
              },
              text: {
                type: "string",
                description:
                  "Short one-line description of the step. Required for new items.",
              },
              status: {
                type: "string",
                enum: STATUS_VALUES as unknown as string[],
                description:
                  "Status of the item. Defaults to 'pending' for new items.",
              },
            },
          },
        },
      },
      required: ["items"],
    },
    async execute(
      args: Record<string, unknown>,
    ): Promise<{ ok: boolean; content: string }> {
      try {
        const typed: TodoWriteArgs = {
          replace: typeof args.replace === "boolean" ? args.replace : false,
          items: Array.isArray(args.items)
            ? (args.items as TodoWriteArgs["items"])
            : [],
        };
        if (!Array.isArray(typed.items) || typed.items.length === 0) {
          // Empty patch is a no-op; the LLM probably miswired the call.
          // Returning ok:false so the model sees it as an error and can
          // recover instead of hammering the same call again.
          return {
            ok: false,
            content: "error: todo_write requires a non-empty 'items' array",
          };
        }
        // 2026-06-25 audit G9 — same per-file lock as annotations / index
        // / checkpoint store. A model that batches two todo_write calls in
        // parallel (or two concurrent SPA reruns) would otherwise have
        // both load → patch → save and the second writer would clobber the
        // first.
        const file = todosFile(workspace, scope, conversationId);
        const next = await withFileLock(file, async () => {
          const prev = await loadTodos(workspace, scope, conversationId);
          const n = applyTodoPatch(prev, typed);
          await saveTodos(workspace, scope, conversationId, n);
          return n;
        });
        return { ok: true, content: summarize(next) };
      } catch (err: any) {
        const msg = err && err.message ? String(err.message) : String(err);
        return { ok: false, content: `error: ${msg}` };
      }
    },
  };
}
