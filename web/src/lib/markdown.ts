/**
 * v0.17 mathub parity follow-up — central markdown / KaTeX registration.
 *
 * Why this file exists:
 *   Previously `marked.use(markedKatex(...))` was called inside
 *   `ChatPanel.tsx`. Because `marked` is a module-level singleton but
 *   React only loads modules lazily, any component rendered before
 *   ChatPanel ever mounts (e.g. EffortDocumentPanel, ActivePlanPanel,
 *   WikiPanel, ThreadDrawer, PlanRunOverlay) would call `marked.parse`
 *   without the KaTeX extension being registered yet.
 *
 *   We also need to support LLM-native math delimiters, not just the
 *   markdown-only `$...$` / `$$...$$`. GPT-5 / Claude / Codex routinely
 *   emit `\(...\)` (inline) and `\[...\]` (display) and `\begin{...}`
 *   environments. `marked-katex-extension` does not handle those by
 *   default, so we normalise the input to `$...$` / `$$...$$` in a
 *   preprocess hook before the tokenizer ever sees the text.
 *
 * Single source of truth: import this file once from `main.tsx`.
 */
import { marked } from "marked";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";

/**
 * Strip YAML frontmatter from the start of a markdown string. Convention:
 *
 *   ---
 *   key: value
 *   ---
 *   # actual markdown body…
 *
 * Wiki pages already have frontmatter peeled off server-side (the API
 * returns `body` + `frontmatter` separately), but effort document.md
 * files are fetched verbatim. Without stripping, the yaml block
 * renders as one ugly `<p>` "id: ... title: ...".
 *
 * Rules:
 *   - Must start at the very first character (no leading whitespace) so
 *     we never accidentally eat a mid-document thematic break (`---`).
 *   - Closing `---` must live on its own line.
 *   - If no closing fence we return the input unchanged (better an
 *     ugly preview than a silently truncated document).
 */
export function stripFrontmatter(src: string): string {
  if (!src || typeof src !== "string") return src;
  if (!src.startsWith("---")) return src;
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!m) return src;
  return src.slice(m[0].length);
}

/**
 * Heading-attribute syntax: `## Heading {#my-id}` → `<h2 id="my-id">…`.
 *
 * Pandoc / Hugo / Jekyll / Obsidian wiki style. mathran's init-project
 * writes these so cross-effort `@ws:effort-id#section-anchor` refs can
 * jump to the right H2. Default marked doesn't recognise the suffix,
 * so it renders as literal "{#section-name}" text after the heading.
 *
 * We register a marked extension that:
 *  - matches `(#+\s+heading text\s+)\{#([a-z0-9._-]+)\}\s*$` on each
 *    heading line
 *  - emits the same HTML marked would have, but with the explicit `id`
 *    attribute injected
 *
 * The `{#…}` syntax is also stripped from non-heading paragraphs the
 * same way for symmetry (e.g. a bullet with a trailing `{#xx}` that
 * the model emits to be link-targetable).
 *
 * Anchor charset matches our SAFE_SLUG_PATTERN cousin: lowercase
 * alphanumerics, `-`, `_`, `.`.
 */
function preprocessHeadingAnchors(input: string): string {
  if (!input || typeof input !== "string") return input;
  if (!input.includes("{#")) return input; // fast path
  // Mask code fences + inline code so we never rewrite anchor-looking
  // text inside literal samples.
  const placeholders: string[] = [];
  const MASK = (s: string): string => {
    const idx = placeholders.push(s) - 1;
    return `\u0000ANCHORMASK_${idx}\u0000`;
  };
  let masked = input.replace(/```[\s\S]*?```/g, MASK);
  masked = masked.replace(/(^|[^`])(`+)(?!`)([\s\S]*?[^`])\2(?!`)/g, (_m, pre, ticks, body) =>
    pre + MASK(`${ticks}${body}${ticks}`),
  );
  // Heading line: `## title {#anchor}` → store the id by inlining an
  // anchor placeholder marked picks up as raw HTML inside the heading.
  // marked passes through inline raw HTML by default, and an empty
  // `<a id="..."></a>` plus the heading text gives us the same scroll
  // target as a real `id` attribute on `<h2>`.
  masked = masked.replace(
    /^(#{1,6}[ \t]+)(.+?)[ \t]+\{#([a-z0-9._-]+)\}[ \t]*$/gm,
    (_m, hashes, text, anchor) => `${hashes}<a id="${anchor}"></a>${text}`,
  );
  // Stray inline `{#anchor}` outside headings: strip silently so it
  // doesn't bleed into rendered text. The id is lost but the prose
  // stays clean. (Could also wrap as `<a id="…"></a>` — chose strip
  // because non-heading anchors are rare and noisy when wrong.)
  masked = masked.replace(/[ \t]*\{#[a-z0-9._-]+\}/g, "");
  masked = masked.replace(/\u0000ANCHORMASK_(\d+)\u0000/g, (_m, idx) => placeholders[Number(idx)]);
  return masked;
}

/**
 * Normalise LLM-flavoured math delimiters to the `$...$` / `$$...$$`
 * forms that `marked-katex-extension` recognises.
 *
 * Rules:
 *   1. `\[...\]`  →  `$$...$$`   (display math)
 *   2. `\(...\)`  →  `$...$`     (inline math)
 *
 * Code spans / code fences are protected: any region between a pair of
 * backticks is masked out before the regex runs, then restored, so the
 * literal text inside ``` blocks survives untouched.
 *
 * NOTE on `\begin{...}\end{...}`: KaTeX consumes those once the surrounding
 * `$$...$$` wraps them. We wrap any top-level environment in `$$...$$` if it
 * isn't already inside math delimiters, which lets GPT-style `\begin{equation}`
 * render without forcing the LLM to add explicit `$$`.
 */
function preprocessMath(input: string): string {
  if (!input || typeof input !== "string") return input;
  // Fast path: nothing to do
  if (!input.includes("\\(") && !input.includes("\\[") && !input.includes("\\begin{")) {
    return input;
  }

  // Mask code (fences first, then inline spans) so we don't rewrite math
  // delimiters that appear inside literal code samples.
  const placeholders: string[] = [];
  const MASK = (s: string): string => {
    const idx = placeholders.push(s) - 1;
    return `\u0000CODEMASK_${idx}\u0000`;
  };
  let masked = input.replace(/```[\s\S]*?```/g, MASK);
  masked = masked.replace(/(^|[^`])(`+)(?!`)([\s\S]*?[^`])\2(?!`)/g, (_m, pre, ticks, body) =>
    pre + MASK(`${ticks}${body}${ticks}`),
  );

  // Display first (so `\[` doesn't get caught as `\(` afterwards).
  // CRITICAL: wrap with surrounding BLANK LINES so the resulting $$
  // block is its own markdown paragraph. Without that, an input like
  //   `If\n\[ math \]\nthen ...`
  // becomes `If\n$$\n math \n$$\nthen ...` — a single paragraph token
  // in marked, and the marked-katex-extension block-level rule never
  // matches because it requires the $$ tokens to live on their own
  // line at paragraph-boundary level. Result: the SPA shows literal
  // `$$ math $$` text instead of rendered KaTeX. (2026-06-29 wiki bug.)
  masked = masked.replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => `\n\n$$\n${body.trim()}\n$$\n\n`);
  // Inline.
  masked = masked.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => `$${body}$`);

  // Bare LaTeX envs not already wrapped in $$: detect a `\begin{...}` whose
  // nearest preceding non-whitespace chars are NOT `$$`. We just wrap each
  // env in $$ pairs and add the blanks-line guard for the same reason as
  // above (block math must stand alone in marked).
  masked = masked.replace(
    /(^|[^$])(\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\})(?!\$)/g,
    (_m, pre, env) => `${pre}\n\n$$\n${env}\n$$\n\n`,
  );

  // Collapse 3+ consecutive newlines that might have been introduced by
  // the wrapping above to keep diff-readability in the rendered output.
  masked = masked.replace(/\n{3,}/g, "\n\n");

  // Restore code regions.
  masked = masked.replace(/\u0000CODEMASK_(\d+)\u0000/g, (_m, idx) => placeholders[Number(idx)]);
  return masked;
}

/**
 * One-time global registration. Safe to import many times; `marked.use` with
 * the same extension config is idempotent in practice for our needs because
 * the SPA bundles a single `marked` instance.
 */
let registered = false;
export function ensureMarkdownConfigured(): void {
  if (registered) return;
  registered = true;
  marked.use({
    hooks: {
      preprocess(markdown: string) {
        return preprocessMath(preprocessHeadingAnchors(markdown));
      },
    },
  });
  marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
}

// Side-effect: importing this module registers immediately.
ensureMarkdownConfigured();

// Re-export so callers don't have to import `marked` themselves if they
// don't want to.
export { marked };

// Exported for unit tests.
export { preprocessMath as __preprocessMathForTest };
