/**
 * Tests for built-in goal templates — Layer 3 (awaiter role).
 *
 * Covers the built-in template directory bundled with the package, its
 * precedence relative to user templates, and that the F6 parser learned the
 * new `allowedTools` / `reasoningEffort` / `budgetTokens` frontmatter fields.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  listGoalTemplates,
  listBuiltinGoalTemplates,
  readGoalTemplate,
  readBuiltinGoalTemplate,
  parseTemplateBody,
  expandTemplate,
} from "./templates.js";

async function mkWs(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-builtin-tpl-"));
  await fs.mkdir(path.join(ws, ".mathran", "goal-templates"), { recursive: true });
  return ws;
}

async function writeUserTemplate(ws: string, name: string, body: string): Promise<void> {
  await fs.writeFile(path.join(ws, ".mathran", "goal-templates", `${name}.md`), body, "utf-8");
}

describe("parseTemplateBody — Layer 3 frontmatter fields", () => {
  it("parses allowedTools list, reasoningEffort and budgetTokens", () => {
    const t = parseTemplateBody(
      "awaiter",
      `---\ndescription: watcher\nvariables:\n  - name: target\n    required: true\nallowedTools:\n  - bash\n  - read_file\n  - search_files\nreasoningEffort: low\nbudgetTokens: 30000\n---\nBody {target}\n`,
      "/dev/null",
    );
    expect(t.description).toBe("watcher");
    expect(t.variables).toHaveLength(1);
    expect(t.variables[0]!.name).toBe("target");
    expect(t.variables[0]!.required).toBe(true);
    expect(t.allowedTools).toEqual(["bash", "read_file", "search_files"]);
    expect(t.reasoningEffort).toBe("low");
    expect(t.budgetTokens).toBe(30000);
    expect(t.body).toContain("Body {target}");
  });

  it("supports an inline flow list for allowedTools", () => {
    const t = parseTemplateBody(
      "x",
      `---\nallowedTools: [bash, read_file]\n---\nbody\n`,
      "/dev/null",
    );
    expect(t.allowedTools).toEqual(["bash", "read_file"]);
  });
});

describe("listBuiltinGoalTemplates / readBuiltinGoalTemplate", () => {
  it("includes the bundled awaiter template", async () => {
    const builtins = await listBuiltinGoalTemplates();
    const names = builtins.map((t) => t.name);
    expect(names).toContain("awaiter");
    const awaiter = builtins.find((t) => t.name === "awaiter")!;
    expect(awaiter.source).toBe("builtin");
    expect(awaiter.allowedTools).toEqual(["bash", "read_file", "search_files"]);
    expect(awaiter.budgetTokens).toBe(30000);
    expect(awaiter.reasoningEffort).toBe("low");
  });

  it("readBuiltinGoalTemplate returns the awaiter, null for unknown", async () => {
    const awaiter = await readBuiltinGoalTemplate("awaiter");
    expect(awaiter).not.toBeNull();
    expect(awaiter!.source).toBe("builtin");
    expect(awaiter!.body).toContain("You are an awaiter sub-goal");
    expect(await readBuiltinGoalTemplate("does-not-exist")).toBeNull();
  });
});

describe("listGoalTemplates / readGoalTemplate — builtin + user merge", () => {
  let ws: string;
  beforeEach(async () => { ws = await mkWs(); });

  it("includes the built-in awaiter when workspace has no user templates", async () => {
    const list = await listGoalTemplates(ws);
    const awaiter = list.find((t) => t.name === "awaiter");
    expect(awaiter).toBeDefined();
    expect(awaiter!.source).toBe("builtin");
  });

  it("readGoalTemplate(ws, 'awaiter') falls back to the built-in", async () => {
    const t = await readGoalTemplate(ws, "awaiter");
    expect(t).not.toBeNull();
    expect(t!.source).toBe("builtin");
    expect(t!.body).toContain("Pure observer");
  });

  it("a user template with the same name overrides the built-in", async () => {
    await writeUserTemplate(ws, "awaiter", "---\ndescription: my override\n---\nUSER awaiter body\n");
    const t = await readGoalTemplate(ws, "awaiter");
    expect(t).not.toBeNull();
    expect(t!.source).toBe("user");
    expect(t!.description).toBe("my override");
    expect(t!.body).toContain("USER awaiter body");

    const list = await listGoalTemplates(ws);
    const matches = list.filter((t) => t.name === "awaiter");
    // exactly one awaiter entry, and it's the user version
    expect(matches).toHaveLength(1);
    expect(matches[0]!.source).toBe("user");
  });

  it("built-in entries come before user entries in the merged list", async () => {
    await writeUserTemplate(ws, "zzz-user", "user body");
    const list = await listGoalTemplates(ws);
    const builtinIdx = list.findIndex((t) => t.source === "builtin");
    const userIdx = list.findIndex((t) => t.name === "zzz-user");
    expect(builtinIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(builtinIdx);
  });
});

describe("expandTemplate — built-in awaiter", () => {
  it("expands {target} on the built-in template", async () => {
    const t = (await readBuiltinGoalTemplate("awaiter"))!;
    const expanded = expandTemplate(t, { target: "long-build-job" });
    expect(expanded).toContain("Target: long-build-job");
    expect(expanded).not.toContain("{target}");
  });

  it("throws when required var is missing and there is no default", async () => {
    const t = (await readBuiltinGoalTemplate("awaiter"))!;
    expect(() => expandTemplate(t, {})).toThrow(/requires variable "target"/);
  });

  it("uses a default value when a variable declares one", () => {
    const t = parseTemplateBody(
      "withdef",
      `---\nvariables:\n  - name: target\n    default: "fallback"\n---\nTarget: {target}\n`,
      "/dev/null",
    );
    expect(expandTemplate(t, {})).toContain("Target: fallback");
  });
});
