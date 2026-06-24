/**
 * Files-changed extractor — NEW-F8.
 *
 * Mines a goal's `steps[]` audit log for file-write tool invocations
 * (write_file, edit_file, create_doc_page, create_wiki_page) and
 * returns a flat list of {path, tool, at, ok} entries — chronological
 * order, deduplicated to ONE entry per unique path (keeping the most
 * recent).
 *
 * Used by the new `GET /api/goals/:id/files-changed` endpoint and the
 * eventual SPA "Files changed" panel. Pure read; no mutation.
 *
 * Tools considered:
 *   - write_file        : full overwrite, `path` arg
 *   - edit_file         : in-place patch, `path` arg
 *   - create_doc_page   : new doc-page, `slug` arg (mapped to `docs/<slug>.md`)
 *   - create_wiki_page  : new wiki page, `slug` arg (mapped to `wiki/<slug>.md`)
 *   - delete_wiki_page  : delete, `slug` arg (kept for completeness, marked
 *                         with `op: "delete"`)
 *
 * Tools intentionally NOT considered (read-only or not file-touching):
 *   - read_file / list_efforts / list_projects / ask_user / mark_done / etc.
 *
 * Robustness: argsJson on a step is the JSON-stringified tool call args
 * as captured by ChatSession; missing/malformed JSON skipped silently
 * (we'd rather under-report than crash the endpoint).
 */

import type { Goal } from "./store.js";

export interface FileChangeEntry {
  /** Filesystem path or pseudo-path the tool targeted. */
  path: string;
  /** Which tool wrote/edited it. */
  tool: string;
  /** ISO timestamp of the LAST (most recent) write. */
  at: string;
  /** Operation kind. Distinguishes deletes from writes. */
  op: "write" | "edit" | "delete";
  /** True if the corresponding tool-result step indicated success. */
  ok: boolean;
  /** Count of write events against this path inside this goal. */
  writeCount: number;
}

interface ToolCallStep {
  at: string;
  kind: "tool-call";
  payload: { name?: string; argsJson?: string; toolCallId?: string };
}

interface ToolResultStep {
  at: string;
  kind: "tool-result";
  payload: { toolCallId?: string; ok?: boolean };
}

const FILE_WRITE_TOOLS: Record<string, "write" | "edit" | "delete"> = {
  write_file: "write",
  edit_file: "edit",
  create_doc_page: "write",
  create_wiki_page: "write",
  append_effort_document: "edit",
  delete_wiki_page: "delete",
};

/** Pull the file path (or pseudo-path) out of a parsed args record. */
function extractPath(toolName: string, args: Record<string, unknown>): string | null {
  // Most tools expose `path`. Wiki/doc tools use `slug` — synthesise a
  // pseudo-path so the UI has something to render.
  if (typeof args.path === "string") return args.path;
  if (typeof args.slug === "string") {
    if (toolName.includes("doc")) return `docs/${args.slug}.md`;
    if (toolName.includes("wiki")) return `wiki/${args.slug}.md`;
    return args.slug;
  }
  if (typeof args.filePath === "string") return args.filePath;
  return null;
}

export function extractFilesChanged(goal: Goal): FileChangeEntry[] {
  // Index tool-result steps by toolCallId so we can mark write-success
  // per call site. Default to ok=true when there's no matching result
  // (might still be in-flight, or the result step was discarded mid-
  // crash); the caller can re-render after the next poll.
  const resultByCallId = new Map<string, boolean>();
  for (const step of goal.steps) {
    if (step.kind === "tool-result") {
      const tr = step as ToolResultStep;
      const id = tr.payload?.toolCallId;
      if (typeof id === "string") {
        resultByCallId.set(id, tr.payload?.ok !== false);
      }
    }
  }
  // First pass: collect every write event in chronological order.
  type Raw = { path: string; tool: string; at: string; op: "write" | "edit" | "delete"; ok: boolean };
  const raw: Raw[] = [];
  for (const step of goal.steps) {
    if (step.kind !== "tool-call") continue;
    const tc = step as ToolCallStep;
    const name = tc.payload?.name;
    if (!name) continue;
    const opKind = FILE_WRITE_TOOLS[name];
    if (!opKind) continue;
    let args: Record<string, unknown> = {};
    try {
      args = tc.payload?.argsJson ? JSON.parse(tc.payload.argsJson) : {};
    } catch {
      // skip malformed
      continue;
    }
    const p = extractPath(name, args);
    if (!p) continue;
    const callId = tc.payload?.toolCallId;
    const ok = typeof callId === "string" ? (resultByCallId.get(callId) ?? true) : true;
    raw.push({ path: p, tool: name, at: tc.at, op: opKind, ok });
  }
  // Second pass: dedupe by path, keep the latest event, accumulate count.
  const byPath = new Map<string, FileChangeEntry>();
  for (const r of raw) {
    const existing = byPath.get(r.path);
    if (!existing) {
      byPath.set(r.path, {
        path: r.path,
        tool: r.tool,
        at: r.at,
        op: r.op,
        ok: r.ok,
        writeCount: 1,
      });
    } else {
      existing.writeCount += 1;
      existing.at = r.at;
      existing.tool = r.tool;
      existing.op = r.op;
      existing.ok = r.ok;
    }
  }
  // Newest first — handy for the SPA which usually wants the recent
  // changes at the top of the panel.
  return [...byPath.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}
