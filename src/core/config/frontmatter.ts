/**
 * Tiny YAML-frontmatter splitter shared by the skill + command loaders.
 *
 * Splits a markdown document into its leading `--- ... ---` YAML frontmatter
 * block and the remaining body. Best-effort: a document without frontmatter
 * yields `{ data: {}, body: <whole doc> }`; malformed YAML yields
 * `{ data: {}, body, error }` (callers decide whether to warn).
 */

import YAML from "yaml";

export interface ParsedFrontmatter {
  /** Parsed frontmatter object (empty when absent / unparsable). */
  data: Record<string, unknown>;
  /** Document body with the frontmatter block stripped. */
  body: string;
  /** Set when a frontmatter block was present but failed to parse. */
  error?: string;
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return { data: {}, body: text };
  }
  const [, yamlBlock, body] = match;
  try {
    const parsed = YAML.parse(yamlBlock);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, body };
    }
    return { data: {}, body };
  } catch (err: any) {
    return { data: {}, body, error: err?.message ?? String(err) };
  }
}
