// MathRef parser — pure, no server imports.

// ---------------------------------------------------------------------------
// Base64 URL-safe helpers (ported from src/lib/references.ts)
// ---------------------------------------------------------------------------

export function encodeBase64Url(str: string): string {
  return Buffer.from(str, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeBase64Url(str: string): string {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  b64 += "=".repeat(pad);
  return Buffer.from(b64, "base64").toString("utf-8");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MathRefModule = "workspace" | "forum" | "wiki" | "bib" | "user";

export interface ParsedMathRef {
  raw: string;
  module: MathRefModule;
  shortModule: string;
  identifier: string;
  projectSlug?: string;
  isThread?: boolean;
  anchor?: string;
  displayText?: string;
  form: "link" | "mention";
}

export interface ParsedAnchor {
  kind: "text" | "range" | "line" | "raw";
  value: string;
  decoded?: string;
  start?: number;
  end?: number;
}

// ---------------------------------------------------------------------------
// Anchor sub-parsing
// ---------------------------------------------------------------------------

export function parseAnchor(anchor: string): ParsedAnchor {
  if (!anchor) return { kind: "raw", value: anchor };

  // #t=<base64url encoded text>
  if (anchor.startsWith("t=")) {
    const encoded = anchor.slice(2);
    try {
      return { kind: "text", value: anchor, decoded: decodeBase64Url(encoded) };
    } catch {
      return { kind: "raw", value: anchor };
    }
  }

  // #<start>:<end> range
  const rangeMatch = anchor.match(/^(\d+):(\d+)$/);
  if (rangeMatch) {
    return {
      kind: "range",
      value: anchor,
      start: Number(rangeMatch[1]),
      end: Number(rangeMatch[2]),
    };
  }

  // #L<number> line
  const lineMatch = anchor.match(/^L(\d+)$/);
  if (lineMatch) {
    return { kind: "line", value: anchor, start: Number(lineMatch[1]) };
  }

  return { kind: "raw", value: anchor };
}

// ---------------------------------------------------------------------------
// Module mapping
// ---------------------------------------------------------------------------

const SHORT_TO_LONG: Record<string, MathRefModule> = {
  workspace: "workspace",
  ws: "workspace",
  forum: "forum",
  f: "forum",
  wiki: "wiki",
  w: "wiki",
  bib: "bib",
  b: "bib",
  user: "user",
  u: "user",
  thread: "forum",
  t: "forum",
};

const LONG_TO_SHORT: Record<string, string> = {
  workspace: "ws",
  forum: "f",
  wiki: "w",
  bib: "b",
  user: "u",
};

function isThreadModule(mod: string): boolean {
  return mod === "t" || mod === "thread";
}

function normalizeShort(mod: string): string {
  if (mod === "thread") return "t";
  return LONG_TO_SHORT[mod] ?? mod;
}

// ---------------------------------------------------------------------------
// Identifier parsing (project slug, thread prefix, anchor)
// ---------------------------------------------------------------------------

interface IdentifierParts {
  identifier: string;
  projectSlug?: string;
  isThread?: boolean;
  anchor?: string;
}

function parseIdentifier(raw: string, moduleShort: string): IdentifierParts {
  let identifier = raw;
  let projectSlug: string | undefined;
  let isThread = isThreadModule(moduleShort);
  let anchor: string | undefined;

  // Split anchor on first #
  const hashIdx = identifier.indexOf("#");
  if (hashIdx >= 0) {
    anchor = identifier.slice(hashIdx + 1);
    identifier = identifier.slice(0, hashIdx);
  }

  // Forum: handle t/ thread prefix
  if (moduleShort === "f" || moduleShort === "forum") {
    if (identifier.startsWith("t/")) {
      isThread = true;
      identifier = identifier.slice(2);
    } else if (identifier.match(/^[^/]+\/t\//)) {
      // projectSlug/t/N
      const firstSlash = identifier.indexOf("/");
      projectSlug = identifier.slice(0, firstSlash);
      identifier = identifier.slice(firstSlash + 3); // skip "/t/"
      isThread = true;
    } else if (identifier.includes("/")) {
      // projectSlug/seq
      const firstSlash = identifier.indexOf("/");
      projectSlug = identifier.slice(0, firstSlash);
      identifier = identifier.slice(firstSlash + 1);
    }
  } else if (moduleShort === "t" || moduleShort === "thread") {
    // Thread module — identifier may have project prefix
    if (identifier.includes("/")) {
      const firstSlash = identifier.indexOf("/");
      projectSlug = identifier.slice(0, firstSlash);
      identifier = identifier.slice(firstSlash + 1);
    }
  } else {
    // ws/wiki/bib/user: projectSlug/slug
    if (identifier.includes("/")) {
      // Check for /file/ path in workspace — keep whole path
      if (
        (moduleShort === "ws" || moduleShort === "workspace") &&
        identifier.match(/^[^/]+\/file\//)
      ) {
        // projectSlug/file/... → keep file path in identifier
        const firstSlash = identifier.indexOf("/");
        projectSlug = identifier.slice(0, firstSlash);
        identifier = identifier.slice(firstSlash + 1);
      } else if (
        (moduleShort === "ws" || moduleShort === "workspace") &&
        identifier.startsWith("file/")
      ) {
        // file/... path without project prefix — keep as-is
      } else {
        const firstSlash = identifier.indexOf("/");
        projectSlug = identifier.slice(0, firstSlash);
        identifier = identifier.slice(firstSlash + 1);
      }
    }
  }

  return { identifier, projectSlug, isThread: isThread || undefined, anchor };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

const MODULE_ALTS = "workspace|ws|forum|f|wiki|w|bib|b|user|u|thread|t";

// Markdown form: [text](@mod:id)
const MARKDOWN_RE = new RegExp(
  `\\[([^\\]]+)\\]\\(@(${MODULE_ALTS}):([^)\\s]+)\\)`,
  "g",
);

// Bare form: @mod:id (not preceded by ]( which would be part of markdown form)
const BARE_RE = new RegExp(
  `@(${MODULE_ALTS}):([^\\s)\\]]+)`,
  "g",
);

export function parseMathRefs(content: string): ParsedMathRef[] {
  const results: ParsedMathRef[] = [];

  // Pass 1: markdown form
  const matchedRanges: Array<[number, number]> = [];
  MARKDOWN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = MARKDOWN_RE.exec(content)) !== null) {
    const [raw, displayText, mod, refBody] = m as RegExpExecArray & [string, string, string, string];
    const start = m.index;
    const end = start + raw.length;
    matchedRanges.push([start, end]);

    const moduleShort = normalizeShort(mod);
    const moduleLong = SHORT_TO_LONG[mod]!;
    const parts = parseIdentifier(refBody, mod);

    results.push({
      raw,
      module: moduleLong,
      shortModule: isThreadModule(mod) ? "t" : moduleShort,
      identifier: parts.identifier,
      projectSlug: parts.projectSlug,
      isThread: parts.isThread,
      anchor: parts.anchor,
      displayText,
      form: "link",
    });
  }

  // Pass 2: bare form — replace matched ranges with spaces to avoid double-matching
  let working = content;
  // Build from end to preserve indices
  for (let i = matchedRanges.length - 1; i >= 0; i--) {
    const [start, end] = matchedRanges[i]!;
    working = working.slice(0, start) + " ".repeat(end - start) + working.slice(end);
  }

  BARE_RE.lastIndex = 0;
  while ((m = BARE_RE.exec(working)) !== null) {
    const [raw, mod, refBody] = m as RegExpExecArray & [string, string, string];

    // Ensure not preceded by ]( (extra safety)
    const before = working.slice(Math.max(0, m.index - 2), m.index);
    if (before.endsWith("](")) continue;

    const moduleShort = normalizeShort(mod);
    const moduleLong = SHORT_TO_LONG[mod]!;
    const parts = parseIdentifier(refBody, mod);

    results.push({
      raw,
      module: moduleLong,
      shortModule: isThreadModule(mod) ? "t" : moduleShort,
      identifier: parts.identifier,
      projectSlug: parts.projectSlug,
      isThread: parts.isThread,
      anchor: parts.anchor,
      form: "mention",
    });
  }

  return results;
}
