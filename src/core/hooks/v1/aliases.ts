/**
 * Claude Code matcher alias table.
 *
 * Mathran's canonical tool names differ from Claude Code's, but users porting
 * Claude Code hook configs should "just work". The v1 dispatcher computes the
 * effective matcher inputs for a tool call as:
 *
 *   [<canonical tool name>, ...aliases]
 *
 * where `aliases` come from this table. A configured matcher matches when ANY
 * of those inputs match.
 *
 * The mapping is intentionally one-way (Claude name → mathran tool) and
 * one-to-one within the v1 alias table — we surface aliases via
 * {@link aliasesForTool} as a flat string[] keyed by mathran tool name.
 *
 * Adding more aliases later (e.g. Codex's `apply_patch`) is a pure data change
 * here: no matcher / loader changes needed.
 */

/**
 * mathran tool name → Claude Code matcher aliases it should also match.
 *
 * A hook with matcher `"Write"` therefore matches a mathran `write_file` call
 * (and a hook with matcher `"Bash"` matches `bash`, etc.).
 */
const TOOL_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  write_file: ["Write"],
  edit_file: ["Edit"],
  bash: ["Bash"],
  dispatch_subagent: ["Agent"],
});

/**
 * Return the matcher-alias inputs for a given canonical tool name. Always
 * returns a fresh array (callers may push to it). Unknown tool names yield
 * an empty array — i.e. only the canonical name is matched.
 */
export function aliasesForTool(toolName: string): string[] {
  const a = TOOL_ALIASES[toolName];
  return a ? [...a] : [];
}

/**
 * Inverse lookup: given a matcher alias (e.g. `"Write"`), return the canonical
 * mathran tool name(s) that match it. Used by tests + `/hooks list` rendering
 * so a user typing `"Write"` knows which tools it gates.
 *
 * Returns an empty array when the input isn't a known alias.
 */
export function toolsForAlias(alias: string): string[] {
  const out: string[] = [];
  for (const [tool, aliases] of Object.entries(TOOL_ALIASES)) {
    if (aliases.includes(alias)) out.push(tool);
  }
  return out;
}

/** The full alias table (read-only) — for diagnostics. */
export function aliasTable(): Readonly<Record<string, ReadonlyArray<string>>> {
  return TOOL_ALIASES;
}
