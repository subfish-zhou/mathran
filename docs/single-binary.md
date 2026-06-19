# Single-binary mathran (v0.15 §3)

`scripts/build-binary.sh` produces a single-file ELF executable that bundles
the TypeScript server, the React SPA, and the Bun runtime into one ~100 MiB
binary. Drop it on a fresh machine, `chmod +x`, run.

## What you get

- **One file**: `dist/mathran-linux-x64`, no `node` / `npm` / `node_modules`
  required on the target machine
- **Embedded SPA**: the Vite build is base64'd into the binary; SPA fallback
  works on `/`, `/global-chat`, `/projects/...`
- **All CLI subcommands work**: `chat`, `serve`, `goal`, `project`, `effort`,
  `subagent`, `plan`, `config`, `doctor`, `version`
- **Tested**: serves :17878 with 200s on `/`, `/global-chat`, `/api/providers`;
  embedded JS bundle resolves to the exact 260 KiB SPA payload

## Build it

From the repo root:

```bash
bash scripts/build-binary.sh
```

That runs, in order:

1. `npm run build:web` — Vite SPA → `dist/web/`
2. `bun scripts/build-static-assets.ts` — base64 + glue → `src/server/static-assets.generated.ts`
3. `npm run build` — `tsc` → `dist/`
4. `bun build --compile --target=bun-linux-x64 --outfile=dist/mathran-linux-x64 dist/cli/index.js`

Requires `bun` (≥ 1.3.x). Override with `BUN=/path/to/bun bash scripts/build-binary.sh`.

## Run it on a fresh box

```bash
chmod +x mathran-linux-x64
./mathran-linux-x64 --version
./mathran-linux-x64 serve --port 7878 &
xdg-open http://127.0.0.1:7878
```

The binary keeps mathran's same defaults: workspace is `~/mathran-workspace`,
listen address is `127.0.0.1`-only (never `0.0.0.0`), provider config lives in
`~/.mathran/config.toml`.

## Cross-compile (untested)

Bun supports `--target=bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`.
The Linux-x64 build is the only one we currently verify in CI:

```bash
TARGET=bun-darwin-arm64 OUTPUT=dist/mathran-darwin-arm64 bash scripts/build-binary.sh
```

Linux→macOS cross-compile produces a binary that has not been signed; you'll
need to `xattr -dr com.apple.quarantine` on the target machine.

## Known limits

- **Lean is NOT bundled.** The binary calls out to `lean` on `$PATH`; install
  elan + a Lean toolchain on the target machine. `mathran doctor` reports
  what's missing.
- **No native deps.** A scan of `node_modules` showed zero `.node` files, so
  bun's compile path could bundle everything directly. If a future dep adds
  one, you'll need to either pin it as `--external` or ship it alongside.
- **Argv compat shim.** Bun-compiled binaries set
  `import.meta.url === argv[1]` for **every** bundled module — that breaks
  the common "is this module the script entry?" pattern. We use
  `import.meta.main` (Bun-specific, also Node ≥ 21) to disambiguate; see
  `src/providers/lean/local.ts` for the canonical guard if you add another
  self-test block.
- **`--version` reads package.json off disk.** In a compiled binary the
  package.json isn't on disk; the version falls back to `0.0.0`. Future work:
  embed the version at build time.

## Files added by v0.15 §3

| Path | Purpose |
|---|---|
| `scripts/build-binary.sh` | Driver script |
| `scripts/build-static-assets.ts` | Vite-build → embedded-asset generator |
| `src/server/static-assets.ts` | Embedded-asset registry + Hono handler |
| `src/server/static-assets.generated.ts` | Generated, gitignored |
| `docs/single-binary.md` | This file |
