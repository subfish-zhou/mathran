/**
 * Goal templates — NEW-F6.
 *
 * Stored under `<workspace>/.mathran/goal-templates/<name>.md`. Each
 * file is a markdown body with optional YAML frontmatter:
 *
 *   ---
 *   description: Short one-liner shown in `goal template list`
 *   variables:
 *     - name: topic
 *       required: true
 *     - name: paper
 *       default: "(no paper)"
 *   ---
 *   # Body with {topic} and {paper} placeholders
 *
 * `expandTemplate(body, vars)` performs naive {var} → vars[var]
 * substitution; unknown placeholders raise; missing-and-no-default
 * variables raise so the caller can prompt the user.
 *
 * The store is read-only at the API level — users edit the .md files
 * by hand (it's *their* templates, not data the agent should mutate).
 * Lib only loads/lists/expands.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface TemplateVariableSpec {
  name: string;
  required?: boolean;
  default?: string;
  description?: string;
}

export interface GoalTemplate {
  /** Template name = file basename without .md */
  name: string;
  description?: string;
  variables: TemplateVariableSpec[];
  /** Raw body with {var} placeholders. */
  body: string;
  /** Absolute path on disk. */
  path: string;
}

function templatesDirFor(workspace: string): string {
  return path.join(workspace, ".mathran", "goal-templates");
}

/**
 * Parse a goal-template markdown file. Frontmatter is optional and YAML-ish
 * (we only need `description` + `variables: [{name, required?, default?,
 * description?}]`); body is everything after the closing `---`.
 */
export function parseTemplateBody(name: string, raw: string, sourcePath: string): GoalTemplate {
  let description: string | undefined;
  const variables: TemplateVariableSpec[] = [];
  let body = raw;

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    const [, yaml, rest] = fmMatch;
    body = rest ?? "";
    const lines = (yaml ?? "").split("\n");
    let inVars = false;
    let cur: Partial<TemplateVariableSpec> | null = null;
    for (const raw of lines) {
      const line = raw.replace(/\t/g, "  ");
      if (line.startsWith("description:")) {
        description = line.slice("description:".length).trim().replace(/^["']|["']$/g, "");
        continue;
      }
      if (line.startsWith("variables:")) {
        inVars = true;
        continue;
      }
      if (!inVars) continue;
      const trim = line.trimStart();
      if (trim.startsWith("- name:")) {
        if (cur && cur.name) variables.push(cur as TemplateVariableSpec);
        cur = { name: trim.slice("- name:".length).trim().replace(/^["']|["']$/g, "") };
        continue;
      }
      if (cur && /^\s+(required|default|description):/.test(line)) {
        const m = line.match(/^\s+(required|default|description):\s*(.*)$/);
        if (m) {
          const key = m[1] as keyof TemplateVariableSpec;
          const value = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
          if (key === "required") {
            cur.required = value === "true";
          } else if (key === "default" || key === "description") {
            (cur as Record<string, unknown>)[key] = value;
          }
        }
      }
    }
    if (cur && cur.name) variables.push(cur as TemplateVariableSpec);
  }

  return {
    name,
    body: body.replace(/^\n+/, ""),
    variables,
    path: sourcePath,
    ...(description !== undefined ? { description } : {}),
  };
}

export async function listGoalTemplates(workspace: string): Promise<GoalTemplate[]> {
  const dir = templatesDirFor(workspace);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const out: GoalTemplate[] = [];
  for (const f of entries.sort()) {
    if (!f.endsWith(".md")) continue;
    const name = f.replace(/\.md$/, "");
    const full = path.join(dir, f);
    try {
      const raw = await fs.readFile(full, "utf-8");
      out.push(parseTemplateBody(name, raw, full));
    } catch {
      // skip unreadable
    }
  }
  return out;
}

export async function readGoalTemplate(workspace: string, name: string): Promise<GoalTemplate | null> {
  const dir = templatesDirFor(workspace);
  const full = path.join(dir, `${name}.md`);
  try {
    const raw = await fs.readFile(full, "utf-8");
    return parseTemplateBody(name, raw, full);
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Substitute {placeholder} occurrences in `body` with values from `vars`.
 * Raises on:
 *   - unknown placeholder used in body but not declared in template.variables,
 *   - declared variable with `required: true` and no value AND no `default`.
 * Missing optional variables with a default → use the default.
 */
export function expandTemplate(template: GoalTemplate, vars: Record<string, string>): string {
  // Resolve effective values: explicit → default → undefined.
  const effective: Record<string, string> = {};
  for (const spec of template.variables) {
    if (Object.prototype.hasOwnProperty.call(vars, spec.name)) {
      effective[spec.name] = vars[spec.name]!;
    } else if (spec.default !== undefined) {
      effective[spec.name] = spec.default;
    } else if (spec.required) {
      throw new Error(`Goal template "${template.name}" requires variable "${spec.name}" (no value + no default).`);
    }
  }
  // Allow callers to pass variables NOT declared in the template (e.g. ad-hoc
  // — be lenient on the input side, strict on the body side).
  for (const k of Object.keys(vars)) {
    if (!(k in effective)) effective[k] = vars[k]!;
  }
  return template.body.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, key) => {
    if (Object.prototype.hasOwnProperty.call(effective, key)) {
      return effective[key]!;
    }
    throw new Error(
      `Goal template "${template.name}" references unknown variable "{${key}}" — declare it in variables: or pass --${key}=value.`,
    );
  });
}
