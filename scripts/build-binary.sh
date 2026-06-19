#!/usr/bin/env bash
# Build a single-file mathran executable using bun --compile (v0.15 §3).
#
# Flow:
#   1. Build the Vite SPA into dist/web/                       (npm run build:web)
#   2. Embed dist/web/ into src/server/static-assets.generated.ts
#                                                              (bun scripts/build-static-assets.ts)
#   3. Build the TS server into dist/                          (npm run build)
#   4. bun build --compile from dist/cli/index.js into a single executable
#
# Result lives at dist/mathran-linux-x64.
# It is ELF, ~50–80 MiB depending on which deps come along.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUN="${BUN:-$HOME/.bun/bin/bun}"
if ! [ -x "$BUN" ]; then
  echo "error: bun not found at $BUN (override with BUN=...)" >&2
  exit 1
fi

TARGET="${TARGET:-bun-linux-x64}"
OUTPUT="${OUTPUT:-dist/mathran-linux-x64}"

echo "==> [1/4] vite build (SPA)"
npm run build:web

echo "==> [2/4] embed dist/web/ into static-assets.generated.ts"
"$BUN" scripts/build-static-assets.ts

echo "==> [3/4] tsc server build"
npm run build

echo "==> [4/4] bun build --compile --target=$TARGET --outfile=$OUTPUT"
"$BUN" build \
  --compile \
  --target="$TARGET" \
  --outfile="$OUTPUT" \
  dist/cli/index.js

# Quick smoke
file "$OUTPUT" || true
ls -lh "$OUTPUT"

echo
echo "done — try: ./$OUTPUT --help"
