import type { WorkspaceEffortOutput, WikiPageOutput } from "./init-types";

type WorkspaceEffortLike = Pick<WorkspaceEffortOutput, "id" | "type"> & Partial<Pick<WorkspaceEffortOutput, "title" | "sources">>;
type WikiPageLike = Pick<WikiPageOutput, "content">;

export interface WorkspaceRefRepairResult {
  content: string;
  fixedRefs: number;
  removedRefs: number;
  unresolvedRefs: string[];
}

/**
 * Extract @ws:effort-id references from markdown content.
 * Supports workspace IDs containing letters, digits, dot, underscore, and dash.
 */
export function extractWorkspaceRefs(
  content: string,
  options?: { dedupe?: boolean }
): string[] {
  const matches = content.match(/@ws:[a-zA-Z0-9._-]+/g) ?? [];
  const refs = matches.map((m) => m.slice(4));
  if (options?.dedupe === false) return refs;
  return [...new Set(refs)];
}

/**
 * Repair LLM-generated @ws references against a concrete effort list.
 *
 * The wiki generator sometimes emits citation keys such as @ws:Tao2017
 * instead of real workspace effort ids. This helper maps common citation-key
 * aliases to effort ids when the mapping is unambiguous, and strips unresolved
 * @ws prefixes so invalid links do not persist.
 */
export function repairWorkspaceRefs(
  content: string,
  workspaceEfforts: readonly WorkspaceEffortLike[],
): WorkspaceRefRepairResult {
  if (workspaceEfforts.length === 0 || !content.includes("@ws:")) {
    return { content, fixedRefs: 0, removedRefs: 0, unresolvedRefs: [] };
  }

  const validIds = new Set(workspaceEfforts.map((effort) => effort.id));
  const aliasMap = buildWorkspaceRefAliasMap(workspaceEfforts);
  const unresolvedRefs = new Set<string>();
  let fixedRefs = 0;
  let removedRefs = 0;

  const resolveRef = (refId: string): string | null => {
    if (validIds.has(refId)) return refId;

    const direct = aliasMap.get(normalizeRefKey(refId));
    if (direct) return direct;

    const compactRef = compactRefKey(refId);
    const fuzzyMatches = workspaceEfforts.filter((effort) => {
      const idKey = compactRefKey(effort.id);
      const titleKey = compactRefKey(effort.title ?? "");
      return idKey.includes(compactRef) || titleKey.includes(compactRef);
    });
    return fuzzyMatches.length === 1 ? fuzzyMatches[0]!.id : null;
  };

  let output = content.replace(
    /\[([^\]]*)\]\(@ws:([^)#]+)(#[^)]+)?\)/g,
    (_match, displayText: string, refId: string, anchor: string | undefined) => {
      const resolved = resolveRef(refId);
      if (resolved) {
        if (resolved !== refId) fixedRefs++;
        return `[${displayText}](@ws:${resolved}${anchor ?? ""})`;
      }
      removedRefs++;
      unresolvedRefs.add(refId);
      return displayText;
    },
  );

  output = output.replace(/@ws:([a-zA-Z0-9._-]+)/g, (match, refId: string) => {
    const resolved = resolveRef(refId);
    if (resolved) {
      if (resolved !== refId) fixedRefs++;
      return `@ws:${resolved}`;
    }
    removedRefs++;
    unresolvedRefs.add(refId);
    return refId;
  });

  return {
    content: output,
    fixedRefs,
    removedRefs,
    unresolvedRefs: [...unresolvedRefs],
  };
}

/**
 * Compute cross-reference stats between wiki pages and workspace efforts.
 * Matching is exact by parsed workspace ID, avoiding prefix collisions.
 */
export function collectWikiWorkspaceRefStats(
  wikiPages: readonly WikiPageLike[],
  workspaceEfforts: readonly WorkspaceEffortLike[]
): {
  validRefs: number;
  brokenRefs: number;
  uncoveredItems: number;
  referencedWSIds: Set<string>;
} {
  let validRefs = 0;
  let brokenRefs = 0;

  const wsIds = new Set(workspaceEfforts.map((item) => item.id));
  const referencedWSIds = new Set<string>();

  for (const page of wikiPages) {
    const refs = extractWorkspaceRefs(page.content, { dedupe: false });
    for (const refId of refs) {
      referencedWSIds.add(refId);
      if (wsIds.has(refId)) {
        validRefs++;
      } else {
        brokenRefs++;
      }
    }
  }

  const uncoveredItems = workspaceEfforts.filter(
    (item) => item.type !== "REFERENCE" && !referencedWSIds.has(item.id)
  ).length;

  return { validRefs, brokenRefs, uncoveredItems, referencedWSIds };
}

function buildWorkspaceRefAliasMap(workspaceEfforts: readonly WorkspaceEffortLike[]) {
  const aliases = new Map<string, string | null>();

  const addAlias = (alias: string | undefined, effortId: string) => {
    if (!alias) return;
    const key = normalizeRefKey(alias);
    if (!key) return;
    const existing = aliases.get(key);
    if (existing && existing !== effortId) {
      aliases.set(key, null);
      return;
    }
    if (existing === undefined) aliases.set(key, effortId);
  };

  for (const effort of workspaceEfforts) {
    addAlias(effort.id, effort.id);
    addAlias(effort.title, effort.id);

    const titleAliases = buildTitleCitationAliases(effort.title ?? "");
    for (const alias of titleAliases) addAlias(alias, effort.id);

    for (const source of effort.sources ?? []) {
      addAlias(source.id, effort.id);
      addAlias(source.title, effort.id);
      addAlias(source.arxivId, effort.id);
      if (source.authors.length > 0 && source.year) {
        const authorNames = source.authors.map((author) => {
          const parts = author.split(/\s+/).filter(Boolean);
          return parts[parts.length - 1] ?? author;
        });
        for (const alias of buildAuthorYearAliases(authorNames, String(source.year), source.title)) {
          addAlias(alias, effort.id);
        }
      }
    }
  }

  return new Map([...aliases.entries()].filter((entry): entry is [string, string] => entry[1] != null));
}

function buildTitleCitationAliases(title: string): string[] {
  const match = title.match(/^(.+?)\s*\((\d{4})\)/);
  if (!match) return [];

  const authorPart = match[1]!;
  const year = match[2]!;
  const authorNames = authorPart
    .split(/\s*(?:-|–|—|,|;|&|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);

  return buildAuthorYearAliases(authorNames, year, title);
}

function buildAuthorYearAliases(authorNames: string[], year: string, title: string): string[] {
  const aliases: string[] = [];
  const cleanedAuthors = authorNames.map((name) => name.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean);
  if (cleanedAuthors.length === 0) return aliases;

  aliases.push(`${cleanedAuthors[0]}${year}`);
  if (cleanedAuthors.length >= 2) aliases.push(`${cleanedAuthors[0]}${cleanedAuthors[1]}${year}`);
  aliases.push(`${cleanedAuthors.join("")}${year}`);

  const afterYear = title.split(/\)\s*:/, 2)[1] ?? title;
  const titleTokens = afterYear
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 || /^(one|two|three|four|five|six|seven|eight|nine|ten)$/i.test(token));
  for (const token of titleTokens.slice(0, 12)) {
    aliases.push(`${cleanedAuthors[0]}${year}${token}`);
  }

  return aliases;
}

function normalizeRefKey(value: string) {
  return compactRefKey(value);
}

function compactRefKey(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
