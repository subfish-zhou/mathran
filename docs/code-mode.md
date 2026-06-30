# Code Mode v1 (quickjs)

Let the LLM emit **one JavaScript script** that calls multiple mathran
tools — instead of N round-trips with N tool_calls. One LLM call,
many tool invocations. Token cost + latency drop ~10× on
multi-step orchestration.

**Status:** v1 default-off, opt-in via `builtinTools.code_mode`.
Runtime: `quickjs-emscripten` (pure JS, ~1MB, no native).

## Why JavaScript?

- **Sandbox-mature**: 30 years of browser-driven hardening. QuickJS /
  V8 isolates are battle-tested.
- **LLM training data**: JS coverage is dense; Code mode scripts come
  out clean.
- **Sync-shaped tools**: `await read_file(...)` reads naturally in JS.
  Python's `__import__` / Pyodide cold-start make it ROI-negative.
- **Math heavy lifting** still calls out to `run_python` (Python sub-
  process via the normal tool route) — Code mode is for **orchestration**,
  not numeric work.

## Enabling

```ts
new ChatSession({
  builtinTools: { code_mode: true },
  // ...
});
```

The factory pulls workspace + the list of bound tools from the session
at call time, so dynamically registered tools are visible to the
script.

## Default tool whitelist

`DEFAULT_ALLOWED_TOOLS`: `read_file`, `glob`, `grep`, `search_wiki`,
`read_wiki_page`, `list_wiki_pages`, `read_doc_page`,
`list_doc_pages`, `list_projects`, `read_project_metadata`,
`list_efforts`. (Read-only.)

Add to it explicitly:
- `allowWrite: true` → adds `write_file`, `edit_file`, `apply_patch`
- `allowBash: true` → adds `bash`, `run_python`, `run_latex`,
  `lean_check`
- `extraAllowedTools: ["my_tool"]` → additive

Plan mode forces Code mode off (read-only stance — Code mode is
`riskClass: "exec"`).

## Limits

| Knob | Default | Override via |
|---|---|---|
| Memory | 256 MiB | `memoryLimitBytes` option |
| CPU time | 60 s wall | `timeoutMs` option |
| Stack | 1 MiB | `maxStackBytes` option |

OOM and interrupt errors are caught and returned as `ok: false` with
a friendly message. The host process is **not** affected.

## What scripts CANNOT do

- `eval` / `Function` / `import()` — disabled in the runtime
- `process`, `require`, `__filename`, `fetch`, `XMLHttpRequest`,
  `Worker` — not exposed (QuickJS host bindings are explicit)
- Filesystem / network — only via bound mathran tools
- Persist state across calls — each `run_code_mode` invocation is a
  fresh runtime

## Tool result shape

Bound tools return their **content string directly** (the bridge
unwraps `ToolResult { ok, content }`):

```js
// Inside the script:
const body = await read_file({ path: "src/foo.ts" });
// body is the string content. If the tool errored, an exception is
// thrown — wrap in try/catch.
try {
  await edit_file({ path: "...", old: "...", new: "..." });
} catch (e) {
  return `edit failed: ${e.message}`;
}
```

## Worked example

"Scan all `.md` under `docs/` and list which have a `TODO` line":

```js
const files = await glob({ pattern: "docs/**/*.md" });
const todos = [];
for (const f of files.split("\n").filter(Boolean)) {
  const body = await read_file({ path: f });
  if (body.includes("TODO")) todos.push(f);
}
return todos.join("\n") || "no TODOs";
```

Without Code mode that's N glob + read_file tool calls = N LLM
round-trips. With Code mode it's **one** LLM call → one
`run_code_mode` → one return string back to the LLM.

## Known quirks (v1)

- **quickjs marshalling for object cycles**: a return value like
  `{ a: { ... }, self: a }` is projected to `"[object Object]"` (not
  serialized as JSON cycle). Return primitive strings / arrays for
  best fidelity.
- **Async reentrancy stress**: tight loops with `>10` awaits on the
  same tool in a row can hit a wasm refcount panic in the underlying
  `quickjs-emscripten` build. Workaround: break loops into smaller
  chunks; v2 will pin a newer build with the fix.

## Tests

`src/core/code-mode/__tests__/`:
- `runtime.test.ts` (8) — basic eval, async/await, banned globals,
  return-value marshalling
- `limits.test.ts` (10) — deadline interrupt, OOM/interrupt error
  classification
- `code-mode-tool.test.ts` (8) — factory shape, end-to-end script
  execution, whitelist enforcement, error surface

26/26 pass.
