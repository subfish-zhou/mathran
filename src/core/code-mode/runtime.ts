/**
 * Code mode v1 — VM lifecycle.
 *
 * One function: {@link runScript}. It owns the entire "spawn → bind → eval →
 * dispose" cycle for a single code-mode invocation. The VM is intentionally
 * short-lived (one script per VM) so we never have to worry about state
 * leaking between LLM calls — easier reasoning > a few ms of spawn cost.
 *
 * Architecture
 * ------------
 *   1. `newQuickJSAsyncWASMModule(RELEASE_ASYNC)` builds a fresh WebAssembly
 *      module so this run is isolated from every other code-mode call in the
 *      process. (We cache the module instance because the WASM compile is
 *      ~100 ms — see {@link getAsyncModule}.) Per-call isolation is provided
 *      by a fresh `runtime` inside the shared module, which has its own JS
 *      heap and bytecode interpreter state.
 *   2. The module's `newRuntime()` gives us a JS heap to attach limits to.
 *   3. We set `memoryLimit`, `maxStackSize`, and the deadline interrupt
 *      handler (see {@link makeDeadlineInterruptHandler}).
 *   4. `runtime.newContext()` produces the script context we install tools
 *      into via {@link bindToolsIntoContext}.
 *   5. We wrap the user's script in `(async () => { ... })()` so they can
 *      use top-level `await` — Codex's code mode does the same. The return
 *      value of that arrow is what we hand back to the caller.
 *   6. `context.evalCodeAsync` runs the wrapped script and returns a handle.
 *      Because the wrapper is async, the handle is a *Promise inside the VM*,
 *      not a host Promise. We pump pending jobs until the promise settles
 *      (see {@link drainAndResolve}) — quickjs-emscripten's `resolvePromise`
 *      can deadlock here because the awaited host function's continuation
 *      lives on the VM microtask queue and only runs on `executePendingJobs`.
 *   7. We `JSON.stringify` the result (with a `BigInt`-safe replacer) so
 *      it survives the VM boundary.
 *   8. Disposal is in reverse order with try/catch: bound function handles
 *      → context → runtime. QuickJS asserts heap-empty on dispose, so a
 *      missed handle would throw — we still want the dispose chain to
 *      complete on failure paths so the runtime is freed. (The module
 *      itself is cached and reused across runs.)
 *
 * Error mapping
 * -------------
 *   - Thrown inside the script (including from a tool bridge): the promise
 *     settles as `rejected`; we dump it for the message.
 *   - Memory cap: QuickJS throws "out of memory"; detected by
 *     {@link isOomError}; we set `meta.oom = true`.
 *   - Wall-clock cap: QuickJS throws "interrupted"; detected by
 *     {@link isInterruptedError} OR by the closure flag from
 *     {@link makeDeadlineInterruptHandler.getInterrupted}.
 *   - JSON.stringify cycles: caught and reported as a normal error.
 *
 * Memory hygiene
 * --------------
 * Every QuickJSHandle this function creates flows through a single
 * try/finally so disposal happens even on throw. The QuickJS DEBUG_SYNC
 * build would catch leaks — release build silently leaks, so we're strict.
 */

import {
  newQuickJSAsyncWASMModule,
  RELEASE_ASYNC,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from "quickjs-emscripten";

import {
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_STACK_BYTES,
  makeDeadlineInterruptHandler,
  isOomError,
  isInterruptedError,
} from "./limits.js";
import { bindToolsIntoContext, type BridgeState } from "./tool-bridge.js";
import type { CodeModeRequest, CodeModeResult } from "./types.js";

/**
 * Wrap the user's script in an async IIFE so top-level `await` works AND
 * we capture whatever the script `return`s as the final value. We append
 * a `return undefined` at the end so scripts that don't explicitly return
 * still produce a defined (`undefined`) result rather than a syntax error.
 */
function wrapScript(src: string): string {
  return `(async () => {\n${src}\n})()`;
}

/**
 * BigInt-safe JSON replacer. The script might return a BigInt (e.g. file
 * size from fs.stat in some future tool), which JSON.stringify chokes on
 * by default. We coerce to string — the LLM will see "123n"-style values
 * and can decide what to do. Same trick Node's `util.inspect` uses.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString() + "n";
  return value;
}

let cachedModule: QuickJSAsyncWASMModule | null = null;
let cachedModulePromise: Promise<QuickJSAsyncWASMModule> | null = null;

/**
 * Return the singleton asyncify-flavoured QuickJS WASM module, building it
 * lazily on first use. Building takes ~100 ms and triggers a WebAssembly
 * compile, so caching matters — without this every code-mode call would pay
 * that cost.
 *
 * Each {@link runScript} still creates a fresh **runtime** inside this shared
 * module, which is the actual isolation boundary in QuickJS. Memory + CPU
 * limits live on the runtime, not the module.
 *
 * We also coalesce concurrent first-time callers via `cachedModulePromise`
 * so a parallel test run doesn't trigger two WASM compiles.
 */
async function getAsyncModule(): Promise<QuickJSAsyncWASMModule> {
  if (cachedModule) return cachedModule;
  if (!cachedModulePromise) {
    cachedModulePromise = newQuickJSAsyncWASMModule(RELEASE_ASYNC).then((m) => {
      cachedModule = m;
      return m;
    });
  }
  return cachedModulePromise;
}

/** Reset the module cache. Test-only — production callers never need this. */
export function _resetModuleCacheForTests(): void {
  cachedModule = null;
  cachedModulePromise = null;
}

/**
 * Pump the VM's microtask queue and poll the promise's state until it's
 * settled (or until the deadline fires). Why we can't use
 * `context.resolvePromise`: that function blocks on the host side waiting
 * for the VM's promise to resolve, but the awaited continuations only run
 * on `executePendingJobs` — so unless someone schedules `executePendingJobs`
 * between every async step it deadlocks. We drive it explicitly here.
 *
 * The poll loop has a built-in yield to `setImmediate` so we don't starve
 * the host event loop when a script has long synchronous chunks between
 * awaits. The deadline interrupt handler is still in effect; once it
 * fires, the VM rejects, the promise transitions to `rejected`, and we
 * return immediately.
 */
async function drainAndResolve(
  context: QuickJSAsyncContext,
  runtime: QuickJSAsyncRuntime,
  promiseHandle: QuickJSHandle,
  deadlineExceeded: () => boolean,
): Promise<
  | { type: "fulfilled"; value: QuickJSHandle }
  | { type: "rejected"; error: QuickJSHandle }
  | { type: "deadline" }
> {
  // Hard upper bound on drain iterations as a safety net — a misbehaving
  // tool that keeps spawning microtasks forever would otherwise hang the
  // host; the wall-clock interrupt fires inside QuickJS but a host-side
  // infinite Promise loop wouldn't trip it.
  const HARD_MAX_ITERATIONS = 100_000;
  for (let i = 0; i < HARD_MAX_ITERATIONS; i++) {
    const state = context.getPromiseState(promiseHandle);
    if (state.type === "fulfilled") {
      return { type: "fulfilled", value: state.value };
    }
    if (state.type === "rejected") {
      return { type: "rejected", error: state.error };
    }
    // Pending — pump VM jobs. If executePendingJobs returns an error, the
    // runtime tripped while running a microtask; surface it.
    let executed = 0;
    let pendingErrorDump: unknown;
    try {
      const r = runtime.executePendingJobs();
      if (r.error) {
        pendingErrorDump = context.dump(r.error);
        r.error.dispose();
      } else {
        // Success branch — the value is a number (count of jobs executed).
        executed = (r as { value: number }).value;
      }
    } catch (err) {
      // Build a synthetic error handle so the caller path stays uniform.
      return {
        type: "rejected",
        error: context.newError((err as Error).message ?? String(err)),
      };
    }
    if (pendingErrorDump !== undefined) {
      return {
        type: "rejected",
        error: context.newError(formatPendingError(pendingErrorDump)),
      };
    }
    if (executed === 0) {
      // No VM-side jobs to run; the script is awaiting a host promise that
      // hasn't resolved yet. Yield to the host event loop so that promise
      // can make progress.
      await new Promise<void>((r) => setImmediate(r));
    }
    if (deadlineExceeded()) {
      return { type: "deadline" };
    }
  }
  return { type: "deadline" };
}

/**
 * Execute `req.script` inside a sandboxed QuickJS VM with `req.bindings`
 * available as `await`-able globals. Always returns a {@link CodeModeResult}
 * — failures inside the VM never throw out of this function.
 */
export async function runScript(req: CodeModeRequest): Promise<CodeModeResult> {
  const memoryLimit = req.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stackBytes = req.maxStackBytes ?? DEFAULT_MAX_STACK_BYTES;

  const bridge: BridgeState = { toolCalls: 0, toolTrace: [] };
  const deadline = makeDeadlineInterruptHandler(timeoutMs);
  const t0 = Date.now();

  let runtime: QuickJSAsyncRuntime | null = null;
  let context: QuickJSAsyncContext | null = null;
  let bindingHandles: QuickJSHandle[] = [];
  const deadlineExceeded = () => Date.now() - t0 > timeoutMs;

  try {
    const module = await getAsyncModule();
    runtime = module.newRuntime();
    runtime.setMemoryLimit(memoryLimit);
    runtime.setMaxStackSize(stackBytes);
    runtime.setInterruptHandler(deadline.handler);

    context = runtime.newContext();
    bindingHandles = bindToolsIntoContext(context, req.bindings, req.ctx, bridge);

    const wrapped = wrapScript(req.script);
    deadline.start();
    // evalCodeAsync resolves with `{ value | error }`. We unwrap manually so
    // we can attach a more helpful diagnostic when it's the interrupt path.
    let evalResult;
    try {
      evalResult = await context.evalCodeAsync(wrapped, "code-mode.js");
    } catch (err) {
      const interrupted = deadline.getInterrupted() || isInterruptedError(err);
      const oom = isOomError(err);
      return finalize(bridge, t0, false, {
        error: interrupted
          ? `script interrupted after ${timeoutMs} ms (wall-clock deadline)`
          : oom
            ? `script ran out of memory (${memoryLimit} bytes)`
            : `script eval failed: ${(err as Error).message ?? String(err)}`,
        interrupted,
        oom,
      });
    }

    if (evalResult.error) {
      const errVal = context.dump(evalResult.error);
      evalResult.error.dispose();
      const interrupted = deadline.getInterrupted() || isInterruptedError(errVal);
      const oom = isOomError(errVal);
      return finalize(bridge, t0, false, {
        error: interrupted
          ? `script interrupted after ${timeoutMs} ms (wall-clock deadline)`
          : oom
            ? `script ran out of memory (${memoryLimit} bytes)`
            : `script error: ${formatVmError(errVal)}`,
        interrupted,
        oom,
      });
    }

    // The wrapped script is an async IIFE → evalResult.value is a VM Promise.
    // Drive it to settled state via executePendingJobs + setImmediate yield.
    let drained;
    try {
      drained = await drainAndResolve(
        context,
        runtime,
        evalResult.value,
        deadlineExceeded,
      );
    } finally {
      evalResult.value.dispose();
    }
    if (drained.type === "deadline") {
      return finalize(bridge, t0, false, {
        error: `script interrupted after ${timeoutMs} ms (wall-clock deadline)`,
        interrupted: true,
        oom: false,
      });
    }
    if (drained.type === "rejected") {
      const errVal = context.dump(drained.error);
      drained.error.dispose();
      const interrupted = deadline.getInterrupted() || isInterruptedError(errVal);
      const oom = isOomError(errVal);
      return finalize(bridge, t0, false, {
        error: interrupted
          ? `script interrupted after ${timeoutMs} ms (wall-clock deadline)`
          : oom
            ? `script ran out of memory (${memoryLimit} bytes)`
            : `script error: ${formatVmError(errVal)}`,
        interrupted,
        oom,
      });
    }

    const value = context.dump(drained.value);
    drained.value.dispose();
    let stringified: string;
    try {
      if (value === undefined) {
        stringified = "";
      } else if (typeof value === "string") {
        stringified = value;
      } else {
        stringified = JSON.stringify(value, jsonReplacer);
        if (stringified === undefined) stringified = "";
      }
    } catch (err) {
      return finalize(bridge, t0, false, {
        error: `script returned a non-serializable value: ${(err as Error).message}`,
        interrupted: false,
        oom: false,
      });
    }

    return finalize(bridge, t0, true, { result: stringified });
  } finally {
    // Dispose in reverse order; swallow individual errors so one bad handle
    // doesn't prevent the rest of the chain from running.
    for (const h of bindingHandles) {
      try {
        h.dispose();
      } catch {
        /* already disposed */
      }
    }
    try {
      context?.dispose();
    } catch {
      /* runtime will catch leftover handles */
    }
    try {
      runtime?.dispose();
    } catch {
      /* WASM module is shared; runtime dispose can throw on leak */
    }
    // Do NOT dispose `module` — it's cached for the next call. The runtime
    // dispose above frees this run's heap entirely.
  }
}

/** Build the {@link CodeModeResult} envelope, splicing in shared metadata. */
function finalize(
  bridge: BridgeState,
  t0: number,
  ok: boolean,
  extra: {
    result?: string;
    error?: string;
    interrupted?: boolean;
    oom?: boolean;
  },
): CodeModeResult {
  return {
    ok,
    ...(extra.result !== undefined ? { result: extra.result } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
    meta: {
      toolCalls: bridge.toolCalls,
      durationMs: Date.now() - t0,
      interrupted: extra.interrupted ?? false,
      oom: extra.oom ?? false,
      toolTrace: bridge.toolTrace,
    },
  };
}

/**
 * Pretty-print a value dumped from the VM as an Error. QuickJS dumps thrown
 * Errors into `{ name, message, stack }`-shaped plain objects; we extract
 * `message` if present, fall back to JSON for everything else.
 */
function formatVmError(val: unknown): string {
  if (val && typeof val === "object" && "message" in (val as any)) {
    const m = (val as any).message;
    if (typeof m === "string") return m;
  }
  if (typeof val === "string") return val;
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

/** Alias used by the microtask drain path. */
const formatPendingError = formatVmError;
