# Checkpointing & `/rewind`

Mathran auto-snapshots every mutating tool call (`write_file` /
`edit_file` / `apply_patch`) so a user can review or roll back. The
2026-06-30 update brought conversation-aware modes, aligning the
`/rewind` surface with Claude Code's five-segment menu.

## Quick start

```
> /diff <toolCallId>          # show the diff between before/after for one call
> /rewind                     # list all checkpoints in this conversation
> /rewind last                # roll back the most recent checkpoint (default: code-only)
> /rewind 3                   # roll back the last 3 checkpoints
> /rewind checkpoint-abc      # roll back to (and including) one by id prefix
> /rewind last --mode code-and-conversation
                              # roll back BOTH files AND the conversation jsonl
```

The SPA's `CheckpointChip` (the per-tool-call card next to each mutating
tool result) offers the same operations via a 5-option dropdown.

## Five restore modes

| `--mode` | Files | Conversation jsonl |
|---|---|---|
| `code-only` (default) | ✅ Roll back via `before` snapshots | ❌ Untouched |
| `conversation-only` | ❌ Untouched | ✅ Truncated to `messageCountBefore` + rewind marker |
| `code-and-conversation` | ✅ Roll back | ✅ Truncated |
| `summarize-from-here` | ❌ Untouched | ✅ Keep pre-checkpoint head verbatim, replace post-checkpoint tail with one system summary |
| `summarize-up-to-here` | ❌ Untouched | ✅ Preserve leading system prompts + post-checkpoint tail, replace middle (the pre-checkpoint head) with one system summary |

The two `summarize-*` modes call an injected `Summarizer` function. The
default summarizer is **deterministic stub text** (a "this is a placeholder"
message with TODO marker) — v2 will route through the project's primary
LLM.

## Why two summarize modes?

- `summarize-from-here` is **"go back to that point and compress what
  happened since"** — you wanted to retry from there but keep a digest of
  the dead-end you took.
- `summarize-up-to-here` is **"keep going from here but free up the
  context spent getting here"** — you've reached a useful state, the
  pre-history is bloat.

The first preserves all system prompts and any leading framing; the second
preserves the same framing PLUS the post-checkpoint tail you want to
continue from.

## When does mathran take a checkpoint?

The middleware fires **before** every successful mutating tool call (`risk
class === "write"` with a `path` arg). Each checkpoint records:
- `before`: file content snapshot (or `absent` marker if the file didn't
  exist yet, or `large` hash-only marker for files > 1 MB)
- `after`: same shape, written post-tool
- `toolCallId`, `toolName`, `affectedPaths`, `timestamp`,
  `description`, `messageCountBefore` (new — see below)

Snapshots live under `<workspace>/.mathran/cache/checkpoints/<conversationId>/`
and are **never deleted by rewind** — the forward history is always
preserved so you can re-rewind / branch.

## `messageCountBefore` (the conversation hook)

To support truncating the jsonl to "right before this tool call", every
checkpoint now records `messageCountBefore: number` — the value of
`this.messages.length` at capture time.

- `code-only` mode ignores this entirely (back-compat)
- `conversation-only` / `code-and-conversation` truncate the message list
  to `messageCountBefore`, then append one system "rewinded" marker
- `summarize-from-here` keeps the first `messageCountBefore` messages,
  appends one system summary covering the remainder
- `summarize-up-to-here` preserves all leading `role === "system"`
  messages from the head, prepends one summary covering the rest of the
  head, then appends the post-`messageCountBefore` tail verbatim

Old checkpoints (captured before 2026-06-30) lack `messageCountBefore`
— any non-`code-only` mode against them returns `conversation.action:
"skipped"` and only the file rollback runs.

## SPA dropdown menu

The `CheckpointChip` Rewind button is now a `Rewind ▾` dropdown with the
5 options. Selecting one sends `--mode <m>` to the server's `/rewind`
slash handler. ESC closes the menu; click-outside closes the menu; every
item has a stable `data-testid` for E2E.

`ChatPanel.handleCheckpointAction` accepts the mode parameter and
splices it into the slash command args (`<toolCallId> --mode <mode>`).

## Headless / host plumbing

`runRewind(workspace, conversationId, arg, hooks?)` accepts an optional
fourth argument:

```ts
interface RunRewindHostHooks {
  historyAdapter?: ConversationHistoryAdapter;  // read/write the conversation jsonl
  summarizer?: Summarizer;                       // produce the system summary text
}
```

- `historyAdapter`: hosts that store conversation jsonl elsewhere
  (in-memory, S3, sqlite) implement this two-method protocol. CLI and
  serve both ship a `makeChatStoreHistoryAdapter()` for the on-disk
  `ScopedChatSessionStore`.
- `summarizer`: defaults to the bundled deterministic stub. Wire a real
  LLM-backed one for production.

Missing `historyAdapter` → non-`code-only` modes degrade gracefully:
files still roll back, `conversation.action = "skipped"` is surfaced in
the result so the caller can log it.

## Testing

- `src/core/checkpoints/__tests__/rewind.test.ts` — legacy code-only path
  (unchanged)
- `src/core/checkpoints/__tests__/rewind-modes.test.ts` — 7 tests
  covering each of the 5 modes + degradation path + invalid `--mode`

## v2 roadmap

- Real LLM-backed summarizer (currently stub)
- `/rewind --mode` UX: SPA shows a preview of what would be summarised
  before commit
- Branching: rewind to a checkpoint, then fork the conversation rather
  than overwriting the live one
