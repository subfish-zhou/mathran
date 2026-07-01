/**
 * Render validator — a silent "does this markdown render cleanly?" pass
 * over LLM assistant output. Used by post-hoc retry (B1): after an
 * assistant reply lands, validate; if there are errors, auto-send a
 * follow-up user turn asking the LLM to rewrite the failing bits.
 *
 * Design:
 *   - Reuses `preprocessMath` so the same `\[…\]`, blockquote-stripping,
 *     tikz-extraction, and env-blacklist logic applies. Whatever the real
 *     render pass sees is what we validate.
 *   - Uses katex's `__parse` (returns a parse tree or throws) instead of
 *     the render pipeline's `throwOnError: false` (which silently
 *     falls back to raw text). This is the ONLY reliable way to surface
 *     which formulae actually broke.
 *   - Reports errors as { kind, snippet, message } so the caller can
 *     format them into a retry prompt: "Line snippet '…' failed
 *     because: undefined control sequence \tikzcd".
 *   - Tikz placeholders (from extractTikzEnvs) are NOT validated here —
 *     they're rendered server-side and their errors surface separately
 *     via /api/render/tikz's { ok: false, error } payload. The chat
 *     panel can wire that in later if we want tikz-error-driven retry.
 *
 * Never throws. If validation itself hits an unexpected error, returns
 * an empty error list (fail-open — better to skip retry than crash the
 * chat UI).
 */

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import katex from "katex";
import { extractTikzEnvs, __preprocessMathForTest as preprocessMath } from "./markdown";

/** One validation problem found in an assistant reply. */
export interface RenderProblem {
  /** What kind of thing failed. Determines retry-prompt wording. */
  kind: "katex-inline" | "katex-display" | "unrenderable-env";
  /** The failing source, trimmed to a manageable snippet (≤180 chars). */
  snippet: string;
  /** Human-readable failure reason. Comes from katex ParseError or an internal message. */
  message: string;
}

/** Cap the number of problems we return so a runaway LLM output doesn't
 *  produce a 500-item retry prompt. First-N covers what an LLM can
 *  meaningfully fix in one rewrite. */
const MAX_PROBLEMS = 10;

/** Hard cap on any single snippet. Long formulae (e.g. giant matrices)
 *  don't help the retry LLM — just show the head. */
const MAX_SNIPPET = 180;

// Envs KaTeX cannot render AND our tikz extractor doesn't handle (xy-pic,
// dot2tex, smallmatrix*). Kept in sync with markdown.ts's blacklist minus
// TIKZ_RENDERABLE_ENVS. This regex catches them so we can flag them as
// unrenderable in the retry prompt.
const UNRENDERABLE_ENV_RE = /\\begin\{(xy|dot2tex|smallmatrix\*)\}/g;

function truncate(s: string): string {
  const t = s.trim();
  return t.length > MAX_SNIPPET ? t.slice(0, MAX_SNIPPET) + "…" : t;
}

/**
 * Run all math blocks + envs in `markdown` through katex's parser to
 * surface failures. Returns [] when everything renders cleanly.
 */
export function validateRender(markdown: string): RenderProblem[] {
  if (!markdown || typeof markdown !== "string") return [];

  const problems: RenderProblem[] = [];

  try {
    // First lift tikz to placeholders — otherwise their bodies would
    // leak into the $$…$$ scan below and generate noise.
    const withoutTikz = extractTikzEnvs(markdown);
    // Then run the full preprocess so we scan exactly what the render
    // pass will see (blockquote-stripped, envs wrapped, etc).
    const preprocessed = preprocessMath(withoutTikz);

    // Flag unrenderable envs (xy et al.) that survived preprocessing.
    let match: RegExpExecArray | null;
    UNRENDERABLE_ENV_RE.lastIndex = 0;
    while ((match = UNRENDERABLE_ENV_RE.exec(preprocessed))) {
      if (problems.length >= MAX_PROBLEMS) break;
      const envName = match[1];
      // Grab a small snippet around the match.
      const start = Math.max(0, match.index - 40);
      const end = Math.min(preprocessed.length, match.index + 120);
      problems.push({
        kind: "unrenderable-env",
        snippet: truncate(preprocessed.slice(start, end)),
        message: `\\begin{${envName}} is not renderable in this chat surface`,
      });
    }

    // Extract $$…$$ display blocks and $…$ inline math, then parse each.
    // Order matters: display first ($$...$$ shouldn't be gobbled by $...$).
    const displayRe = /\$\$([\s\S]*?)\$\$/g;
    while ((match = displayRe.exec(preprocessed))) {
      if (problems.length >= MAX_PROBLEMS) break;
      const body = match[1].trim();
      if (body.length === 0) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (katex as any).__parse(body, { displayMode: true, throwOnError: true });
      } catch (err) {
        problems.push({
          kind: "katex-display",
          snippet: truncate(body),
          message: err instanceof Error ? err.message.split("\n")[0] : String(err),
        });
      }
    }

    // Mask out the display blocks so the inline scan doesn't see their
    // inner $ characters as inline delimiters.
    const inlineSource = preprocessed.replace(/\$\$[\s\S]*?\$\$/g, "");
    // Inline: $…$ but NOT $$ (which we already handled). Require a
    // non-$ char immediately before and after so we don't match `$$`.
    const inlineRe = /(?<!\$)\$(?!\$)([^$\n]{1,500}?)\$(?!\$)/g;
    while ((match = inlineRe.exec(inlineSource))) {
      if (problems.length >= MAX_PROBLEMS) break;
      const body = match[1].trim();
      if (body.length === 0) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (katex as any).__parse(body, { displayMode: false, throwOnError: true });
      } catch (err) {
        problems.push({
          kind: "katex-inline",
          snippet: truncate(body),
          message: err instanceof Error ? err.message.split("\n")[0] : String(err),
        });
      }
    }
  } catch {
    // Validation itself hit an error — fail-open (return no problems)
    // so we don't spam retries for a validator bug.
    return [];
  }

  return problems;
}

/**
 * Format the problem list into a self-contained "please rewrite the
 * failing bits" retry prompt. Kept in this module so the exact wording
 * lives alongside the detection logic (change one, review the other).
 */
export function buildRetryPrompt(problems: RenderProblem[]): string {
  if (problems.length === 0) return "";
  const lines: string[] = [
    "The previous reply had render errors. Please rewrite the message so all math and diagrams render cleanly. Specific problems:",
    "",
  ];
  for (const p of problems) {
    let kindLabel: string;
    switch (p.kind) {
      case "katex-inline":
        kindLabel = "inline math";
        break;
      case "katex-display":
        kindLabel = "display math";
        break;
      case "unrenderable-env":
        kindLabel = "unsupported environment";
        break;
    }
    lines.push(`- ${kindLabel}: \`${p.snippet.replace(/`/g, "'")}\``);
    lines.push(`  → error: ${p.message}`);
  }
  lines.push("");
  lines.push(
    "Guidance: use KaTeX-supported LaTeX only. For commutative diagrams prefer `\\begin{tikzcd}…\\end{tikzcd}` (server-rendered), never `\\begin{xy}` or `\\begin{dot2tex}`. For matrices use `\\begin{pmatrix}` / `\\begin{bmatrix}` not `\\begin{smallmatrix*}`. Do NOT wrap renderable math or diagrams in ```latex``` / ```tex``` code fences — that displays them as code, not rendered output. Use `\\[…\\]` (display math), `\\(…\\)` (inline math), or `\\begin{tikzcd}…\\end{tikzcd}` (diagrams) directly in prose. Keep the same overall structure and points — just fix the syntax so nothing breaks.",
  );
  return lines.join("\n");
}
