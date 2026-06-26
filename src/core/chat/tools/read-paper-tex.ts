/**
 * Built-in `read_paper_tex` tool (sync-upgrade P1-C).
 *
 * Lets the model navigate an arxiv paper's LaTeX source the codex
 * way — no upstream slicing, no "here are 6000 chars of fullText",
 * just a file handle and a section index. The model picks what to
 * read.
 *
 * Usage from the model:
 *   read_paper_tex({arxivId: "2106.04561"})
 *     → returns metadata: rootDir, mainTexFile, all .tex files,
 *       and a list of \section/\subsection labels found in main.tex.
 *
 *   read_paper_tex({arxivId: "2106.04561", section: "Methods"})
 *     → returns the body of the matching section, fuzzily matching
 *       \section{Methods} / \section{The Method} / "Methodology".
 *
 *   read_paper_tex({arxivId: "2106.04561", file: "intro.tex"})
 *     → returns the full content of that .tex file (cap at 200 KB).
 *
 * Internally calls fetchArxivSource which caches in the workspace,
 * so repeat calls within a session are instant. Network call only on
 * first read.
 *
 * No PDF fallback — this tool is TeX-only by design. If the paper has
 * no source on arxiv, the model should use pdf_extract({path:'arxiv:..'})
 * which has the source→PDF fallback.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { fetchArxivSource } from "../../paper-graph/arxiv-source.js";

const MAX_RETURN_BYTES = 200_000;

/**
 * Extract \section{...} / \subsection{...} / \chapter{...} headings
 * from a body of LaTeX. Returns each heading's name and the
 * (start, end) byte range of its body within `body`.
 */
export function extractSections(body: string): Array<{
  level: "chapter" | "section" | "subsection" | "subsubsection";
  name: string;
  start: number;
  end: number;
}> {
  const headingRe = /\\(chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/g;
  const heads: Array<{
    level: "chapter" | "section" | "subsection" | "subsubsection";
    name: string;
    cmdStart: number;
    bodyStart: number;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    heads.push({
      level: m[1] as any,
      name: m[2].trim(),
      cmdStart: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  return heads.map((h, i) => ({
    level: h.level,
    name: h.name,
    start: h.cmdStart,
    end: i + 1 < heads.length ? heads[i + 1].cmdStart : body.length,
  }));
}

/**
 * Fuzzy match a section name. Tries (in order):
 *   1. exact case-insensitive match
 *   2. contains() either direction
 *   3. token-overlap > 50%
 */
function matchSection(
  sections: ReturnType<typeof extractSections>,
  query: string,
): number {
  const q = query.toLowerCase().trim();
  if (!q) return -1;
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].name.toLowerCase() === q) return i;
  }
  for (let i = 0; i < sections.length; i++) {
    const n = sections[i].name.toLowerCase();
    if (n.includes(q) || q.includes(n)) return i;
  }
  const qTokens = new Set(q.split(/\s+/).filter((t) => t.length > 2));
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < sections.length; i++) {
    const n = sections[i].name.toLowerCase();
    const overlap = [...qTokens].filter((t) => n.includes(t)).length;
    if (overlap === 0) continue;
    const score = overlap / qTokens.size;
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function createReadPaperTexTool(): ToolSpec {
  return {
    name: "read_paper_tex",
    riskClass: "read",
    readOnly: true,
    description:
      "Read the LaTeX source of an arXiv paper. Auto-fetches " +
      "arxiv.org/e-print/<id> on first call and caches under " +
      ".mathran/paper-sources/. Three call modes: (a) just arxivId " +
      "→ get rootDir, mainTexFile, file list, section index; (b) " +
      "arxivId + section → get the body of that \\section (fuzzy " +
      "matched); (c) arxivId + file → get the full content of that " +
      ".tex file. Use this INSTEAD of pdf_extract for arxiv papers — " +
      "the .tex source has all LaTeX commands, citations, and labels " +
      "intact. For papers without an arxiv source (rare; legacy " +
      "PDF-only submissions), use pdf_extract({path:'arxiv:<id>'}) " +
      "which falls back to Marker on the PDF.",
    parameters: {
      type: "object",
      properties: {
        arxivId: {
          type: "string",
          description: "The arXiv id (e.g. '2106.04561' or 'cs.LG/0412020').",
        },
        section: {
          type: "string",
          description:
            "Optional section name to extract. Fuzzy match against \\section{}, " +
            "\\subsection{}, etc. in the main .tex file.",
        },
        file: {
          type: "string",
          description:
            "Optional path to a specific .tex file within the source bundle, " +
            "RELATIVE to the cache rootDir (e.g. 'intro.tex' or 'sections/methods.tex'). " +
            "Mutually exclusive with section.",
        },
      },
      required: ["arxivId"],
    },
    async execute(rawArgs: Record<string, unknown>, ctx: ToolExecuteContext) {
      const arxivId = typeof rawArgs.arxivId === "string" ? rawArgs.arxivId.trim() : "";
      if (!arxivId) return { ok: false, content: "read_paper_tex: arxivId required" };

      const ws = ctx.workspace ?? "";
      const wsAbs = ws ? path.resolve(ws) : "";
      if (!wsAbs) return { ok: false, content: "read_paper_tex: no active workspace" };

      const res = await fetchArxivSource(arxivId, { workspace: wsAbs });
      if (res.status !== "ok") {
        return {
          ok: false,
          content:
            `read_paper_tex: cannot fetch arxiv source for ${arxivId} ` +
            `(${res.status}: ${res.error}). Try pdf_extract({path:'arxiv:${arxivId}'}) ` +
            `which falls back to PDF extraction.`,
        };
      }

      const sectionQuery = typeof rawArgs.section === "string" ? rawArgs.section.trim() : "";
      const fileArg = typeof rawArgs.file === "string" ? rawArgs.file.trim() : "";

      // ── Mode C: explicit file path
      if (fileArg) {
        const abs = path.isAbsolute(fileArg) ? fileArg : path.join(res.rootDir, fileArg);
        // Sandbox check — must stay under res.rootDir.
        // [Fix A11 2026-06-26] use realpath to follow any symlinks
        // BEFORE the prefix check, so a symlink inside the cache that
        // points outside (e.g. crafted by a malicious arxiv tarball)
        // can't escape. The tar filter (Fix A14) is the primary
        // defense; this is belt-and-braces.
        const resolved = path.resolve(abs);
        let realResolved: string;
        try {
          realResolved = await fs.realpath(resolved);
        } catch (err: any) {
          return { ok: false, content: `read_paper_tex: cannot resolve ${fileArg}: ${err?.message ?? err}` };
        }
        const realRoot = await fs.realpath(res.rootDir).catch(() => path.resolve(res.rootDir));
        if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
          return { ok: false, content: `read_paper_tex: file escapes paper-source dir (${fileArg})` };
        }
        let body: string;
        try {
          body = await fs.readFile(realResolved, "utf-8");
        } catch (err: any) {
          return { ok: false, content: `read_paper_tex: cannot read ${fileArg}: ${err?.message ?? err}` };
        }
        if (body.length > MAX_RETURN_BYTES) {
          body = body.slice(0, MAX_RETURN_BYTES) + `\n\n[TRUNCATED — file is ${body.length} bytes, returned first ${MAX_RETURN_BYTES}]`;
        }
        return {
          ok: true,
          content: `# ${fileArg} (${body.length} bytes)\n\n${body}`,
        };
      }

      // ── Need main .tex for both index mode and section mode
      if (!res.mainTexFile) {
        const fileList = res.texFiles.map((f) => "  - " + path.relative(res.rootDir, f)).join("\n");
        return {
          ok: false,
          content:
            `read_paper_tex: ${arxivId} has no auto-resolvable main .tex.\n` +
            `Available files:\n${fileList}\n` +
            `Call again with file:'<one of the above>'.`,
        };
      }
      const mainBody = await fs.readFile(res.mainTexFile, "utf-8");
      const sections = extractSections(mainBody);

      // ── Mode B: section query
      if (sectionQuery) {
        const idx = matchSection(sections, sectionQuery);
        if (idx === -1) {
          const known = sections.map((s) => `  - [${s.level}] ${s.name}`).join("\n");
          return {
            ok: false,
            content:
              `read_paper_tex: no section in ${arxivId} matches "${sectionQuery}".\n` +
              `Available sections:\n${known || "  (none — main .tex has no \\section commands)"}`,
          };
        }
        const s = sections[idx];
        let body = mainBody.slice(s.start, s.end);
        if (body.length > MAX_RETURN_BYTES) {
          body = body.slice(0, MAX_RETURN_BYTES) + `\n\n[TRUNCATED — section is ${body.length} bytes, returned first ${MAX_RETURN_BYTES}]`;
        }
        return {
          ok: true,
          content: `# ${arxivId} — \\${s.level}{${s.name}} (${body.length} bytes)\n\n${body}`,
        };
      }

      // ── Mode A: index
      const fileList = res.texFiles.map((f) => "  - " + path.relative(res.rootDir, f)).join("\n");
      const sectionList = sections
        .map((s) => `  - [${s.level}] ${s.name}`)
        .join("\n");
      const mainRel = path.relative(res.rootDir, res.mainTexFile);
      const cacheTag = res.fromCache ? "(cached)" : "(freshly fetched)";
      return {
        ok: true,
        content:
          `# arxiv ${arxivId} ${cacheTag}\n` +
          `cache root: ${res.rootDir}\n` +
          `main .tex:  ${mainRel} (${mainBody.length} bytes)\n` +
          `total size: ${res.byteSize} bytes (${res.texFiles.length} .tex, ${res.bibFiles.length} .bib, ${res.figureFiles.length} figures)\n\n` +
          `## Files\n${fileList}\n\n` +
          `## Sections in ${mainRel}\n${sectionList || "  (no \\section commands)"}\n\n` +
          `Call again with section:'<name>' to extract one, or file:'<rel/path.tex>' to read another file.`,
      };
    },
  };
}
