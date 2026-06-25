/**
 * <FilePathChip> + augmentMarkdownWithFileChips — auto-render workspace
 * paths in assistant messages as clickable download chips.
 *
 * Motivation (2026-06-25, subfish feedback): a remote / ssh-tunneled
 * user has no way to grab files the assistant just wrote to disk on the
 * mathran box. They were stuck either copy-pasting the chat body or
 * scp'ing manually from another terminal. So when the assistant says
 * "I saved the audit to /home/azureuser/mathran-workspace/audit.md",
 * we auto-augment that path with a download chip pointing at
 * /api/file?path=<absolute>.
 *
 * Strategy: post-process the *already-rendered HTML* string from marked.
 * We don't touch the markdown AST — instead we run a regex over the
 * final HTML to find absolute paths that:
 *   1. Look like absolute filesystem paths under the workspace root
 *      (matches `^/.../mathran-workspace/...` or starts with the
 *      runtime-known `workspaceAbs` if we know it; we use a broad
 *      `mathran-workspace` substring guard to avoid false positives).
 *   2. End in a recognised file extension (.md, .tex, .txt, .pdf, .json,
 *      .csv, .log, .yaml/.yml, .toml, .py, .ts, .bib, .lean) — anything
 *      else is left alone.
 *   3. Are NOT already inside an `<a href="...">` tag (don't double-wrap).
 *
 * The chip is rendered as a tiny inline anchor with download semantics so
 * a click triggers the browser save-as dialog, not in-place navigation.
 */

const DOWNLOAD_EXTS = new Set([
  ".md", ".tex", ".txt", ".pdf", ".json", ".csv", ".log",
  ".yaml", ".yml", ".toml", ".py", ".ts", ".bib", ".lean",
  ".bib", ".html", ".xml", ".rst",
]);

/**
 * Lower-bound path-match regex: an absolute Unix path that contains
 * `mathran-workspace` as a path segment. Limits both false positives
 * (random `/etc/...` paths the model mentions) and false negatives
 * (unusual extensions).
 */
const PATH_RE = /(\/[A-Za-z0-9._\-/]*mathran-workspace\/[A-Za-z0-9._\-/]+)/g;

function pathExt(p: string): string {
  const i = p.lastIndexOf(".");
  if (i < 0) return "";
  return p.slice(i).toLowerCase();
}

function pathBasename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * Post-process rendered HTML: wrap matched workspace paths in an inline
 * download anchor. Avoids double-wrapping by stripping out existing
 * `<a ...>...</a>` regions before matching, then splicing them back.
 */
export function augmentHtmlWithFileChips(html: string): string {
  if (!html || typeof html !== "string") return html;
  // Mask existing <a> elements so we don't re-wrap a link the markdown
  // parser already produced.
  const placeholders: string[] = [];
  const MASK = (s: string): string => {
    const idx = placeholders.push(s) - 1;
    return `\u0000ANCHOR_${idx}\u0000`;
  };
  const masked = html.replace(/<a\s[^>]*>[\s\S]*?<\/a>/gi, MASK);

  // Also mask <code>/<pre> so a path in a code block stays literal.
  const codeMasked = masked
    .replace(/<pre[\s\S]*?<\/pre>/gi, MASK)
    .replace(/<code>[\s\S]*?<\/code>/gi, MASK);

  const augmented = codeMasked.replace(PATH_RE, (match) => {
    const ext = pathExt(match);
    if (!DOWNLOAD_EXTS.has(ext)) return match;
    const filename = pathBasename(match);
    const href = `/api/file?path=${encodeURIComponent(match)}`;
    // Render two parts: keep the literal path text + append a small
    // pill so users see both the location and the download affordance.
    return (
      `<span class="inline-file-chip">${escapeHtml(match)}` +
      ` <a href="${href}" download="${escapeHtmlAttr(filename)}" ` +
      `target="_blank" rel="noopener noreferrer" ` +
      `class="ml-1 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800 no-underline hover:bg-emerald-200" ` +
      `title="Download ${escapeHtmlAttr(filename)}">⬇ download</a></span>`
    );
  });

  // Restore masked anchors / code regions.
  return augmented.replace(/\u0000ANCHOR_(\d+)\u0000/g, (_m, idx) =>
    placeholders[Number(idx)] ?? "",
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s);
}
