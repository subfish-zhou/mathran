/**
 * `mathran goal template ...` CLI subcommands — NEW-F6.
 *
 * - list:  enumerate templates in the workspace.
 * - show:  print one template's frontmatter + body.
 * - use:   expand a template against --var=value args and either
 *          print the resulting objective (default) or invoke the
 *          existing goal-start path with the expansion.
 */

import {
  listGoalTemplates,
  readGoalTemplate,
  expandTemplate,
} from "../../core/goal/templates.js";

export async function runGoalTemplateList(opts: { workspace: string }): Promise<number> {
  const templates = await listGoalTemplates(opts.workspace);
  if (templates.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `No goal templates yet. Create one at ${opts.workspace}/.mathran/goal-templates/<name>.md`,
    );
    return 0;
  }
  // eslint-disable-next-line no-console
  console.log("Goal templates:");
  for (const t of templates) {
    const src = t.source === "builtin" ? " [builtin]" : " [user]";
    const desc = t.description ? ` — ${t.description}` : "";
    const vars = t.variables.length > 0
      ? `  [vars: ${t.variables.map((v) => `${v.name}${v.required ? "*" : ""}`).join(", ")}]`
      : "";
    // eslint-disable-next-line no-console
    console.log(`  ${t.name}${src}${desc}${vars}`);
  }
  return 0;
}

export async function runGoalTemplateShow(opts: { workspace: string; name: string }): Promise<number> {
  const t = await readGoalTemplate(opts.workspace, opts.name);
  if (!t) {
    // eslint-disable-next-line no-console
    console.error(`Template "${opts.name}" not found.`);
    return 2;
  }
  // eslint-disable-next-line no-console
  console.log(`# ${t.name}${t.source ? ` [${t.source}]` : ""}\n`);
  if (t.description) console.log(`Description: ${t.description}\n`);
  if (t.variables.length > 0) {
    // eslint-disable-next-line no-console
    console.log("Variables:");
    for (const v of t.variables) {
      const req = v.required ? " (required)" : "";
      const def = v.default !== undefined ? ` [default: ${JSON.stringify(v.default)}]` : "";
      // eslint-disable-next-line no-console
      console.log(`  - ${v.name}${req}${def}${v.description ? ` — ${v.description}` : ""}`);
    }
    console.log("");
  }
  // eslint-disable-next-line no-console
  console.log("Body:\n");
  console.log(t.body);
  return 0;
}

/**
 * `mathran goal template use <name> --var foo=bar --var baz=qux`
 * Just prints the expansion (so the user can pipe it to `mathran goal
 * start "$(...)"`). Keeping print-only avoids tangling with the existing
 * goal-start option matrix; once the user is happy with the expansion
 * they can spawn the goal in the SPA or via `goal start`.
 */
export async function runGoalTemplateUse(opts: {
  workspace: string;
  name: string;
  vars: Record<string, string>;
}): Promise<number> {
  const t = await readGoalTemplate(opts.workspace, opts.name);
  if (!t) {
    // eslint-disable-next-line no-console
    console.error(`Template "${opts.name}" not found.`);
    return 2;
  }
  try {
    const expanded = expandTemplate(t, opts.vars);
    // eslint-disable-next-line no-console
    console.log(expanded);
    return 0;
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error(String(e?.message ?? e));
    return 2;
  }
}

/** Parse repeated --var name=value arguments into a flat record. */
export function parseVarFlags(varArgs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of varArgs) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--var must be of the form name=value (got: ${arg})`);
    }
    const key = arg.slice(0, eq).trim();
    const val = arg.slice(eq + 1);
    out[key] = val;
  }
  return out;
}
