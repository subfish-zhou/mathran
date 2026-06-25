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
import { fileURLToPath } from "node:url";

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
  /**
   * Provenance — Layer 3. `"builtin"` templates ship inside the package
   * (`builtin-templates/`); `"user"` templates live under
   * `<workspace>/.mathran/goal-templates/`. A user template shadows a
   * builtin of the same name.
   */
  source?: "builtin" | "user";
  /**
   * Optional tool allow-list (Layer 3 awaiter role). When set and a caller
   * (e.g. `spawn_sub_goal`) honours it, the spawned goal is restricted to
   * these tool names.
   */
  allowedTools?: string[];
  /** Optional reasoning-effort hint (e.g. "low") applied to the spawned goal. */
  reasoningEffort?: string;
  /** Optional token budget applied to the spawned goal. */
  budgetTokens?: number;
}

function templatesDirFor(workspace: string): string {
  return path.join(workspace, ".mathran", "goal-templates");
}

/**
 * Candidate directories holding the bundled built-in templates, in order.
 * Mirrors `builtin-skills/loader.ts`: resolve relative to this module, and
 * when running from a compiled `dist/` tree fall back to the sibling `src/`
 * path so a built tree without the copied `.md` files still works in dev.
 */
function builtinTemplateDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const primary = path.join(here, "builtin-templates");
  const dirs = [primary];
  if (here.includes(`${path.sep}dist${path.sep}`)) {
    dirs.push(
      path.join(here.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`), "builtin-templates"),
    );
  }
  return dirs;
}

/**
 * Parse a goal-template markdown file. Frontmatter is optional and YAML-ish
 * (we only need `description` + `variables: [{name, required?, default?,
 * description?}]`); body is everything after the closing `---`.
 */
export function parseTemplateBody(name: string, raw: string, sourcePath: string): GoalTemplate {
  let description: string | undefined;
  const variables: TemplateVariableSpec[] = [];
  let allowedTools: string[] | undefined;
  let reasoningEffort: string | undefined;
  let budgetTokens: number | undefined;
  let body = raw;

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    const [, yaml, rest] = fmMatch;
    body = rest ?? "";
    const lines = (yaml ?? "").split("\n");
    let inVars = false;
    let inAllowed = false;
    let cur: Partial<TemplateVariableSpec> | null = null;
    const flushVar = () => {
      if (cur && cur.name) variables.push(cur as TemplateVariableSpec);
      cur = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/\t/g, "  ");
      const indented = /^\s/.test(line);
      // A non-indented, non-empty line that isn't a list item starts a new
      // top-level key — close any open list/var section first.
      if (!indented && line.trim().length > 0 && !line.trimStart().startsWith("- ")) {
        if (!line.startsWith("variables:")) { flushVar(); inVars = false; }
        if (!line.startsWith("allowedTools:")) inAllowed = false;
      }
      if (line.startsWith("description:")) {
        description = line.slice("description:".length).trim().replace(/^["']|["']$/g, "");
        continue;
      }
      if (line.startsWith("reasoningEffort:")) {
        reasoningEffort = line.slice("reasoningEffort:".length).trim().replace(/^["']|["']$/g, "");
        continue;
      }
      if (line.startsWith("budgetTokens:")) {
        const v = line.slice("budgetTokens:".length).trim().replace(/^["']|["']$/g, "");
        const n = Number(v);
        if (Number.isFinite(n)) budgetTokens = n;
        continue;
      }
      if (line.startsWith("allowedTools:")) {
        inAllowed = true;
        const inline = line.slice("allowedTools:".length).trim();
        // Support inline flow list: allowedTools: [a, b, c]
        if (inline.startsWith("[")) {
          allowedTools = inline.replace(/^\[|\]$/g, "")
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
            .filter((s) => s.length > 0);
          inAllowed = false;
        } else {
          allowedTools = allowedTools ?? [];
        }
        continue;
      }
      if (line.startsWith("variables:")) {
        inVars = true;
        continue;
      }
      if (inAllowed) {
        const trim = line.trimStart();
        if (trim.startsWith("- ")) {
          (allowedTools ??= []).push(trim.slice(2).trim().replace(/^["']|["']$/g, ""));
        }
        continue;
      }
      if (!inVars) continue;
      const trim = line.trimStart();
      if (trim.startsWith("- name:")) {
        flushVar();
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
    flushVar();
  }

  return {
    name,
    body: body.replace(/^\n+/, ""),
    variables,
    path: sourcePath,
    ...(description !== undefined ? { description } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
  };
}

/**
 * Load the bundled built-in goal templates (Layer 3). Best-effort: a missing
 * directory yields an empty list. Each returned template is stamped
 * `source: "builtin"`.
 */
export async function listBuiltinGoalTemplates(): Promise<GoalTemplate[]> {
  for (const dir of builtinTemplateDirs()) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    const out: GoalTemplate[] = [];
    for (const f of entries.sort()) {
      if (!f.endsWith(".md")) continue;
      const name = f.replace(/\.md$/, "");
      const full = path.join(dir, f);
      try {
        const raw = await fs.readFile(full, "utf-8");
        const t = parseTemplateBody(name, raw, full);
        t.source = "builtin";
        out.push(t);
      } catch {
        // skip unreadable
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

/** Read a single built-in template by name, or null if not bundled. */
export async function readBuiltinGoalTemplate(name: string): Promise<GoalTemplate | null> {
  for (const dir of builtinTemplateDirs()) {
    const full = path.join(dir, `${name}.md`);
    try {
      const raw = await fs.readFile(full, "utf-8");
      const t = parseTemplateBody(name, raw, full);
      t.source = "builtin";
      return t;
    } catch (e: any) {
      if (e?.code === "ENOENT") continue;
      throw e;
    }
  }
  return null;
}

/**
 * List templates available in `workspace`. Built-in templates come first
 * (stamped `source: "builtin"`); user templates from the workspace are
 * stamped `source: "user"`. A user template shadows a built-in of the same
 * name (the user entry replaces the built-in in the merged list).
 */
export async function listGoalTemplates(workspace: string): Promise<GoalTemplate[]> {
  const builtin = await listBuiltinGoalTemplates();
  const dir = templatesDirFor(workspace);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  const user: GoalTemplate[] = [];
  for (const f of entries.sort()) {
    if (!f.endsWith(".md")) continue;
    const name = f.replace(/\.md$/, "");
    const full = path.join(dir, f);
    try {
      const raw = await fs.readFile(full, "utf-8");
      const t = parseTemplateBody(name, raw, full);
      t.source = "user";
      user.push(t);
    } catch {
      // skip unreadable
    }
  }
  const userNames = new Set(user.map((t) => t.name));
  // Built-in first (minus any shadowed by a user template), then user.
  return [...builtin.filter((t) => !userNames.has(t.name)), ...user];
}

/**
 * Read a template by name. Looks in the user workspace first; if not found
 * there, falls back to the bundled built-in templates.
 */
export async function readGoalTemplate(workspace: string, name: string): Promise<GoalTemplate | null> {
  const dir = templatesDirFor(workspace);
  const full = path.join(dir, `${name}.md`);
  try {
    const raw = await fs.readFile(full, "utf-8");
    const t = parseTemplateBody(name, raw, full);
    t.source = "user";
    return t;
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  return readBuiltinGoalTemplate(name);
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
