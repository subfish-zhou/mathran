/**
 * Copy builtin skill `SKILL.md` files into the compiled `dist/` tree.
 *
 * `tsc` only emits `.ts` → `.js`; the shipped builtin skills
 * (`src/core/chat/builtin-skills/<name>/SKILL.md`) are plain markdown and
 * would otherwise be missing from a published package. The builtin loader
 * resolves these relative to its own module, so they must sit next to the
 * compiled `loader.js`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src", "core", "chat", "builtin-skills");
const distDir = path.join(root, "dist", "core", "chat", "builtin-skills");

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

if (!fs.existsSync(srcDir)) {
  console.warn(`[copy-builtin-skills] no source dir at ${srcDir}; nothing to copy`);
} else if (!fs.existsSync(distDir)) {
  console.warn(`[copy-builtin-skills] no dist dir at ${distDir}; run tsc first`);
} else {
  const n = copyMarkdown(srcDir, distDir);
  console.log(`[copy-builtin-skills] copied ${n} SKILL.md file(s) into dist/`);
}
