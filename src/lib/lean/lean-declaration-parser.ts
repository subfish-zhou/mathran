import type { ParsedDeclaration, LakefileInfo } from "./lean-types";

const DECL_KEYWORDS = ["theorem", "lemma", "def", "instance", "structure", "class", "axiom", "abbrev"] as const;
type DeclKind = (typeof DECL_KEYWORDS)[number];

/**
 * Strip block comments (/- ... -/) with nesting and single-line comments (-- ...)
 */
function stripComments(content: string): string {
  let depth = 0;
  let out = "";
  let i = 0;
  while (i < content.length) {
    if (content[i] === "/" && content[i + 1] === "-") {
      depth++;
      i += 2;
    } else if (content[i] === "-" && content[i + 1] === "/" && depth > 0) {
      depth--;
      i += 2;
    } else if (depth === 0) {
      out += content[i];
      i++;
    } else {
      i++;
    }
  }
  // Remove single-line comments
  return out.replace(/--.*$/gm, "");
}

function isTopLevelDecl(line: string): DeclKind | null {
  const trimmed = line.trimStart();
  // Indented lines (2+ spaces) are not top-level
  if (line.length > 0 && line[0] === " " && line.startsWith("  ")) return null;
  for (const kw of DECL_KEYWORDS) {
    if (trimmed.startsWith(kw + " ") || trimmed.startsWith(kw + "\n")) {
      const idx = line.indexOf(kw);
      if (idx > 0 && line[idx - 1] === ".") continue;
      return kw;
    }
  }
  return null;
}

export function parseLeanFile(content: string, filePath: string): ParsedDeclaration[] {
  const stripped = stripComments(content);
  const lines = stripped.split("\n");
  const declarations: ParsedDeclaration[] = [];

  for (let i = 0; i < lines.length; i++) {
    const kind = isTopLevelDecl(lines[i]);
    if (!kind) continue;

    const trimmed = lines[i].trimStart();
    const afterKw = trimmed.slice(kind.length).trim();
    const nameMatch = afterKw.match(/^([A-Za-z_][A-Za-z0-9_.\u0027]*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    // Collect full declaration text until next top-level or section boundary
    let declText = lines[i];
    let j = i + 1;
    while (j < lines.length) {
      if (isTopLevelDecl(lines[j]) !== null) break;
      const t = lines[j].trimStart();
      if (/^(namespace |section |end |open |import |#)/.test(t)) break;
      declText += "\n" + lines[j];
      j++;
    }

    // Split at := or where
    const assignIdx = declText.indexOf(":=");
    const whereIdx = declText.indexOf(" where\n");
    let signature: string;
    let body: string;

    if (assignIdx >= 0) {
      signature = declText.slice(0, assignIdx).trim();
      body = declText.slice(assignIdx + 2).trim();
    } else if (whereIdx >= 0) {
      signature = declText.slice(0, whereIdx).trim();
      body = declText.slice(whereIdx + 6).trim();
    } else {
      signature = declText.trim();
      body = "";
    }

    // Remove keyword prefix from signature, keep from name onwards
    const nameIdx = signature.indexOf(name);
    if (nameIdx >= 0) {
      signature = signature.slice(nameIdx);
    }

    const sorryMatches = body.match(/\bsorry\b/g);
    const sorryCount = sorryMatches ? sorryMatches.length : 0;

    declarations.push({
      name,
      kind,
      signature,
      body,
      hasSorry: sorryCount > 0,
      sorryCount,
      line: i + 1,
      file: filePath,
    });
  }

  return declarations;
}

export function parseLakefileVersion(content: string): LakefileInfo {
  const info: LakefileInfo = {};

  const versionMatch = content.match(/lean_?[Vv]ersion\s*[:=]\s*"?v?([^"\s,]+)"?/);
  if (versionMatch) info.leanVersion = versionMatch[1];

  const mathlibMatch = content.match(/require\s+mathlib/);
  if (mathlibMatch) info.mathlibVersion = "detected";

  return info;
}
