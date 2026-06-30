# Hooks v1

User-controllable shell scripts that run at well-known points in a mathran
chat / goal session. Inspired by Codex's `codex-rs/hooks/` and Claude Code's
`hooks` system, with explicit alias compatibility so existing Claude Code
hook configs largely just work.

Hooks v1 are **additive** — they coexist with mathran's existing legacy
filename-prefix hooks (`pre-chat-*.sh` / `post-tool-*.sh` / `pre-edit-*.sh`
/ `pre-bash-*.sh` / `on-goal-complete-*.sh`). Use legacy hooks for
mathran-specific lifecycle events; use v1 hooks when you want fine-grained
matcher syntax, Claude Code alias compatibility, or want to gate tool
calls with structured JSON I/O.

---

## When hooks fire (5 events)

| Event | Fires | Can BLOCK? | Can REWRITE input? |
|---|---|---|---|
| **PreToolUse** | Before a tool runs, after permission checks pass | ✅ Yes | ✅ Yes (`updated_input`) |
| **PostToolUse** | After a tool returns (success OR error) | ❌ No (advisory only) | ❌ |
| **SessionStart** | First `session.send()` call of the conversation | ❌ | ❌ (`additionalContext` injected as system message) |
| **PreCompact** | Before auto-compaction runs | ✅ Yes (skip compaction) | ❌ |
| **PostCompact** | After compaction finishes | ❌ (telemetry only) | ❌ |

---

## Config file locations

Hooks are configured in `hooks.json` files. Both locations are checked
and **all matching entries fire** (user first, then workspace):

| Layer | Path |
|---|---|
| User-wide | `~/.mathran/hooks.json` |
| Per-workspace | `<workspace>/.mathran/hooks.json` |

When neither file exists (or both have zero entries), the v1 system is
**inert** — zero overhead, identical to v0.12 behavior.

---

## Config shape

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "./.mathran/hooks/audit.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "./.mathran/hooks/log.sh" }]
      }
    ],
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "./.mathran/hooks/load-context.sh" }]
      }
    ]
  }
}
```

- `matcher` syntax (see below) is **optional** for SessionStart /
  PreCompact / PostCompact (those events have no tool input).
- `timeout` is per-hook in **seconds**; default 30s.
- `type` currently only supports `"command"`. HTTP / MCP-tool / prompt
  hook types are reserved for v2.

---

## Matcher syntax

Same four shapes as Claude Code:

| Syntax | Behavior |
|---|---|
| omitted / `""` / `"*"` | Universal — matches any tool |
| `"Bash"` (word chars only) | Strict equality |
| `"Write\|Edit"` (pipe-joined words) | Any-of equality |
| anything else | JavaScript regex (unanchored) |

Malformed regex falls back to a literal substring check — a broken
pattern never crashes the dispatcher; it just won't match what you
intended. Pin tests around your matchers.

---

## Claude Code alias compatibility

Mathran's canonical tool names differ from Claude Code's, but the v1
dispatcher computes the **effective matcher inputs** for each tool call as:

```
[<canonical mathran tool name>, ...Claude Code aliases]
```

so a hook configured with `"matcher": "Write"` automatically gates
mathran's `write_file` tool. The full alias table:

| Claude Code matcher | Mathran tool |
|---|---|
| `Write` | `write_file` |
| `Edit` | `edit_file` |
| `Bash` | `bash` |
| `Agent` | `dispatch_subagent` |

Adding more aliases (e.g. Codex's `apply_patch`) is a pure data change
in `src/core/hooks/v1/aliases.ts` — no matcher/loader changes needed.

---

## Hook script protocol (stdin / stdout / exit)

The hook script is invoked via `execFile` (no shell — no command injection
risk). Mathran writes a single JSON line to **stdin**:

```json
{
  "hookEventName": "PreToolUse",
  "cwd": "/path/to/workspace",
  "sessionId": "c-xxxx",
  "toolName": "bash",
  "toolUseId": "call_abc",
  "toolInput": { "command": "ls" }
}
```

The hook responds via **stdout** (also JSON) + **exit code**:

| Response | Effect |
|---|---|
| `exit 0` + `{}` (or empty stdout) | Allow |
| `exit 0` + `{"decision":"block","reason":"..."}` | Block; reason fed back to LLM |
| `exit 0` + `{"decision":"allow","updated_input":{...}}` | Allow with rewritten tool input |
| `exit 0` + `{"hookSpecificOutput":{"additionalContext":"..."}}` | Allow + inject string as system message (PreToolUse / PostToolUse / SessionStart) |
| `exit 0` + `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"..."}}` | Block (Claude Code compat) |
| `exit 2` + stderr | Block; stderr is the reason |
| Any other non-zero exit | Block |
| Timeout (default 30s) | Block + SIGTERM → SIGKILL 500ms later |

`stdout` and `stderr` are each capped at **100 KB**; excess truncated.

---

## Safety constraints

1. `command` must be a single path (relative to the hooks.json directory
   or absolute). **Inline shell strings** like `"rm -rf /"` are rejected
   at load time with a warning.
2. The resolved script path must live inside the **same containment root**
   as its hooks.json file — workspace hooks must point inside `<workspace>/`,
   user hooks must point inside `~/.mathran/`. Any `../` escape is rejected.
3. Execution is via `execFile(interp, [...args, scriptPath])` — argv array,
   no `/bin/sh -c`, zero command injection.
4. Sandboxed env: only `PATH / HOME / USER / LANG / TZ` forwarded; mathran
   injects `MATHRAN_HOOK_EVENT` and `MATHRAN_WORKSPACE`. Sensitive env vars
   are not leaked.

---

## Example hooks

### Block all `rm -rf /` in `bash`

`<workspace>/.mathran/hooks/no-rmrf-root.sh`:

```sh
#!/bin/sh
input=$(cat)
cmd=$(echo "$input" | jq -r '.toolInput.command // ""')
case "$cmd" in
  *"rm -rf /"*|*"rm -rf /*"*)
    cat <<JSON
{"decision":"block","reason":"rm -rf / variant blocked by site policy"}
JSON
    ;;
  *)
    echo "{}"
    ;;
esac
```

Plus `<workspace>/.mathran/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./hooks/no-rmrf-root.sh" }]
      }
    ]
  }
}
```

### Append session-wide context on start

`~/.mathran/hooks/inject-team-conventions.sh`:

```sh
#!/bin/sh
echo '{"hookSpecificOutput":{"additionalContext":"This team uses Lean 4 + Mathlib. Always prefer mathlib lemmas over rolling your own."}}'
```

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "./hooks/inject-team-conventions.sh" }] }
    ]
  }
}
```

### Log every successful tool call to a SQLite ledger

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "./hooks/audit-log.sh", "timeout": 5 }]
      }
    ]
  }
}
```

---

## Failure modes & debugging

- **Hook never fires**: check `loadHookV1Config` warnings — mathran logs them
  via `console.warn` at session start (look for `[mathran hooks v1]` prefix).
  Common causes: invalid JSON, inline shell string, path escaped containment.
- **Hook fires but is ignored**: matcher doesn't match. Test your matcher
  syntax with `matchOne` / `matchAny` from `src/core/hooks/v1/matcher.ts`.
- **Hook hangs**: it's reading stdin but the script doesn't `cat` or
  otherwise consume it. Either consume stdin or close it; `node --version`
  -style "doesn't read stdin" scripts work because mathran closes the pipe
  after writing.
- **Hook output looks truncated**: 100 KB cap per stream. Either summarize
  upstream or split into multiple hooks.

---

## Roadmap (v2)

- HTTP hook type (`POST` to a URL with same JSON I/O)
- MCP-tool hook type (invoke a tool on a configured MCP server)
- Prompt-based hook (defer decision to a Claude subagent — useful for
  Stop hook "is this actually done?" checks)
- Additional Codex events: `UserPromptSubmit` / `SubagentStart` /
  `SubagentStop`
- `additionalDirectories` containment for hooks that live outside
  workspace / user dir

See `_tasks/audit-hooks-followup/` for the full backlog (TBD).
