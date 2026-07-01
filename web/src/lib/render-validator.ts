/**
 * Render validator — finds broken math / TikZ blocks in raw LLM markdown.
 *
 * 2026-07-01 (D0 refactor for partial-edit retry):
 *   The previous cut only exposed opaque `snippet` strings (truncated bodies
 *   after preprocessing) — good enough for "please rewrite the whole
 *   message" retry, but useless if you want to surgically replace only
 *   the broken bits in the original markdown.
 *
 *   This version reports each problem with an exact `[start, end]` span
 *   into the raw markdown the assistant produced. Callers can apply
 *   patches by slicing directly: `md.slice(0, start) + fix + md.slice(end)`.
 *
 * The scan operates ON RAW markdown (no preprocessing) so spans stay
 * canonical:
 *   - Skips code fences and inline code (LLM using `\begin{tikzcd}` inside
 *     a ```latex``` fence explicitly means "show as code").
 *   - Matches every math/env pattern that our renderer would eventually
 *     try to compile: `\[…\]`, `\(…\)`, `$$…$$`, `$…$`, `\begin{env}…\end{env}`.
 *   - Runs `katex.__parse` on each body to detect syntax errors, and
 *     tags known-unrenderable envs (xy, dot2tex) explicitly.
 *   - Tikz-renderable envs (tikzcd, tikzpicture, …) are NOT reported —
 *     they route to server-side node-tikzjax via /api/render/tikz, so
 *     failures surface separately.
 *
 * Every problem carries the ORIGINAL raw source in `matched` (so the
 * retry prompt can quote it verbatim) plus the `body` that was parsed
 * (so the retry LLM knows what's inside the delimiters). Guarantee:
 * `raw.slice(problem.span[0], problem.span[1]) === problem.matched`
 * exactly, so patches apply without ambiguity.
 */

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import katex from "katex";

/** Kind of render failure. Distinguishes retry-prompt wording. */
export type RenderProblemKind =
  | "katex-display"    // $$…$$ or \[…\] body failed katex.__parse
  | "katex-inline"     // $…$ or \(…\) body failed katex.__parse
  | "unrenderable-env" // \begin{xy}…\end{xy} or similar — KaTeX can't render + not in tikz whitelist
  | "bare-env";        // A LaTeX env sitting bare (not inside math delimiters) that failed to parse

/** One validation problem, with an exact character range into the raw input. */
export interface RenderProblem {
  kind: RenderProblemKind;
  /** [start, end) into the raw markdown — the WHOLE matched pattern including delimiters. */
  span: [number, number];
  /** The exact source text at that span — for verbatim quoting in retry prompts. */
  matched: string;
  /** The inner body without delimiters (e.g. body of $$…$$ is what's between the $$s). */
  body: string;
  /** Human-readable failure reason. From katex ParseError or an internal message. */
  message: string;
}

/** Cap problems returned so a runaway output doesn't produce a 500-item retry prompt. */
export const MAX_PROBLEMS = 10;

/** Envs KaTeX cannot render AND our tikz extractor doesn't handle. */
const UNRENDERABLE_ENVS = new Set(["xy", "dot2tex", "smallmatrix*"]);

/** Envs that route to server-side node-tikzjax (skipped by this validator —
 *  their failures surface separately via /api/render/tikz's error payload). */
const TIKZ_RENDERABLE_ENVS = new Set(["tikzcd", "tikzpicture", "circuitikz", "forest", "chemfig"]);

/** Regex fragments for masking code so math scanners don't dip inside. */
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /(?<!`)`(?!`)([^`\n]{1,500}?)(?<!`)`(?!`)/g;

/**
 * Compute an array of `[start, end)` masked ranges into `text` that math
 * scanners must skip. Both code fences and inline `code` are masked.
 */
function computeMaskedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text))) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  INLINE_CODE_RE.lastIndex = 0;
  while ((m = INLINE_CODE_RE.exec(text))) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

/** True iff `pos` falls inside any masked range. Ranges must be sorted. */
function isMasked(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (pos < s) return false;      // ranges sorted, no later range starts earlier
    if (pos >= s && pos < e) return true;
  }
  return false;
}

/**
 * Try to parse `body` as KaTeX math. Returns null on success, error message on failure.
 */
function tryParseKatex(body: string, displayMode: boolean): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (katex as any).__parse(body, { displayMode, throwOnError: true });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
}

/**
 * Strip a leading blockquote marker (`> ` or `>`) from every line of `body`,
 * matching what preprocessMath does at render time. Without this an LLM
 * emitting a blockquoted formula would render broken here even though the
 * live renderer would strip the `>`s.
 */
function stripBlockquoteMarker(body: string): string {
  return body.replace(/^[ \t]*>[ \t]?/gm, "");
}

/** The main scan. Returns [] if input renders clean. Never throws. */
export function validateRender(raw: string): RenderProblem[] {
  if (!raw || typeof raw !== "string") return [];

  const problems: RenderProblem[] = [];
  const masked = computeMaskedRanges(raw);

  try {
    // ── \[…\] display math ─────────────────────────────────────────────
    // Non-greedy, spans lines. If body is a whole \begin{…}\end{…} env
    // we still report it here — its span is the whole \[…\] pair.
    const bracketRe = /\\\[([\s\S]*?)\\\]/g;
    let m: RegExpExecArray | null;
    while ((m = bracketRe.exec(raw)) && problems.length < MAX_PROBLEMS) {
      if (isMasked(m.index, masked)) continue;
      const body = stripBlockquoteMarker(m[1]).trim();
      if (body.length === 0) continue;
      // A wrapping \[ tikzcd \] is handled by extractTikzEnvs at render
      // time — server-side render. Skip so we don't flag it as broken.
      if (bodyIsSingleTikzEnv(body)) continue;
      const err = tryParseKatex(body, true);
      if (err) {
        problems.push({
          kind: "katex-display",
          span: [m.index, m.index + m[0].length],
          matched: m[0],
          body,
          message: err,
        });
      }
    }

    // ── $$…$$ display math ─────────────────────────────────────────────
    const dollarDisplayRe = /\$\$([\s\S]*?)\$\$/g;
    while ((m = dollarDisplayRe.exec(raw)) && problems.length < MAX_PROBLEMS) {
      if (isMasked(m.index, masked)) continue;
      const body = stripBlockquoteMarker(m[1]).trim();
      if (body.length === 0) continue;
      if (bodyIsSingleTikzEnv(body)) continue;
      const err = tryParseKatex(body, true);
      if (err) {
        problems.push({
          kind: "katex-display",
          span: [m.index, m.index + m[0].length],
          matched: m[0],
          body,
          message: err,
        });
      }
    }

    // ── \(…\) inline math ──────────────────────────────────────────────
    const parenRe = /\\\(([\s\S]*?)\\\)/g;
    while ((m = parenRe.exec(raw)) && problems.length < MAX_PROBLEMS) {
      if (isMasked(m.index, masked)) continue;
      const body = m[1].trim();
      if (body.length === 0) continue;
      const err = tryParseKatex(body, false);
      if (err) {
        problems.push({
          kind: "katex-inline",
          span: [m.index, m.index + m[0].length],
          matched: m[0],
          body,
          message: err,
        });
      }
    }

    // ── $…$ inline math (with lookarounds to avoid $$) ─────────────────
    // Non-greedy body without newlines or unescaped $. We conservatively
    // require the closing $ to be immediately followed by a non-$ so
    // display-math $$ pairs aren't chopped.
    const dollarInlineRe = /(?<!\$)\$(?!\$)([^$\n]{1,500}?)\$(?!\$)/g;
    while ((m = dollarInlineRe.exec(raw)) && problems.length < MAX_PROBLEMS) {
      if (isMasked(m.index, masked)) continue;
      const body = m[1].trim();
      if (body.length === 0) continue;
      const err = tryParseKatex(body, false);
      if (err) {
        problems.push({
          kind: "katex-inline",
          span: [m.index, m.index + m[0].length],
          matched: m[0],
          body,
          message: err,
        });
      }
    }

    // ── Bare \begin{env}…\end{env} outside math delimiters ─────────────
    // If the env is tikz-renderable we skip (server render owns it).
    // If the env is a KaTeX-supported one (aligned, pmatrix, …) most
    // won't parse standalone but WILL parse when wrapped in $$…$$; we
    // still try both to be conservative. If it's an explicit unrenderable
    // env (xy, dot2tex) we always flag.
    // Env names allow letters, digits, and '*' (e.g. `align*`, `dot2tex`,
    // `align*`). Original regex used [a-zA-Z*]+ and missed dot2tex.
    const envRe = /\\begin\{([a-zA-Z0-9*]+)\}([\s\S]*?)\\end\{\1\}/g;
    while ((m = envRe.exec(raw)) && problems.length < MAX_PROBLEMS) {
      if (isMasked(m.index, masked)) continue;
      // If ANY math delimiter fully encloses this env we already
      // reported it under the delimiter's own scanner above.
      if (isInsideMathDelimiter(raw, m.index, m.index + m[0].length)) continue;
      const envName = m[1];
      const body = m[2];
      if (TIKZ_RENDERABLE_ENVS.has(envName)) continue;
      if (UNRENDERABLE_ENVS.has(envName)) {
        problems.push({
          kind: "unrenderable-env",
          span: [m.index, m.index + m[0].length],
          matched: m[0],
          body,
          message: `\\begin{${envName}} is not renderable in this chat surface (KaTeX doesn't support it)`,
        });
        continue;
      }
      // Best-effort: try parsing the whole \begin…\end block as display math.
      // A LOT of KaTeX-supported envs will happily parse this way.
      const err = tryParseKatex(m[0], true);
      if (err) {
        problems.push({
          kind: "bare-env",
          span: [m.index, m.index + m[0].length],
          matched: m[0],
          body,
          message: err,
        });
      }
    }
  } catch {
    // Fail-open — better to skip retry than crash the chat UI.
    return [];
  }

  // Sort by start position so callers can iterate deterministically.
  problems.sort((a, b) => a.span[0] - b.span[0]);
  return problems;
}

/** True iff the body is essentially just one \begin{tikz…}\end{tikz…} env
 *  (with optional whitespace) — those are handled by the tikz extractor
 *  at render time. */
function bodyIsSingleTikzEnv(body: string): boolean {
  const m = body.match(/^\\begin\{([a-zA-Z*]+)\}[\s\S]*\\end\{\1\}$/);
  return !!m && TIKZ_RENDERABLE_ENVS.has(m[1]);
}

/** True iff `[start, end)` is fully enclosed by a $$…$$ or \[…\] or \(…\) or $…$ elsewhere. */
function isInsideMathDelimiter(raw: string, start: number, end: number): boolean {
  // Cheap: check that at least one of the delimiter pairs contains us.
  const pairs: RegExp[] = [
    /\\\[([\s\S]*?)\\\]/g,
    /\$\$([\s\S]*?)\$\$/g,
    /\\\(([\s\S]*?)\\\)/g,
    /(?<!\$)\$(?!\$)([^$\n]{1,500}?)\$(?!\$)/g,
  ];
  for (const re of pairs) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const s = m.index;
      const e = m.index + m[0].length;
      if (s <= start && e >= end) return true;
    }
  }
  return false;
}

/**
 * Format problems into a self-contained retry prompt. The prompt lists
 * each error verbatim with its index — the LLM is expected to return
 * a JSON array of `{errorIndex, replacement}` objects to be applied by
 * span. See render-patch.ts for the apply side.
 */
export function buildRetryPrompt(problems: RenderProblem[]): string {
  if (problems.length === 0) return "";
  const lines: string[] = [
    "The previous reply had render errors. Please provide JSON patches to fix ONLY the failing bits — do not rewrite the whole message.",
    "",
    "For each numbered error below, return a `replacement` string that will REPLACE the entire matched pattern (delimiters included). Delimiters may change if fixing requires it (e.g. remove ``` ```latex``` ``` fences, or switch env from `\\begin{xy}` to `\\begin{tikzcd}`).",
    "",
    "Errors found:",
    "",
  ];
  problems.forEach((p, i) => {
    let kindLabel: string;
    switch (p.kind) {
      case "katex-display":
        kindLabel = "display math";
        break;
      case "katex-inline":
        kindLabel = "inline math";
        break;
      case "unrenderable-env":
        kindLabel = "unrenderable environment";
        break;
      case "bare-env":
        kindLabel = "bare LaTeX environment";
        break;
    }
    lines.push(`### Error ${i}: ${kindLabel}`);
    lines.push("");
    lines.push("Matched source:");
    lines.push("```");
    lines.push(p.matched);
    lines.push("```");
    lines.push("");
    lines.push(`Parse error: ${p.message}`);
    lines.push("");
  });
  lines.push(
    "Guidance: use KaTeX-supported LaTeX only. For commutative diagrams use `\\begin{tikzcd}…\\end{tikzcd}` (server-rendered inline SVG); NEVER `\\begin{xy}` or `\\begin{dot2tex}`. For matrices use `\\begin{pmatrix}` / `\\begin{bmatrix}`. Do NOT wrap renderable math or diagrams in ```latex``` / ```tex``` code fences — that displays them as code, not rendered output.",
  );
  lines.push("");
  lines.push('Return ONLY a fenced JSON code block: ```json\\n[{"errorIndex": 0, "replacement": "…"}, {"errorIndex": 1, "replacement": "…"}]\\n```');
  lines.push("");
  lines.push("Each `replacement` should be the corrected complete pattern INCLUDING delimiters. It will be spliced in verbatim.");
  return lines.join("\n");
}
