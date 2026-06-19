/**
 * Effort context builder (v0.2 §12).
 *
 * Pulls the head of an effort's `document.md` (default 2KB) plus the last
 * N status-history entries, and formats them as a system-prompt fragment
 * for the goal runner. When a goal is scoped to an effort, this fragment
 * is appended to the system prompt so the assistant knows what
 * project/effort it's working in and what's already on the page.
 *
 * Pure read-only — no writes against the effort store, no schema changes.
 */

import { readEffortDocument, readEffortMetadata } from "./store.js";
import type { StatusHistoryEntry } from "./types.js";

/** A condensed view of effort context suitable for injecting into a prompt. */
export interface EffortContext {
  /** First N bytes of `document.md`, or null if file is missing/empty. */
  documentExcerpt: string | null;
  /** True when the document was longer than `documentMaxBytes`. */
  documentTruncated: boolean;
  /** Recent status-history entries (most recent first), up to N. */
  recentStatus: StatusHistoryEntry[];
  /** Project slug — included so the header renders even when both fields are empty. */
  projectSlug: string;
  /** Effort slug — same. */
  effortSlug: string;
}

export interface LoadEffortContextOptions {
  workspace: string;
  projectSlug: string;
  effortSlug: string;
  /** Default 2048. */
  documentMaxBytes?: number;
  /** Default 3. */
  recentStatusCount?: number;
}

const DEFAULT_DOCUMENT_MAX_BYTES = 2048;
const DEFAULT_RECENT_STATUS_COUNT = 3;

/**
 * Load effort context for prompt injection. Returns `null` when the effort
 * itself does not exist (no metadata file). Returns an `EffortContext`
 * record otherwise — fields are individually nullable/empty.
 */
export async function loadEffortContext(
  opts: LoadEffortContextOptions,
): Promise<EffortContext | null> {
  const {
    workspace,
    projectSlug,
    effortSlug,
    documentMaxBytes = DEFAULT_DOCUMENT_MAX_BYTES,
    recentStatusCount = DEFAULT_RECENT_STATUS_COUNT,
  } = opts;

  // No metadata → no effort. Skip everything (and let the caller decide
  // whether that's "render nothing" or "warn loudly").
  const meta = await readEffortMetadata(workspace, projectSlug, effortSlug);
  if (!meta) return null;

  const rawDoc = await readEffortDocument(workspace, projectSlug, effortSlug);
  let documentExcerpt: string | null = null;
  let documentTruncated = false;
  if (rawDoc !== null && rawDoc.length > 0) {
    if (rawDoc.length > documentMaxBytes) {
      documentExcerpt = rawDoc.slice(0, documentMaxBytes);
      documentTruncated = true;
    } else {
      documentExcerpt = rawDoc;
    }
  }

  // `statusHistory` is ordered oldest → newest in effort.toml (see
  // `normalizeMetadata` in store.ts). For prompt display we want
  // most-recent-first, so reverse a sliced tail of the right length.
  const history = meta.statusHistory ?? [];
  const tail = history.slice(-Math.max(0, recentStatusCount));
  const recentStatus = [...tail].reverse();

  return {
    documentExcerpt,
    documentTruncated,
    recentStatus,
    projectSlug,
    effortSlug,
  };
}

/**
 * Render an `EffortContext` as a Markdown system-prompt fragment.
 *
 * Returns the empty string when the context is null OR when both the
 * document excerpt and the recent-status list are empty — there's nothing
 * to inject and we don't want to pollute the prompt with an empty header.
 */
export function formatEffortContext(ctx: EffortContext | null): string {
  if (!ctx) return "";
  const hasDoc = ctx.documentExcerpt !== null && ctx.documentExcerpt.length > 0;
  const hasStatus = ctx.recentStatus.length > 0;
  if (!hasDoc && !hasStatus) return "";

  const lines: string[] = [];
  lines.push(`## Working on effort: ${ctx.projectSlug} / ${ctx.effortSlug}`);

  if (hasDoc) {
    lines.push("");
    lines.push("### Effort notes (excerpt)");
    // Document body is rendered verbatim — no fencing, no escaping. The
    // assistant already understands Markdown; double-wrapping just adds
    // tokens.
    lines.push(ctx.documentExcerpt as string);
    if (ctx.documentTruncated) lines.push("…[truncated]");
  }

  if (hasStatus) {
    lines.push("");
    lines.push("### Recent status updates");
    for (const e of ctx.recentStatus) {
      const tagParts: string[] = [`[${e.at}]`, e.to];
      if (e.reason) tagParts.push(`(${e.reason})`);
      if (e.supersededBy) tagParts.push(`(superseded-by: ${e.supersededBy})`);
      lines.push(`- ${tagParts.join(" ")}`);
    }
  }

  lines.push("");
  lines.push(
    `(If you need more detail, you can read .mathran-efforts/${ctx.projectSlug}/${ctx.effortSlug}/document.md directly.)`,
  );

  return lines.join("\n");
}
