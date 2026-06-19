/**
 * Subprocess subagent runtime — IPC protocol (v0.3 §16).
 *
 * The subprocess runtime forks a Node child process that hosts a runner
 * (`subagent-host.ts`) and communicates with the parent over the child's
 * stdin/stdout via newline-delimited JSON. This module defines the message
 * shapes and a tiny line-buffered splitter so partial chunks coming off the
 * stream don't corrupt parsing.
 *
 * Why JSON-over-stdio (not Node IPC)? `child_process.fork()` ships a built-in
 * `process.send()` / `'message'` channel, but it's only available when the
 * child was forked (not spawned) AND when the parent injected the IPC fd.
 * For deterministic test behavior — and so we can later swap to an `npx tsx`
 * spawn or a compiled-JS spawn without changing the protocol — we keep
 * everything on stdio.
 *
 * Lines must be exactly one JSON object terminated by a single `\n`. The
 * child reroutes any non-protocol stdout writes by setting up a shim
 * (`subagent-host.ts`); parents should treat unparseable lines as protocol
 * violations and surface them via stderr inspection.
 */

import type { SubagentResult } from "../types.js";

// ─── Message types ──────────────────────────────────────────────────────────

/** Parent → child messages. */
export type ParentToChild =
  | { kind: "init"; type: string; input: unknown; runId: string; workspace: string }
  | { kind: "abort" }
  | { kind: "rpc-result"; rpcId: string; ok: true; value: unknown }
  | { kind: "rpc-result"; rpcId: string; ok: false; error: string };

/** Child → parent messages. */
export type ChildToParent =
  | { kind: "ready" }
  | {
      kind: "rpc-call";
      rpcId: string;
      method: "llm.chat" | "llm.describe" | "scheduler.dispatch" | "writeArtifact";
      args: unknown;
    }
  | {
      kind: "rpc-stream";
      rpcId: string;
      done: false;
      chunk: unknown;
    }
  | {
      kind: "rpc-stream";
      rpcId: string;
      done: true;
    }
  | {
      kind: "result";
      status: SubagentResult["status"];
      summary: string;
      artifactPath: string | null;
      errorMessage?: string;
    }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string };

export type Message = ParentToChild | ChildToParent;

// ─── Encode / decode ────────────────────────────────────────────────────────

/** Encode a message as a single JSON line terminated by `\n`. */
export function encodeMessage(m: Message): string {
  return JSON.stringify(m) + "\n";
}

/** Decode a single line into a message. Throws on invalid JSON or non-object. */
export function decodeLine<T = Message>(line: string): T {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (trimmed.length === 0) {
    throw new Error("decodeLine: empty line");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`decodeLine: invalid JSON (${msg})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("decodeLine: expected a JSON object");
  }
  if (typeof (parsed as { kind?: unknown }).kind !== "string") {
    throw new Error("decodeLine: missing string `kind` field");
  }
  return parsed as T;
}

// ─── Line splitter ──────────────────────────────────────────────────────────

/**
 * LineSplitter buffers incoming chunks and emits complete `\n`-terminated
 * lines. Partial trailing data is held until the next chunk arrives.
 *
 * Usage:
 *   const splitter = new LineSplitter();
 *   stream.on("data", (chunk) => {
 *     for (const line of splitter.push(chunk)) handleLine(line);
 *   });
 */
export class LineSplitter {
  private buffer = "";

  /** Feed a chunk; return any complete lines (without trailing `\n`). */
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const out: string[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) out.push(line);
      idx = this.buffer.indexOf("\n");
    }
    return out;
  }

  /** Return any buffered partial line and clear the buffer. */
  flush(): string | null {
    if (this.buffer.length === 0) return null;
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }
}
