/**
 * Code mode v1 — tool bridge.
 *
 * Bridges a mathran {@link ToolSpec} into a QuickJS-async global so the
 * sandboxed script can call it via `await <name>({ ...args })`. The bridge:
 *
 *   1. Reads the argument handle as JSON (`context.dump(handle)`).
 *   2. Calls `tool.execute(args, ctx)` on the host.
 *   3. Pushes the result content (string) back into the VM.
 *
 * We use {@link QuickJSAsyncContext.newAsyncifiedFunction} which makes the
 * script see a *synchronous-looking* function — QuickJS suspends the entire
 * WASM module while the host promise resolves, then resumes. This means the
 * model can write straight-line `await read_file(...)` without ever touching
 * `runtime.executePendingJobs` or worrying about microtask order.
 *
 * Argument shape
 * --------------
 * Every bound tool takes ONE argument: a JS object matching the tool's
 * `parameters` schema (same shape as a tool-call's `arguments`). The bridge
 * `JSON.stringify`s it on the VM side via `context.dump` and forwards it to
 * `tool.execute` verbatim. This keeps the LLM's mental model unified: code
 * mode and tool-call mode use the exact same `{ ...args }` payload.
 *
 * Return shape
 * ------------
 * The bridge resolves with the tool's `content` STRING. If `tool` returned
 * `ok: false`, we still resolve with the content (so the script can decide
 * to handle it), but we ALSO attach a `_codemode_ok = false` marker on the
 * return value's enveloping function so consumers that care can detect it.
 * Actually — keeping it simple: we **throw** on `ok: false` so the script's
 * normal `try/catch` works:
 *
 *     try {
 *       const txt = await read_file({ path: "missing" });
 *     } catch (e) {
 *       // e.message === "read_file failed: no such file"
 *     }
 *
 * Rationale: most tool failures are "the model asked for something that
 * doesn't exist" and the script genuinely wants to short-circuit. The few
 * legitimate "soft failure" cases (e.g. `glob` returning 0 matches) already
 * surface as `ok: true` with an empty list.
 *
 * Tracing
 * -------
 * Every invocation pushes the tool name into the shared `trace` array. The
 * orchestrator reads it from `CodeModeResult.meta.toolTrace` so the user
 * can see at a glance what the script did — useful for debugging "why did
 * this one tool eat my entire budget?".
 */

import type { QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten";
import type { ToolSpec, ToolExecuteContext } from "../chat/session.js";
import type { ToolBinding } from "./types.js";

/**
 * Bind all `bindings` into `context.global` as asyncified functions. Each
 * call appends to `state.trace` and increments `state.toolCalls`.
 *
 * Caller is responsible for disposing the returned handles BEFORE disposing
 * the context. Returning them keeps memory bookkeeping explicit (QuickJS
 * leaks loudly otherwise).
 */
export interface BridgeState {
  toolCalls: number;
  toolTrace: string[];
}

export function bindToolsIntoContext(
  context: QuickJSAsyncContext,
  bindings: ToolBinding[],
  ctx: ToolExecuteContext | undefined,
  state: BridgeState,
): QuickJSHandle[] {
  const handles: QuickJSHandle[] = [];
  for (const binding of bindings) {
    if (!isValidIdent(binding.name)) {
      // Defensive: a tool with a non-JS-identifier name (e.g. MCP namespaced
      // names with `__`) can still be bound — but we refuse anything with
      // characters that would break `globalThis.<name>` lookup. We skip
      // such tools rather than crash; the script just won't see them.
      continue;
    }
    const fnHandle = context.newAsyncifiedFunction(
      binding.name,
      async (argHandle): Promise<QuickJSHandle> => {
        state.toolCalls += 1;
        state.toolTrace.push(binding.name);

        // Materialize the argument as a plain JS object. `dump` walks the
        // QuickJS value into native JS; for our use case it's either an
        // object literal, a primitive, or undefined (we coerce to {}).
        let parsed: Record<string, unknown> = {};
        if (argHandle !== undefined) {
          try {
            const dumped = context.dump(argHandle);
            if (dumped && typeof dumped === "object" && !Array.isArray(dumped)) {
              parsed = dumped as Record<string, unknown>;
            } else if (dumped !== undefined && dumped !== null) {
              // Non-object args aren't part of the contract; surface a clear
              // error so the model self-corrects rather than getting silent {}.
              throw new Error(
                `tool '${binding.name}' expects an object argument, got ${typeof dumped}`,
              );
            }
          } catch (err) {
            // Re-throw inside the VM so the script's try/catch can see it.
            return context.newError(
              `argument deserialization failed: ${(err as Error).message}`,
            );
          }
        }

        // Execute the host tool. We catch BOTH thrown errors and ok:false
        // results and surface them as VM-side throws so the script can use
        // ordinary try/catch.
        let res: { ok: boolean; content: string };
        try {
          res = await binding.tool.execute(parsed, ctx);
        } catch (err) {
          return context.newError(
            `${binding.name} threw: ${(err as Error).message ?? String(err)}`,
          );
        }
        if (!res.ok) {
          return context.newError(
            `${binding.name} failed: ${res.content}`,
          );
        }
        // Success — return the content string. The script can `JSON.parse`
        // it if the tool produces JSON-shaped output, or just consume it
        // as text for tools like `read_file`.
        return context.newString(res.content);
      },
    );
    // Install on globalThis under the binding name.
    context.setProp(context.global, binding.name, fnHandle);
    handles.push(fnHandle);
  }
  return handles;
}

/**
 * JS-identifier sniff: matches `[A-Za-z_$][A-Za-z0-9_$]*`. Used to refuse
 * binding tools whose `name` couldn't be installed as a clean global.
 */
function isValidIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
