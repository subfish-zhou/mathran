/**
 * chat-export.ts — small utilities for the AI Assistant "copy / export markdown"
 * tool (ChatGPT-style). Pure helpers, no React, so they are easy to unit-test
 * and reuse from both the single-message copy affordance and the whole-thread
 * export button.
 */

export type ExportTimelineItem = {
  role: "user" | "assistant";
  content: string;
  createdAt: string | Date;
};

/** Copy text to the clipboard, with a legacy fallback for non-secure contexts. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Render one chat turn as a markdown block with a role heading. */
function renderTurn(item: ExportTimelineItem): string {
  const heading = item.role === "user" ? "### 🧑 You" : "### 🤖 mathran";
  const body = (item.content ?? "").trim();
  return `${heading}\n\n${body}`;
}

/**
 * Build a full markdown document for an exported conversation.
 * Includes an H1 title + export timestamp, then every turn separated by `---`.
 */
export function buildConversationMarkdown(
  title: string,
  items: ExportTimelineItem[],
  exportedAt: Date = new Date(),
): string {
  const safeTitle = (title || "Conversation").trim();
  const header = `# ${safeTitle}\n\n_Exported from mathran · ${exportedAt.toISOString()}_`;
  if (items.length === 0) {
    return `${header}\n\n_(empty conversation)_\n`;
  }
  const turns = items.map(renderTurn).join("\n\n---\n\n");
  return `${header}\n\n---\n\n${turns}\n`;
}

/** Slugify a channel name into a safe-ish filename stem. */
export function slugifyFilename(name: string): string {
  // Keep Unicode letters/numbers (so CJK channel names survive instead of being
  // stripped to "conversation"); collapse everything else to a single hyphen.
  // \p{L} = any letter, \p{N} = any number (requires the /u flag).
  const stem = (name || "conversation")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem || "conversation";
}

/** Local timestamp `YYYYMMDD-HHMM` for filenames (more precise than date only). */
function fileTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}`
  );
}

/** Trigger a client-side download of a markdown file. */
export function downloadMarkdown(filenameStem: string, markdown: string): void {
  downloadText(filenameStem, markdown, "md", "text/markdown;charset=utf-8");
}

/** Generic client-side text download with an explicit extension + mime. */
export function downloadText(
  filenameStem: string,
  text: string,
  ext: string,
  mime: string,
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Scientific filename: <slug>-<YYYYMMDD-HHMM>.<ext>, e.g. 数学讨论-20260602-1445.tex
  a.download = `${slugifyFilename(filenameStem)}-${fileTimestamp()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── LaTeX export ──────────────────────────────────────────────────────────
//
// Assistant replies are markdown that frequently embeds LaTeX math ($...$ and
// $$...$$). A full markdown→LaTeX engine is overkill here; instead we do a
// pragmatic, robust conversion that:
//   • passes math ($…$, $$…$$, \(…\), \[…\]) THROUGH untouched,
//   • escapes LaTeX special chars ONLY in prose (never inside math/code),
//   • maps the common markdown constructs (headings, bold/italic, inline code,
//     fenced code → verbatim, bullet/numbered lists),
// and wraps it all in a compilable article document.

// LaTeX preamble for exported conversations.
//
// IMPORTANT: chat transcripts are frequently multilingual (Chinese / Japanese /
// Korean / …). The legacy `pdflatex` + inputenc/fontenc stack CANNOT typeset
// CJK and produces "Missing character" garbage. We therefore target the modern
// Unicode engines (XeLaTeX / LuaLaTeX) with fontspec + xeCJK, and auto-select
// the first available pan-CJK font (Noto → WenQuanYi → Fandol) so the .tex
// compiles on the user's machine whatever CJK font they happen to have. A header
// comment tells the user which engine to run.
const LATEX_PREAMBLE = `% !TEX program = xelatex
% Compile with XeLaTeX or LuaLaTeX (NOT pdflatex) — needed for CJK / Unicode.
% For best CJK coverage install a pan-CJK font, e.g. "Noto Serif CJK".
\\documentclass[11pt]{article}
\\usepackage{fontspec}
\\usepackage{xeCJK}
% Auto-pick the first available pan-CJK main font (covers zh / ja / ko).
\\IfFontExistsTF{Noto Serif CJK SC}{\\setCJKmainfont{Noto Serif CJK SC}}{%
  \\IfFontExistsTF{Noto Sans CJK SC}{\\setCJKmainfont{Noto Sans CJK SC}}{%
    \\IfFontExistsTF{WenQuanYi Zen Hei}{\\setCJKmainfont{WenQuanYi Zen Hei}}{%
      \\IfFontExistsTF{Source Han Serif SC}{\\setCJKmainfont{Source Han Serif SC}}{%
        \\setCJKmainfont{FandolSong}}}}}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{mathrsfs}  % \\mathscr{...} script letters
\\usepackage{mathtools} % amsmath superset: \\coloneqq, \\xrightarrow, ...
\\usepackage{bm}        % \\bm{...} bold math symbols
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{xcolor}
\\usepackage{listings}
\\usepackage[margin=1in]{geometry}
\\lstset{basicstyle=\\ttfamily\\small,breaklines=true,frame=single}`;

/** Escape LaTeX special characters in PROSE text (not math, not code). */
function escapeLatexProse(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

/** Escape only what breaks inside \texttt{...} (lighter than full prose escape). */
function escapeLatexCode(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// -- Protected-span machinery -------------------------------------------------
//
// The #1 failure mode of a regex markdown->LaTeX converter is letting the prose
// escaper run over MATH or CODE, which turns \frac, \[, \begin{...} into
// \textbackslash{}frac garbage (markdown/LaTeX *source* rendered as literal
// text -- exactly the bug observed). The fix: BEFORE any escaping, pull every
// math span and code span OUT into placeholders, run markdown->LaTeX on the
// remaining pure prose, then splice math/code back in VERBATIM. Math is already
// valid LaTeX -- we must never touch it.

const PH_OPEN = "\u0000P";
const PH_CLOSE = "\u0000";

interface Protected {
  text: string;
  spans: string[];
}

/**
 * Replace every math + fenced/inline code span with an opaque placeholder.
 * Handles all four math delimiters: $$...$$, \[...\], $...$, \(...\). Display
 * forms are checked before inline so $$ is not mis-split as two $...$.
 */
function protectSpans(input: string): Protected {
  const spans: string[] = [];
  const keep = (verbatim: string): string => {
    spans.push(verbatim);
    return `${PH_OPEN}${spans.length - 1}${PH_CLOSE}`;
  };
  let s = input;
  // Fenced code ```...``` -> lstlisting (verbatim, no escaping inside).
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) =>
    keep(`\\begin{lstlisting}\n${code.replace(/\n$/, "")}\n\\end{lstlisting}`),
  );
  // Display math $$...$$ (multi-line allowed) -> \[ ... \].
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_m, m: string) => keep(`\\[${m}\\]`));
  // Display math \[ ... \] -> kept as-is.
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_m, m: string) => keep(`\\[${m}\\]`));
  // Inline math \( ... \) -> kept as-is.
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, m: string) => keep(`\\(${m}\\)`));
  // Inline math $ ... $ (no newline, not $$) -> kept as $ ... $.
  s = s.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, (_m, m: string) => keep(`$${m}$`));
  // Inline code `...` -> \texttt{...}.
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => keep(`\\texttt{${escapeLatexCode(c)}}`));
  return { text: s, spans };
}

/** Restore protected spans into a converted string. */
function restoreSpans(text: string, spans: string[]): string {
  return text.replace(/\u0000P(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? "");
}

/**
 * Convert INLINE markdown emphasis/links on a placeholder-protected prose line
 * to LaTeX, then escape the residual prose. Math/code are already placeholders
 * here, so they are never touched by the escaper.
 */
function inlineProseToLatex(line: string): string {
  const tokens: string[] = [];
  const stash = (latex: string): string => {
    tokens.push(latex);
    return `\u0001${tokens.length - 1}\u0001`;
  };
  let s = line;
  // Bold+italic ***x***
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, (_m, x: string) => stash(`\\textbf{\\textit{${escapeLatexProse(x)}}}`));
  // Bold **x** / __x__
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, x: string) => stash(`\\textbf{${escapeLatexProse(x)}}`));
  s = s.replace(/__([^_]+)__/g, (_m, x: string) => stash(`\\textbf{${escapeLatexProse(x)}}`));
  // Italic *x* / _x_
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, x: string) => stash(`\\textit{${escapeLatexProse(x)}}`));
  s = s.replace(/(?<!_)_([^_]+)_(?!_)/g, (_m, x: string) => stash(`\\textit{${escapeLatexProse(x)}}`));
  // Links [text](url) -> \href{url}{text}
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, u: string) =>
    stash(`\\href{${u}}{${escapeLatexProse(t)}}`),
  );
  // Escape residual prose, then restore emphasis tokens.
  s = escapeLatexProse(s);
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => tokens[Number(i)] ?? "");
  return s;
}

/**
 * Convert one message's markdown body to a LaTeX fragment.
 *
 * Pipeline: (1) protect math + code spans into placeholders, (2) walk the
 * remaining lines converting headings / lists / paragraphs, (3) restore the
 * protected math/code verbatim. Because math never reaches the escaper, LaTeX
 * commands inside it survive intact.
 */
function messageBodyToLatex(body: string): string {
  const { text, spans } = protectSpans((body ?? "").replace(/\r\n/g, "\n"));
  const lines = text.split("\n");
  const out: string[] = [];
  let listOpen: "itemize" | "enumerate" | null = null;

  const closeList = () => {
    if (listOpen) {
      out.push(`\\end{${listOpen}}`);
      listOpen = null;
    }
  };

  // A line that is ONLY a protected block (display math / code fence) -> emit it
  // on its own, outside any list/paragraph context.
  const isStandaloneBlock = (line: string): boolean => {
    const m = line.trim().match(/^\u0000P(\d+)\u0000$/);
    if (!m) return false;
    const span = spans[Number(m[1])] ?? "";
    return span.startsWith("\\[") || span.startsWith("\\begin{lstlisting}");
  };

  for (const line of lines) {
    // Standalone display-math / code block.
    if (isStandaloneBlock(line)) {
      closeList();
      out.push(restoreSpans(line.trim(), spans));
      continue;
    }

    // Blank line -> paragraph break.
    if (line.trim() === "") {
      closeList();
      out.push("");
      continue;
    }

    // Headings.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1]!.length;
      const txt = restoreSpans(inlineProseToLatex(h[2]!.trim()), spans);
      const cmd = level <= 1 ? "section" : level === 2 ? "subsection" : "subsubsection";
      out.push(`\\${cmd}*{${txt}}`);
      continue;
    }

    // Bullet list item.
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listOpen !== "itemize") {
        closeList();
        out.push("\\begin{itemize}");
        listOpen = "itemize";
      }
      out.push(`  \\item ${restoreSpans(inlineProseToLatex(ul[1]!), spans)}`);
      continue;
    }

    // Numbered list item.
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (listOpen !== "enumerate") {
        closeList();
        out.push("\\begin{enumerate}");
        listOpen = "enumerate";
      }
      out.push(`  \\item ${restoreSpans(inlineProseToLatex(ol[1]!), spans)}`);
      continue;
    }

    // Plain paragraph line (may contain inline-math placeholders).
    closeList();
    out.push(restoreSpans(inlineProseToLatex(line), spans));
  }
  closeList();
  return out.join("\n");
}

/**
 * Build a compilable LaTeX `article` document for an exported conversation.
 * Each turn becomes a subsection (You / mathran) with its converted body.
 */
export function buildConversationLatex(
  title: string,
  items: ExportTimelineItem[],
  exportedAt: Date = new Date(),
): string {
  const safeTitle = escapeLatexProse((title || "Conversation").trim());
  const head = `${LATEX_PREAMBLE}

\\title{${safeTitle}}
\\date{Exported from mathran \\\\ \\small ${exportedAt.toISOString()}}

\\begin{document}
\\maketitle`;

  if (items.length === 0) {
    return `${head}

\\emph{(empty conversation)}

\\end{document}
`;
  }

  const body = items
    .map((item) => {
      const who = item.role === "user" ? "You" : "mathran";
      return `\\subsection*{${who}}\n${messageBodyToLatex(item.content)}`;
    })
    .join("\n\n\\hrulefill\n\n");

  return `${head}

${body}

\\end{document}
`;
}
