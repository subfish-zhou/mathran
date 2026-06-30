# `apply_patch` Tool (V4A Multi-File Patch Protocol)

Mathran's `apply_patch` tool accepts a single string in the **V4A grammar** —
the on-the-wire format Codex / GPT-5 / Claude Opus 4.7+ are explicitly
trained on — and applies several filesystem mutations as one atomic
transaction.

## Why a separate tool?

`write_file` overwrites a whole file. `edit_file` does one unique-string
replace per call. Both are fine for one-off edits, but for "rename + patch +
add helper + delete dead file" in a single round-trip, you'd burn 4 tool
calls and 4 round-trips of context. `apply_patch` takes one string and runs
the whole batch — and is atomic: if any hunk fails to match, **nothing** is
written.

## Grammar

```
*** Begin Patch
*** Update File: src/foo.ts
@@ optional context header @@
 unchanged context line
-removed line
+added line
*** Add File: src/new.ts
+line 1
+line 2
*** Delete File: src/old.ts
*** Move File: src/a.ts -> src/b.ts          // Hermes / cline syntax
*** Update File: src/x.ts                    // alt. Codex move syntax
*** Move to: src/y.ts
@@
-old
+new
*** End Patch
```

### 5 supported directives

| Directive | Effect |
|---|---|
| `*** Update File: <path>` | Edit existing file via one or more `@@ ... @@` chunks |
| `*** Add File: <path>` | Create file — body is the new content (each line prefixed `+`) |
| `*** Delete File: <path>` | Remove file (must exist) |
| `*** Move File: <src> -> <dst>` | Rename (Hermes/cline syntax) |
| `*** Update File: <src>` + `*** Move to: <dst>` | Codex syntax for rename + edit |

### Chunk body conventions

- ` ` (space-prefixed) → unchanged context line
- `-` (minus-prefixed) → line to remove
- `+` (plus-prefixed) → line to add
- `@@ context @@` → optional anchor header (helps the fuzzy matcher find the
  right spot when the same lines appear multiple times)
- Multiple `@@` chunks in one Update File apply in order
- CRLF tolerated; trailing whitespace around `*** Begin/End Patch` ignored

## Atomicity (two-phase apply)

1. **Phase 1 — Validate**: every directive is simulated against an
   in-memory snapshot of the workspace. If any hunk can't be located, any
   `Add File` collides with an existing path, or any `Delete/Move source`
   doesn't exist, the call **bails with a precise error before touching the
   disk**.
2. **Phase 2 — Commit**: only when phase 1 succeeded. Writes go through
   `atomicWriteFile` (temp + rename); the per-file pattern survives a
   phase-2 crash (the previous version stays intact).

Failure example: a 3-file patch where the 2nd `Update File` hunk has a
typo in its context — the call fails, the 1st file's `Add File` is **not**
written. The model sees:

```json
{"ok": false, "content": "apply_patch: hunk 2 of src/foo.ts failed to locate context\n  expected:    return x.toLowerCase();\n  ...4 lines of nearby actual content..."}
```

## Fuzzy matching (9-strategy ladder)

LLM-generated diffs almost always drift slightly from the on-disk content
(whitespace, indentation, unicode quotes …). `apply_patch` tries each
strategy in order; the first one that finds a unique match wins.

1. **exact** — strict equality
2. **rstrip** — ignore trailing whitespace
3. **line_trimmed** — `trim()` both sides
4. **whitespace_collapsed** — fold runs of whitespace to one space
5. **indentation_flexible** — `lstrip()` (ignore leading whitespace)
6. **escape_normalized** — un-escape `\n / \t / \r` in pattern
7. **unicode_normalized** — smart-quotes / em-dash / nbsp → ASCII
8. **block_anchor** — first + last line match + middle dice-similarity ≥ 0.5
9. **context_aware** — ≥ 50 % of pattern lines have per-line similarity ≥ 0.8

If all 9 fail, the tool returns the nearest-miss line range plus a few lines
of actual context so the model can self-correct.

## Integration

- **Risk class**: `write` (goes through approval broker + `tool_execution`
  granular gate + hooks v1 `PreToolUse`/`PostToolUse`)
- **Checkpoints**: per affected file the tool snapshots `before/after`
  (`toolName: "patch"`) so `/diff` and `/rewind` work
- **Path traversal**: every resolved path is checked against the workspace
  root — `../../etc/passwd` is rejected
- **Read-before-write**: existing files must have been `read_file`-d in
  this session (same gate as `write_file` / `edit_file`)

## Enabling

The tool is **opt-in** via the session builtin-tools config:

```ts
new ChatSession({
  builtinTools: { apply_patch: true },
  // ...
});
```

In serve mode it's auto-enabled when `checkpoints` is configured (the
factory pulls workspace + conversationId from the checkpoint options).

## When to use it

- **Multi-file refactor**: rename a function and update every call-site in
  one round-trip
- **Code reviews**: model proposes a diff in V4A syntax for human review,
  human accepts → tool applies atomically
- **Rename + edit**: `Move File` + edit chunks together; conventional
  `edit_file` can't atomically rename

## When NOT to use it

- **Single-line typo fix**: `edit_file` is one parameter, no grammar
  overhead, no atomicity gain
- **Brand-new file with one obvious content**: `write_file` is fine — V4A
  `Add File` is just `write_file` with more boilerplate

## Worked example

```
*** Begin Patch
*** Add File: src/utils/clamp.ts
+export function clamp(n: number, lo: number, hi: number): number {
+  return Math.max(lo, Math.min(hi, n));
+}
*** Update File: src/sliders.ts
@@ existing imports @@
 import { round } from "./utils/round.js";
+import { clamp } from "./utils/clamp.js";

@@ class definition @@
 setValue(n: number): void {
-  this.value = Math.max(0, Math.min(100, n));
+  this.value = clamp(n, 0, 100);
 }
*** End Patch
```

This single `apply_patch` call creates `src/utils/clamp.ts`, adds the
import to `src/sliders.ts`, and replaces the inline `Math.max(0,
Math.min(100, n))` with the new helper — atomically.
