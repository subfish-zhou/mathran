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

// 2026-06-30 — syntax highlighting (mathub parity). highlight.js core +
// the languages that actually show up in math-research workspaces: the
// proof assistants (lean), the scripting the model writes (python/bash/
// ts/js), data formats (json/yaml/toml), and the systems langs that come
// up in effort scratch work. Importing `core` + explicit registration
// (rather than the 600KB `highlight.js` auto-bundle) keeps the vendor
// chunk small. github-dark theme matches mathub's dark code blocks.
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import rust from "highlight.js/lib/languages/rust";
import latex from "highlight.js/lib/languages/latex";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import haskell from "highlight.js/lib/languages/haskell";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import ocaml from "highlight.js/lib/languages/ocaml";
import julia from "highlight.js/lib/languages/julia";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("python", python);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("latex", latex);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("haskell", haskell);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("ocaml", ocaml);
hljs.registerLanguage("julia", julia);
// lean4 has no hljs grammar; latex is the least-bad fallback for its
// `\theorem`-ish syntax + unicode operators (same choice mathub made).
hljs.registerLanguage("lean4", latex);
hljs.registerLanguage("lean", latex);

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
/**
 * Envs KaTeX cannot render but LLMs love emitting inside \[…\] / bare
 * blocks. Wrapping them in $$…$$ triggers a KaTeX parse error that
 * cascades and eats the following paragraph as leftover math body.
 * Leave them alone so marked renders them as prose (visually ugly but
 * doesn't destroy the surrounding text). Ordered by frequency in real
 * math LLM output.
 *
 * 2026-07-01 — added after alpha's c-eb4a403e chat destroyed the "More
 * explicitly:" numbered list following a tikzcd diagram.
 *
 * 2026-07-01 (upgrade) — subset of these envs is now handled by
 * `extractTikzEnvs`, which lifts them into placeholder <div>s the
 * SPA replaces with real SVG rendered server-side via node-tikzjax.
 * If extraction runs FIRST, this KaTeX-skip list only catches envs
 * that aren't in TIKZ_RENDERABLE_ENVS (e.g. `xy` for XY-pic).
 */
const UNSUPPORTED_KATEX_ENVS = /\\begin\{(tikzcd|tikzpicture|circuitikz|forest|dot2tex|smallmatrix\*|xy)\}/;

function containsUnsupportedEnv(text: string): boolean {
  return UNSUPPORTED_KATEX_ENVS.test(text);
}

/**
 * TikZ env names that we route to the server-side node-tikzjax renderer.
 * A superset of the KaTeX-unsupported list, minus envs the renderer
 * itself can't handle (e.g. `xy`, which is XY-pic and needs a different
 * TeX package pipeline).
 */
const TIKZ_RENDERABLE_ENVS = new Set(["tikzcd", "tikzpicture", "circuitikz", "forest", "chemfig"]);

/**
 * Escape a string for safe embedding as an HTML attribute value.
 * Deliberately duplicated from the internal escapeHtmlAttr in this
 * file so `extractTikzEnvs` doesn't rely on later-declared helpers.
 */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Extract every `\begin{tikzcd}...\end{tikzcd}` (and related renderable
 * TikZ envs) into a placeholder `<div data-tikz-src="…">Rendering…</div>`
 * that the SPA replaces with SVG at render time (via POST /api/render/tikz).
 *
 * MUST run BEFORE the `\[…\]` → `$$…$$` and bare-env → `$$…$$` steps so
 * the KaTeX preprocessor doesn't try to swallow the tikz body.
 *
 * The extraction is idempotent: source already lifted to a placeholder
 * (which no longer contains `\begin{tikz…}`) is skipped.
 */
export function extractTikzEnvs(input: string): string {
  if (!input.includes("\\begin{")) return input;
  // First, strip a wrapping math delimiter if the whole tikz env is the only
  // thing inside. This is the shape alpha's c-eb4a403e chat produced:
  //     \[
  //     \begin{tikzcd}...\end{tikzcd}
  //     \]
  // Leaving the delimiter in place after we've extracted the env would
  // leave an empty math block — worse, if the delimiter is $$…$$, the
  // env's placeholder <div> gets swallowed by KaTeX after we replace it,
  // which renders the raw div attributes as italic math text.
  // (2026-07-01 D bug: LLM returned $$\begin{tikzcd}…\end{tikzcd}$$ as
  //  a fix patch, tikzcd got extracted to <div>, then the surrounding
  //  $$…$$ fed the div into KaTeX. Screenshot showed 'div class="tikz-
  //  placeholder"…' rendered as pretty italic math variables.)
  let text = input;
  // \[…\] wrap
  text = text.replace(
    /\\\[\s*(\\begin\{([a-zA-Z0-9*]+)\}[\s\S]*?\\end\{\2\})\s*\\\]/g,
    (whole, env: string, name: string) => (TIKZ_RENDERABLE_ENVS.has(name) ? env : whole),
  );
  // $$…$$ wrap
  text = text.replace(
    /\$\$\s*(\\begin\{([a-zA-Z0-9*]+)\}[\s\S]*?\\end\{\2\})\s*\$\$/g,
    (whole, env: string, name: string) => (TIKZ_RENDERABLE_ENVS.has(name) ? env : whole),
  );
  // Now extract each renderable env.
  text = text.replace(
    /\\begin\{([a-zA-Z0-9*]+)\}[\s\S]*?\\end\{\1\}/g,
    (whole, name: string) => {
      if (!TIKZ_RENDERABLE_ENVS.has(name)) return whole;
      // Base64-encode the source so it survives round-tripping through
      // marked's HTML sanitizer + DOMPurify without ever being parsed as
      // markdown / TeX / HTML. The SPA decodes it back at render time.
      const b64 = typeof btoa === "function"
        ? btoa(unescape(encodeURIComponent(whole)))
        : Buffer.from(whole, "utf8").toString("base64");
      const shortHint = escapeAttr(name);
      return `\n\n<div class="tikz-placeholder" data-tikz-src="${b64}" data-tikz-env="${shortHint}">Rendering ${shortHint}…</div>\n\n`;
    },
  );
  return text;
}

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

  // 2026-07-01 — Lift renderable TikZ envs (tikzcd, tikzpicture, etc.)
  // into <div class="tikz-placeholder"> tags BEFORE any \[…\] / $$…$$
  // rewriting, so KaTeX's parser never sees the tikz body. The SPA
  // replaces these placeholders with server-rendered SVG at mount time.
  masked = extractTikzEnvs(masked);

  // Display first (so `\[` doesn't get caught as `\(` afterwards).
  // CRITICAL: wrap with surrounding BLANK LINES so the resulting $$
  // block is its own markdown paragraph. Without that, an input like
  //   `If\n\[ math \]\nthen ...`
  // becomes `If\n$$\n math \n$$\nthen ...` — a single paragraph token
  // in marked, and the marked-katex-extension block-level rule never
  // matches because it requires the $$ tokens to live on their own
  // line at paragraph-boundary level. Result: the SPA shows literal
  // `$$ math $$` text instead of rendered KaTeX. (2026-06-29 wiki bug.)
  //
  // 2026-07-01 (Bug 1, alpha c-2735c92c chat):
  //   Also strip leading blockquote markers (`> ` at line start) from
  //   the extracted body. Without stripping, an LLM that puts a
  //   conjecture inside a blockquote:
  //     > \[
  //     > \ell(R) > r
  //     > \]
  //   produced `$$\n> \ell(R) > r\n$$` — KaTeX sees `>` as garbage.
  //
  // 2026-07-01 (Bug 2, alpha c-eb4a403e chat):
  //   Skip envs KaTeX doesn't support (tikzcd et al.); wrapping them
  //   in $$…$$ triggers a KaTeX parse error that cascades and eats the
  //   following paragraph as leftover math body.
  masked = masked.replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => {
    // Strip leading blockquote marker from every line in the body
    // (blockquote-aware). Handles both `> ` and `>` (no space).
    const cleaned = body.replace(/^[ \t]*>[ \t]?/gm, "");
    if (containsUnsupportedEnv(cleaned)) {
      // Leave the original \[…\] intact so marked renders it as a
      // fenced-ish plain block; better broken-diagram-as-text than
      // broken-diagram + eaten paragraph.
      return `\\[${body}\\]`;
    }
    return `\n\n$$\n${cleaned.trim()}\n$$\n\n`;
  });
  // Inline.
  masked = masked.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => `$${body}$`);

  // Bare LaTeX envs not already wrapped in $$: detect a `\begin{...}` whose
  // nearest preceding non-whitespace chars are NOT `$$`. We just wrap each
  // env in $$ pairs and add the blanks-line guard for the same reason as
  // above (block math must stand alone in marked).
  //
  // 2026-07-01 — Skip unsupported envs here too (same reasoning as above).
  masked = masked.replace(
    /(^|[^$])(\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\})(?!\$)/g,
    (_m, pre, env) => {
      if (containsUnsupportedEnv(env)) return `${pre}${env}`;
      return `${pre}\n\n$$\n${env}\n$$\n\n`;
    },
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
  // 2026-06-30 — syntax-highlighted code blocks (mathub parity). Custom
  // renderer matches mathub's LatexRenderer output shape so the same CSS
  // (.code-block-wrapper / .code-lang-label / .code-copy-btn) styles both:
  //   <div class="code-block-wrapper">
  //     <span class="code-lang-label">python</span>
  //     <button class="code-copy-btn" data-code="…">Copy</button>
  //     <pre><code class="hljs">…highlighted…</code></pre>
  //   </div>
  // The copy button carries the raw (escaped) source in data-code; a
  // delegated click handler in the render host reads it (see ChatPanel /
  // WikiPanel copy wiring). Highlighting is best-effort: an unknown lang
  // falls back to highlightAuto, and any hljs throw degrades to plain
  // escaped text so a bad snippet never blanks the whole document.
  const renderer = new marked.Renderer();
  renderer.code = function ({ text, lang }: { text: string; lang?: string }): string {
    const language = (lang ?? "").match(/^\S+/)?.[0] ?? "";
    let highlighted: string;
    try {
      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(text, { language }).value;
      } else {
        highlighted = hljs.highlightAuto(text).value;
      }
    } catch {
      highlighted = escapeHtmlForCode(text);
    }
    const escapedForAttr = escapeHtmlForCode(text).replace(/"/g, "&quot;");
    const langLabel = language
      ? `<span class="code-lang-label">${escapeHtmlForCode(language)}</span>`
      : "";
    return (
      `<div class="code-block-wrapper">${langLabel}` +
      `<button class="code-copy-btn" data-code="${escapedForAttr}" title="Copy">Copy</button>` +
      `<pre><code class="hljs">${highlighted}</code></pre></div>\n`
    );
  };
  marked.use({ renderer });
  marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
}

/**
 * Minimal HTML escaper for code text + the `data-code` attribute. Kept
 * local (not pulled from a util) so this module has no extra deps and
 * the escaping rules stay obvious next to the renderer that uses them.
 */
function escapeHtmlForCode(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Decode the HTML entities we injected into the `data-code` attribute
 * (escapeHtmlForCode + the &quot; pass in the renderer) back to the raw
 * source the user wants on their clipboard.
 */
function decodeCodeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * One document-level click delegate for every `.code-copy-btn` rendered by
 * the marked code renderer. Idempotent: a module-scope flag stops repeated
 * imports / Vite HMR from stacking listeners. On click it copies the raw
 * snippet (from `data-code`) and flips the button to a "Copied" state for
 * ~1.2s via the `.copied` class. SSR / non-browser imports are a no-op.
 */
let copyDelegateWired = false;
function ensureCodeCopyDelegate(): void {
  if (copyDelegateWired) return;
  if (typeof document === "undefined") return;
  copyDelegateWired = true;
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const btn = target?.closest?.(".code-copy-btn") as HTMLElement | null;
    if (!btn) return;
    const raw = decodeCodeAttr(btn.getAttribute("data-code") ?? "");
    const restore = (ok: boolean): void => {
      const prev = btn.textContent;
      btn.textContent = ok ? "Copied" : "Failed";
      btn.classList.toggle("copied", ok);
      window.setTimeout(() => {
        btn.textContent = prev ?? "Copy";
        btn.classList.remove("copied");
      }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(raw).then(
        () => restore(true),
        () => restore(false),
      );
    } else {
      // Fallback for non-secure contexts where the async clipboard API is
      // unavailable: a hidden textarea + execCommand("copy").
      try {
        const ta = document.createElement("textarea");
        ta.value = raw;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        restore(true);
      } catch {
        restore(false);
      }
    }
  });
}

// Side-effect: importing this module registers immediately.
ensureMarkdownConfigured();
// Side-effect: wire the global Copy-button delegate once. Because every
// markdown render host (.md container in ChatPanel / WikiPanel /
// EffortDocumentPanel / ActivePlanPanel …) injects the same
// `.code-copy-btn[data-code]` markup, a single document-level click
// listener serves them all — no per-component wiring. Guarded so HMR /
// repeated imports don't stack listeners.
ensureCodeCopyDelegate();

// Re-export so callers don't have to import `marked` themselves if they
// don't want to.
export { marked };

// Exported for unit tests.
export { preprocessMath as __preprocessMathForTest };
