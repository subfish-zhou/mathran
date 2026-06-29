/**
 * BubbleMarkdownWithRefs — render markdown with mathran-flavoured
 * inline references (wikilinks, paper-read, workspace) turned into
 * clickable React Router links.
 *
 * Wraps `safeRenderMarkdown` (which already handles KaTeX + sanitize)
 * but FIRST rewrites the source markdown to replace each detected
 * ref with a standard `[label](href)` markdown link. The renderer
 * then walks the produced HTML on mount and intercepts clicks on
 * our marker URLs to use React Router's `navigate` instead of a
 * full page reload.
 *
 * Why rewrite source vs. interleave React components like
 * `BubbleMarkdownWithPaperCards` does: refs in wiki body are mostly
 * inline (in the middle of a sentence), and breaking the paragraph
 * into N children produces ugly layout. Native `<a>` links keep
 * cursor/wrap behaviour correct.
 *
 * 2026-06-29.
 */
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { safeRenderMarkdown } from "../lib/safe-markdown.ts";
import { detectWikiRefs, type WikiRef } from "../lib/wiki-ref-detector.ts";

export interface BubbleMarkdownWithRefsProps {
  text: string;
  /** Project slug for resolving relative refs ([[link]], @ws:effort).
   *  When omitted (e.g. global chat scope), wikilinks and @ws refs
   *  fall through to plain markdown text — only @paper-read refs are
   *  rewritten since they resolve to external arxiv/doi URLs. */
  projectSlug?: string;
  /** Extra className on the wrapper div. */
  className?: string;
  /** Known wiki page slugs in this project (for unresolvable greying).
   *  Optional — when omitted, all wikilinks render as live unless we
   *  have no way to resolve them at all (no projectSlug). */
  knownPages?: Set<string>;
  /** Known effort slugs for greying unresolvable @ws: refs. */
  knownEfforts?: Set<string>;
}

// Sentinel scheme used in href so our click handler can recognise our
// own links vs. arbitrary author-provided ones. Decoded back into a
// React Router push.
const SENTINEL = "x-mathran";

function refToHref(ref: WikiRef, projectSlug: string): string {
  switch (ref.kind) {
    case "wikilink":
      return `/${SENTINEL}/wiki/${projectSlug}/${encodeURIComponent(ref.target)}`;
    case "paper-read":
      // No per-project paper view yet — link to arxiv/doi directly.
      // paperId is `arxiv-XXX` or `doi-XXX_...` — strip prefix.
      if (ref.target.startsWith("arxiv-")) {
        return `https://arxiv.org/abs/${ref.target.slice("arxiv-".length)}`;
      }
      if (ref.target.startsWith("doi-")) {
        const doi = ref.target.slice("doi-".length).replace(/_/g, "/");
        return `https://doi.org/${doi}`;
      }
      return `/${SENTINEL}/paper/${encodeURIComponent(ref.target)}`;
    case "ws":
      return `/${SENTINEL}/effort/${projectSlug}/${encodeURIComponent(ref.target)}${
        ref.anchor ? `#${ref.anchor}` : ""
      }`;
  }
}

function refToLabel(ref: WikiRef): string {
  switch (ref.kind) {
    case "wikilink":
      return ref.label ?? ref.target;
    case "paper-read": {
      // Compact: `paper:arxiv-2306.17769` → `arxiv:2306.17769`
      let label = ref.target;
      if (label.startsWith("arxiv-")) label = `arXiv:${label.slice(6)}`;
      else if (label.startsWith("doi-")) label = `doi:${label.slice(4).replace(/_/g, "/")}`;
      return ref.anchor ? `${label}§${ref.anchor}` : label;
    }
    case "ws":
      return ref.anchor ? `${ref.target}§${ref.anchor}` : ref.target;
  }
}

function rewriteRefs(
  text: string,
  projectSlug: string,
  refs: WikiRef[],
  unresolvable: Set<number>,
): string {
  if (refs.length === 0) return text;
  // Walk in reverse so offsets remain valid after each substitution.
  let out = text;
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i];
    const href = refToHref(ref, projectSlug);
    const label = refToLabel(ref);
    const cls = unresolvable.has(i) ? "wikiref-broken" : `wikiref wikiref-${ref.kind}`;
    // marked supports `{.cls}` class attr via attribute lists in some
    // extensions but not in default; emit raw HTML — safeRenderMarkdown
    // pipes through DOMPurify which keeps `a[href]` and the `class` attr.
    const link = `<a href="${href}" class="${cls}" data-refkind="${ref.kind}">${escapeHtml(label)}</a>`;
    out = out.slice(0, ref.start) + link + out.slice(ref.start + ref.length);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function BubbleMarkdownWithRefs(
  props: BubbleMarkdownWithRefsProps,
): JSX.Element {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    let refs = detectWikiRefs(props.text);
    // When projectSlug is missing we can't resolve relative refs, so
    // drop wiki / ws kinds and keep only paper-read (which becomes an
    // absolute arxiv/doi URL).
    if (!props.projectSlug) {
      refs = refs.filter((r) => r.kind === "paper-read");
    }
    // Detect unresolvable refs for visual indication.
    const unresolvable = new Set<number>();
    refs.forEach((r, i) => {
      if (r.kind === "wikilink" && props.knownPages && !props.knownPages.has(r.target)) {
        unresolvable.add(i);
      }
      if (r.kind === "ws" && props.knownEfforts && !props.knownEfforts.has(r.target)) {
        unresolvable.add(i);
      }
    });
    const rewritten = rewriteRefs(props.text, props.projectSlug ?? "", refs, unresolvable);
    return safeRenderMarkdown(rewritten);
  }, [props.text, props.projectSlug, props.knownPages, props.knownEfforts]);

  // Intercept clicks on our sentinel links and route via React Router.
  // Use the `data-refkind` attribute as the unambiguous signal — the
  // portal SPA shim rewrites href paths to prefix `/mathran` so a
  // simple startsWith check on the href is unreliable in production.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handler = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const a = target.closest("a[data-refkind]") as HTMLAnchorElement | null;
      if (!a) return;
      const kind = a.getAttribute("data-refkind");
      const href = a.getAttribute("href");
      if (!href || !kind) return;
      // For broken refs do nothing — the CSS handles cursor:not-allowed.
      if (a.classList.contains("wikiref-broken")) {
        ev.preventDefault();
        return;
      }
      // paper-read refs are EXTERNAL URLs (arxiv.org / doi.org) — let
      // the browser handle them in the current tab (or cmd-click for new).
      if (kind === "paper-read" && /^https?:\/\//.test(href)) return;
      ev.preventDefault();
      // Pull the sentinel-prefixed segment out of the href (might be
      // `/x-mathran/...` OR `/mathran/x-mathran/...` after portal shim).
      const sentinelIdx = href.indexOf(`/${SENTINEL}/`);
      if (sentinelIdx === -1) return;
      const rest = href.slice(sentinelIdx + `/${SENTINEL}/`.length);
      const [kind2, ...parts] = rest.split("/");
      switch (kind2) {
        case "wiki": {
          const [projectSlug, ...rest2] = parts;
          const page = rest2.join("/");
          navigate(`/projects/${projectSlug}/wiki/${decodeURIComponent(page)}`);
          break;
        }
        case "effort": {
          const [projectSlug, effortSlugEnc] = parts;
          // Effort doc URL: /projects/<slug>/effort/<effort>/document.
          // Strip any #anchor — React Router can handle scrollIntoView later.
          const effortSlug = decodeURIComponent(effortSlugEnc.split("#")[0]);
          navigate(
            `/projects/${projectSlug}/effort/${effortSlug}/document`,
          );
          break;
        }
        case "paper": {
          // Fallback only — arxiv/doi already returned `https://…`.
          window.open(`https://www.google.com/search?q=${encodeURIComponent(parts[0])}`, "_blank");
          break;
        }
      }
    };
    root.addEventListener("click", handler);
    return () => root.removeEventListener("click", handler);
  }, [navigate]);

  return (
    <div
      ref={rootRef}
      className={`md ${props.className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
