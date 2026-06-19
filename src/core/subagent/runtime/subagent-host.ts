/**
 * Subprocess subagent host (v0.3 §16) — child entry point.
 *
 * This file is run as a forked Node process by SubprocessRuntime. It reads
 * JSON-line protocol messages from stdin, executes the requested runner
 * against proxied LLM/scheduler objects, and writes protocol messages back
 * to stdout. NEVER import anything from cli/server/web here.
 *
 * Why isolation matters:
 *   - The runner code is unchanged from inline mode; we just give it
 *     proxied `llm` / `scheduler` objects whose methods do RPC over stdio.
 *   - Runner-internal `console.log()` would corrupt the IPC stream, so we
 *     reroute `process.stdout.write` to stderr for any non-protocol writes
 *     by exposing a single `send()` helper and replacing the stdout `write`
 *     method.
 */

import { defaultSubagentRegistry } from "../registry.js";
import type {
  SubagentContext,
  SubagentResult,
  SubagentTask,
  SubagentTaskType,
} from "../types.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";
import {
  decodeLine,
  encodeMessage,
  LineSplitter,
  type ChildToParent,
  type ParentToChild,
} from "./protocol.js";

// ─── Protocol IO ────────────────────────────────────────────────────────────

/**
 * Capture the original stdout writer, then replace `process.stdout.write` so
 * that any *non-protocol* call (e.g. a runner that does `console.log`) goes
 * to stderr instead of corrupting our IPC line stream. Only the local
 * `send()` helper writes to the real stdout.
 */
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realStderrWrite = process.stderr.write.bind(process.stderr);

function sendProtocol(m: ChildToParent): void {
  realStdoutWrite(encodeMessage(m));
}

function rerouteRunnerStdout(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    return realStderrWrite(
      chunk as never,
      encodingOrCb as never,
      callback as never,
    );
  };
}

// ─── RPC plumbing ───────────────────────────────────────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Optional chunk consumer for streaming RPCs. */
  onChunk?: (chunk: unknown) => void;
}

const pending = new Map<string, PendingRpc>();
let rpcCounter = 0;
function nextRpcId(): string {
  rpcCounter++;
  return `rpc-${rpcCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Single-shot RPC: parent computes a value and sends it back. */
function callRpc(
  method:
    | "llm.describe"
    | "scheduler.dispatch"
    | "writeArtifact",
  args: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const rpcId = nextRpcId();
    pending.set(rpcId, { resolve, reject });
    sendProtocol({ kind: "rpc-call", rpcId, method, args });
  });
}

/**
 * Streaming RPC: the parent invokes `llm.chat`, then streams back chunks via
 * `rpc-stream` messages until `done:true`. Returns an async iterable.
 *
 * If the RPC ultimately failed, the iterable rejects with the error.
 */
function callStreamingRpc(
  method: "llm.chat",
  args: unknown,
): AsyncIterable<LLMStreamChunk> {
  const queue: LLMStreamChunk[] = [];
  let done = false;
  let error: Error | null = null;
  let waiter: ((v?: unknown) => void) | null = null;

  function wake() {
    const w = waiter;
    waiter = null;
    if (w) w();
  }

  const rpcId = nextRpcId();
  pending.set(rpcId, {
    resolve: () => {
      done = true;
      wake();
    },
    reject: (e) => {
      error = e;
      done = true;
      wake();
    },
    onChunk: (chunk) => {
      queue.push(chunk as LLMStreamChunk);
      wake();
    },
  });
  sendProtocol({ kind: "rpc-call", rpcId, method, args });

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) {
          if (error) throw error;
          return;
        }
        await new Promise<void>((r) => {
          waiter = () => r();
        });
      }
    },
  };
}

// ─── Proxies ────────────────────────────────────────────────────────────────

function makeLlmProxy(): LLMProvider {
  return {
    async describe() {
      const v = await callRpc("llm.describe", {});
      return v as { name: string; defaultModel?: string };
    },
    async chat(req: LLMRequest): Promise<LLMResponse> {
      // Strip non-serializable bits before sending. AbortSignal etc.
      const safeReq = serializableRequest(req);
      const stream = callStreamingRpc("llm.chat", safeReq);
      return {
        stream() {
          return stream;
        },
      };
    },
    countTokens(messages: LLMMessage[]): number {
      // Synchronous & cheap: use a rough heuristic locally rather than a
      // round-trip RPC. Runners that need accurate counts should use
      // `llm.describe` / their own counter.
      let total = 0;
      for (const m of messages) {
        total += Math.ceil(((m.content ?? "").length || 0) / 4) + 4;
      }
      return total;
    },
  };
}

function serializableRequest(req: LLMRequest): LLMRequest {
  const copy: LLMRequest = {
    messages: req.messages,
    model: req.model,
  };
  if (req.temperature !== undefined) copy.temperature = req.temperature;
  if (req.maxTokens !== undefined) copy.maxTokens = req.maxTokens;
  if (req.tools !== undefined) copy.tools = req.tools;
  if (req.extra !== undefined) copy.extra = req.extra;
  // signal is intentionally dropped — we can't serialize an AbortSignal.
  return copy;
}

interface SchedulerProxy {
  dispatch(task: SubagentTask): Promise<SubagentResult>;
}

function makeSchedulerProxy(): SchedulerProxy {
  return {
    async dispatch(task: SubagentTask): Promise<SubagentResult> {
      const v = await callRpc("scheduler.dispatch", task);
      return v as SubagentResult;
    },
  };
}

// ─── Run context ────────────────────────────────────────────────────────────

interface ChildContextHandle {
  ctx: SubagentContext;
  controller: AbortController;
}

function makeChildContext(runId: string, workspace: string): ChildContextHandle {
  const controller = new AbortController();
  const ctx: SubagentContext = {
    workspace,
    runId,
    signal: controller.signal,
    async writeArtifact(name: string, content: string | Buffer): Promise<string> {
      const argsContent =
        typeof content === "string"
          ? { encoding: "utf8" as const, data: content }
          : { encoding: "base64" as const, data: content.toString("base64") };
      const v = await callRpc("writeArtifact", {
        runId,
        name,
        ...argsContent,
      });
      return v as string;
    },
  };
  return { ctx, controller };
}

// ─── Main loop ──────────────────────────────────────────────────────────────

let activeContext: ChildContextHandle | null = null;
let resultSent = false;

function exitWithResult(
  res: Omit<SubagentResult, "runId" | "type" | "stats">,
): void {
  if (resultSent) return;
  resultSent = true;
  const msg: ChildToParent = {
    kind: "result",
    status: res.status,
    summary: res.summary ?? "",
    artifactPath: res.artifactPath ?? null,
  };
  if (res.errorMessage !== undefined) msg.errorMessage = res.errorMessage;
  sendProtocol(msg);
  // Allow stdout to flush before exiting.
  setImmediate(() => process.exit(0));
}

function handleParentMessage(msg: ParentToChild): void {
  switch (msg.kind) {
    case "init": {
      runInit(msg).catch((err) => {
        const m = err instanceof Error ? err.message : String(err);
        exitWithResult({
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: `host: uncaught: ${m}`,
        });
      });
      return;
    }
    case "abort": {
      activeContext?.controller.abort();
      // Give the runner a tiny window to wrap up; if it already finished
      // (resultSent=true) we'll exit naturally.
      setTimeout(() => {
        if (!resultSent) {
          exitWithResult({
            status: "error",
            summary: "",
            artifactPath: null,
            errorMessage: "aborted",
          });
        }
      }, 50);
      return;
    }
    case "rpc-result": {
      const p = pending.get(msg.rpcId);
      if (!p) return; // unknown rpcId — ignore
      pending.delete(msg.rpcId);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
      return;
    }
    default: {
      // Forward-compat: unknown messages are ignored.
      return;
    }
  }
}

/**
 * `rpc-stream` is conceptually a `rpc-result` carried in chunks. We define it
 * as a separate ParentToChild message; if a parent ever sends one, route it
 * to the matching streaming RPC handler.
 */
function handleStreamingChunk(msg: {
  kind: "rpc-stream";
  rpcId: string;
  done: boolean;
  chunk?: unknown;
  error?: string;
}): void {
  const p = pending.get(msg.rpcId);
  if (!p) return;
  if (msg.done) {
    pending.delete(msg.rpcId);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(undefined);
    return;
  }
  if (p.onChunk) p.onChunk(msg.chunk);
}

async function runInit(msg: {
  kind: "init";
  type: string;
  input: unknown;
  runId: string;
  workspace?: string;
}): Promise<void> {
  const registry = defaultSubagentRegistry();
  const knownTypes = registry.list();
  if (!knownTypes.includes(msg.type as SubagentTaskType)) {
    exitWithResult({
      status: "error",
      summary: "",
      artifactPath: null,
      errorMessage: `unknown runner type: ${msg.type}`,
    });
    return;
  }
  const runner = registry.get(msg.type as SubagentTaskType)!;

  const workspace =
    msg.workspace ?? process.env.MATHRAN_WORKSPACE ?? process.cwd();
  const handle = makeChildContext(msg.runId, workspace);
  activeContext = handle;

  // Build proxied input. Runners look at `input.llm` and `input.scheduler`
  // (or specialized field names) — we inject our proxies onto a shallow copy
  // of the raw input so existing runner code sees the right shape.
  const baseInput =
    msg.input && typeof msg.input === "object"
      ? { ...(msg.input as Record<string, unknown>) }
      : {};
  baseInput.llm = makeLlmProxy();
  baseInput.scheduler = makeSchedulerProxy();

  const task: SubagentTask = {
    type: msg.type as SubagentTaskType,
    input: baseInput as Record<string, unknown>,
  };

  try {
    const partial = await runner.run(task, handle.ctx);
    exitWithResult(partial);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    exitWithResult({
      status: "error",
      summary: "",
      artifactPath: null,
      errorMessage: m,
    });
  }
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

function main(): void {
  rerouteRunnerStdout();

  const splitter = new LineSplitter();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    for (const line of splitter.push(chunk)) {
      try {
        // Parent can send either ParentToChild OR rpc-stream (which is the
        // streaming form of rpc-result). We sniff `kind` and dispatch.
        const parsed = JSON.parse(line) as { kind: string };
        if (parsed.kind === "rpc-stream") {
          handleStreamingChunk(parsed as never);
          continue;
        }
        const m = decodeLine<ParentToChild>(line);
        handleParentMessage(m);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        sendProtocol({
          kind: "log",
          level: "error",
          message: `parse error: ${m}`,
        });
      }
    }
  });

  process.stdin.on("end", () => {
    if (!resultSent) {
      exitWithResult({
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "stdin closed before result",
      });
    }
  });

  // Tell parent we're ready to receive `init`.
  sendProtocol({ kind: "ready" });
}

main();
