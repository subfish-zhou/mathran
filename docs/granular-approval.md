# Granular Approval Config

Mathran's approval policy used to be **one knob with four positions**:
`never` / `on-request` / `untrusted` / `on-failure`. Codex / Claude Code
exposed **five independent channels** instead, so users could mute one
prompt class without disabling the others. Granular Approval (2026-06-30)
adds the per-channel layer to mathran while keeping the top-level policy.

## Five channels

| Channel | What it gates | Default |
|---|---|---|
| `tool_execution` | Mutating-tool approval prompt (write_file / edit_file / bash / run_python / run_latex / apply_patch / ...) | `true` |
| `rule_proposal` | "Save this decision as a rule?" learning-mode modal | `true` |
| `ask_user` | The `ask_user` tool's clarification prompt | `true` |
| `request_permissions` | The `request_permissions` tool (reserved — not yet wired) | `true` |
| `mcp_elicitation` | MCP server-initiated elicitation prompts (reserved — not yet wired) | `true` |

> **Back-compat**: all five default to `true` — i.e. "always prompt". The
> behavior of a settings file without `approval.granular` is **byte-for-byte
> identical** to pre-2026-06-30 mathran.

## Configuration

In `.mathran/settings.json`:

```json
{
  "approval": {
    "policy": "on-request",
    "granular": {
      "tool_execution": true,
      "rule_proposal": true,
      "ask_user": false,
      "request_permissions": true,
      "mcp_elicitation": false
    }
  }
}
```

The `granular` block is a partial override — missing keys default to
`true`. Non-boolean values are coerced to `true` (fail-open).

## Precedence

```
policy === "never"
  ↓
muted: silence every channel, regardless of granular
  ↑
granular[channel] === false
  ↓
muted: silence this one channel (other channels follow their own switches)
  ↑
otherwise: prompt as the policy dictates
```

Examples:

| `policy` | `granular.tool_execution` | Result for a `write_file` call |
|---|---|---|
| `never` | (any) | Always allow (no prompt — top-level wins) |
| `on-request` | `true` (default) | Prompt the user |
| `on-request` | `false` | Allow silently |
| `untrusted` | `true` | Prompt only if path escapes workspace / suspicious bash |
| `untrusted` | `false` | Allow silently |

**Important**: granular **cannot loosen** `policy: "never"`. If you want
"prompt only for the MCP elicitation channel and nothing else", set
`policy: "on-request"` + `granular: { tool_execution: false, ask_user:
false, rule_proposal: false, mcp_elicitation: true }`.

## What still blocks even with a muted channel

- Denylist rules (`approval.denylist`)
- Standing rules (`approval.rules`) with `action: "deny"`
- Permission-profile `denylistTools`
- Permission-profile `readOnlyMode` / `hardRejectMutations`

The granular gate is the *prompt surface* — it doesn't bypass standing
deny/allow rules.

## Use cases

### "Quiet auto-mode for trusted scripts"
```json
{
  "approval": {
    "policy": "on-request",
    "granular": { "tool_execution": false, "ask_user": false, "rule_proposal": false }
  }
}
```
Combine with a strict `denylist` and `permissions.readOnlyMode = false`:
mutating tools run silently, but a tool listed in the denylist is still
rejected.

### "Prompt for writes, never for ask_user"
```json
{ "approval": { "policy": "on-request", "granular": { "ask_user": false } } }
```
The `ask_user` tool will return `default` (when supplied) or
`ASK_USER_GOAL_AUTO_REPLY`.

### "Maximum noise — explicit prompts everywhere"
Either leave `granular` out, or set every channel to `true`. Same effect.

## Implementation

- Types: `src/core/approval/types.ts` — `GranularChannel`,
  `GranularApprovalConfig`, `DEFAULT_GRANULAR_APPROVAL_CONFIG`,
  `resolveGranularApprovalConfig` (fail-open coercer)
- Pure decision: `src/core/approval/policy.ts` — `shouldPromptFor(channel,
  policy, granular): boolean`
- Wiring: `src/core/chat/approval-broker.ts` exposes `granularConfig`
  getter; `preCheck` short-circuits `tool_execution` and `record`
  short-circuits `rule_proposal`
- `ask_user` channel: `src/core/chat/tools/ask-user.ts` accepts a
  `granularGate` option wired by `session.ts` to
  `broker.granularConfig.ask_user`

## Testing

`src/core/approval/granular.test.ts` covers:
- `shouldPromptFor` precedence (policy override / channel mute / multi-mute)
- `resolveGranularApprovalConfig` (fail-open coercion)
- `ApprovalBroker.granularConfig` round-trip
- `tool_execution=false` → `preCheck` returns `{kind: "allow"}` (no `ask`)
- `tool_execution=true` (default) → `preCheck` still returns `ask`
- `policy=never` overrides granular even when every channel is `true`
