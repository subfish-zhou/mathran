/**
 * safeRenderMarkdown — render markdown to HTML safely.
 *
 * Wraps `marked.parse` with `DOMPurify.sanitize` so the model can't
 * smuggle <script>, javascript: URLs, on*= handlers, <iframe>, etc.
 * into a `dangerouslySetInnerHTML` consumer.
 *
 * Threat model: the assistant's reply text is attacker-controlled
 * because web_fetch can pull arbitrary HTML the model might quote
 * back, and attachment file content (.md, etc.) flows through the
 * model. Even though subfish is the only user, an XSS in the chat
 * panel would give a prompt-injected page full access to the SPA's
 * fetch credentials → /api/file → arbitrary workspace read.
 *
 * DOMPurify defaults strip:
 *   - <script>, <iframe>, <object>, <embed>, <link>, <meta>, <style>
 *   - javascript:, vbscript:, data: (except images), file: URLs
 *   - on*= event handlers
 *   - <svg onload=...>, <math onload=...> etc.
 *
 * We keep KaTeX-rendered math safe by listing the spans / classes
 * KaTeX uses in the allowed-attrs / allowed-tags lists (KaTeX itself
 * renders trusted output from its own parser; we don't re-sanitize
 * those subtrees).
 */

import { marked } from "marked";
import DOMPurify, { type Config } from "dompurify";

// Single shared config so we don't re-create the policy on every render.
// KaTeX uses <span class="katex">, <math>, <semantics>, <mrow>, etc.
// We allow them by listing both tag names and the standard math tags
// in ALLOWED_TAGS. DOMPurify's default tag set covers everything else
// markdown emits (h1-6, p, pre, code, blockquote, ul/ol/li, a, em/strong,
// table/thead/tbody/tr/td/th, hr, br, img).
const PURIFY_CONFIG: Config = {
  // Math: KaTeX uses MathML output mode too (annotation, semantics, mrow…).
  // Adding to the default allow-list rather than replacing it.
  ADD_TAGS: [
    "math",
    "semantics",
    "mrow",
    "mn",
    "mi",
    "mo",
    "mfrac",
    "msup",
    "msub",
    "msubsup",
    "mroot",
    "msqrt",
    "mtext",
    "mspace",
    "annotation",
    "mtable",
    "mtr",
    "mtd",
    "mstyle",
    "mpadded",
    "menclose",
    "mover",
    "munder",
    "munderover",
  ],
  ADD_ATTR: ["aria-hidden", "encoding", "mathvariant", "mathcolor", "displaystyle"],
  // Force string return (default) — TS thinks RETURN_DOM might return DOM.
  RETURN_TRUSTED_TYPE: false,
};

export function safeRenderMarkdown(src: string | null | undefined): string {
  if (!src) return "";
  const raw = marked.parse(src) as string;
  // sanitize returns string when RETURN_DOM is not set (the default).
  return DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string;
}
