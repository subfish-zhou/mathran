/**
 * Copy builtin static markdown assets into the compiled `dist/` tree.
 *
 * `tsc` only emits `.ts` → `.js`; the shipped builtin assets are plain
 * markdown and would otherwise be missing from a published package:
 *   - builtin skills:     `src/core/chat/builtin-skills/<name>/SKILL.md`
 *   - builtin goal templates (Layer 3): `src/core/goal/builtin-templates/<name>.md`
 *
 * Each loader resolves these relative to its own compiled module, so they
 * must sit next to the corresponding `.js` in `dist/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function copyMarkdown(from: string, to: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      count += copyMarkdown(src, dst);
    } else if (entry.name.endsWith(".md")) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      count++;
    }
  }
  return count;
}

/**
 * 2026-06-25 — copy `.py` helper scripts that live next to a `.ts` tool
 * (the tool spawns them at runtime via spawn(python, [path])). Used by
 * tools/pdf-extract.ts → python-helpers/pdf_extract.py and similar.
 */
function copyPythonHelpers(from: string, to: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      count += copyPythonHelpers(src, dst);
    } else if (entry.name.endsWith(".py")) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      count++;
    }
  }
  return count;
}

function copyAssetDir(label: string, rel: string): void {
  const srcDir = path.join(root, "src", ...rel.split("/"));
  const distDir = path.join(root, "dist", ...rel.split("/"));
  if (!fs.existsSync(srcDir)) {
    console.warn(`[copy-builtin-skills] no source dir at ${srcDir}; nothing to copy`);
    return;
  }
  // The dist tree may not contain the leaf dir yet (no .ts emitted into it,
  // e.g. a templates-only dir) — create it so the copy still lands.
  fs.mkdirSync(distDir, { recursive: true });
  const n = copyMarkdown(srcDir, distDir);
  console.log(`[copy-builtin-skills] copied ${n} ${label} file(s) into dist/`);
}

copyAssetDir("SKILL.md", "core/chat/builtin-skills");
copyAssetDir("goal-template", "core/goal/builtin-templates");

// 2026-06-25 — Python helpers used by spawn() from .ts tools live in
// per-tool python-helpers/ subdirs. Copy them alongside the .js into
// dist/ so `new URL("./python-helpers/X.py", import.meta.url)` resolves.
{
  const srcDir = path.join(root, "src", "core", "chat", "tools", "python-helpers");
  const distDir = path.join(root, "dist", "core", "chat", "tools", "python-helpers");
  if (fs.existsSync(srcDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    const n = copyPythonHelpers(srcDir, distDir);
    console.log(`[copy-builtin-skills] copied ${n} Python helper file(s) into dist/`);
  }
}
