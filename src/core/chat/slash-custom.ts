/**
 * Custom slash-command resolution + prompt injection (SPA Slash Commands task).
 *
 * Custom commands live at `<layer>/.mathran/commands/<name>.md` and are loaded
 * by {@link loadLayeredCommands}. This module turns those loaded definitions
 * into something the chat surface can execute:
 *
 *   - `resolveCustomCommands` filters out names that collide with a builtin
 *     (PLAN decision #3 — builtin wins; same-named custom is dropped with a
 *     warning and never shown in the suggester).
 *   - `substituteArguments` replaces the literal `$ARGUMENTS` placeholder with
 *     the user-supplied args (PLAN decision #6 — literal, case-sensitive, no
 *     shell escaping; this is prompt injection, not shell exec).
 *   - `buildCustomPrompt` produces the final user-message text to send.
 */

import type { LoadedCommand } from "../commands/loader.js";
import type { LayerName } from "../skills/loader.js";

/** A custom command that survived builtin-conflict filtering. */
export interface ResolvedCustomCommand {
  name: string;
  layer: LayerName;
  description?: string;
  /** Raw markdown body (with `$ARGUMENTS` placeholders still present). */
  body: string;
  /** Absolute path to the source `<name>.md`. */
  path: string;
}

export interface ResolveCustomCommandsResult {
  commands: ResolvedCustomCommand[];
  /** Warnings about dropped (builtin-colliding) commands, for surfacing. */
  warnings: string[];
}

/** The literal placeholder replaced with the command args. */
export const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

/**
 * Replace every literal `$ARGUMENTS` with `args`. When `args` is empty the
 * placeholder collapses to an empty string. Case-sensitive; no escaping.
 */
export function substituteArguments(body: string, args: string): string {
  return body.split(ARGUMENTS_PLACEHOLDER).join(args);
}

/**
 * Filter loaded commands against the builtin name set. A custom command whose
 * name matches a builtin is dropped (builtin wins) and a warning is emitted.
 */
export function resolveCustomCommands(
  loaded: readonly LoadedCommand[],
  builtinNames: ReadonlySet<string>,
): ResolveCustomCommandsResult {
  const commands: ResolvedCustomCommand[] = [];
  const warnings: string[] = [];
  for (const c of loaded) {
    if (builtinNames.has(c.name)) {
      warnings.push(
        `slash: custom command "/${c.name}" (${c.path}) shadows a builtin; ignored.`,
      );
      continue;
    }
    const description =
      typeof c.manifest.description === "string" ? c.manifest.description : undefined;
    commands.push({
      name: c.name,
      layer: c.layer,
      ...(description ? { description } : {}),
      body: c.manifest.body,
      path: c.path,
    });
  }
  return { commands, warnings };
}

/**
 * Build the final prompt text for a custom command invocation. Substitutes
 * `$ARGUMENTS` with the trimmed args. Used by both the CLI and the SPA so the
 * injected prompt is identical across hosts.
 */
export function buildCustomPrompt(
  command: Pick<ResolvedCustomCommand, "body">,
  args: string,
): string {
  return substituteArguments(command.body, args.trim());
}
