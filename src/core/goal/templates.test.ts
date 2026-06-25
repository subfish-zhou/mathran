/**
 * Tests for goal templates — NEW-F6.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  listGoalTemplates,
  readGoalTemplate,
  parseTemplateBody,
  expandTemplate,
  type GoalTemplate,
} from "./templates.js";

async function mkWs(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-tpl-test-"));
  await fs.mkdir(path.join(ws, ".mathran", "goal-templates"), { recursive: true });
  return ws;
}

async function writeTemplate(ws: string, name: string, body: string): Promise<void> {
  await fs.writeFile(path.join(ws, ".mathran", "goal-templates", `${name}.md`), body, "utf-8");
}

describe("parseTemplateBody", () => {
  it("parses bare body with no frontmatter", () => {
    const t = parseTemplateBody("bare", "Just body text", "/dev/null");
    expect(t.description).toBeUndefined();
    expect(t.variables).toEqual([]);
    expect(t.body).toBe("Just body text");
  });

  it("parses description", () => {
    const t = parseTemplateBody(
      "x",
      `---\ndescription: A quick test\n---\nBody\n`,
      "/dev/null",
    );
    expect(t.description).toBe("A quick test");
    expect(t.body).toBe("Body\n");
  });

  it("parses variables block", () => {
    const t = parseTemplateBody(
      "vars",
      `---\nvariables:\n  - name: topic\n    required: true\n  - name: paper\n    default: "none"\n---\nHello {topic}\n`,
      "/dev/null",
    );
    expect(t.variables).toHaveLength(2);
    expect(t.variables[0]!.name).toBe("topic");
    expect(t.variables[0]!.required).toBe(true);
    expect(t.variables[1]!.name).toBe("paper");
    expect(t.variables[1]!.default).toBe("none");
  });
});

describe("listGoalTemplates / readGoalTemplate", () => {
  let ws: string;
  beforeEach(async () => { ws = await mkWs(); });

  it("returns only built-ins when directory is missing (no user templates)", async () => {
    const ws2 = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-tpl-empty-"));
    const userOnly = (await listGoalTemplates(ws2)).filter((t) => t.source === "user");
    expect(userOnly).toEqual([]);
  });

  it("returns only built-ins when directory exists but has no .md files", async () => {
    const userOnly = (await listGoalTemplates(ws)).filter((t) => t.source === "user");
    expect(userOnly).toEqual([]);
  });

  it("lists user templates sorted by name", async () => {
    await writeTemplate(ws, "zeta", "z body");
    await writeTemplate(ws, "alpha", "a body");
    await writeTemplate(ws, "beta", "b body");
    const names = (await listGoalTemplates(ws))
      .filter((t) => t.source === "user")
      .map((t) => t.name);
    expect(names).toEqual(["alpha", "beta", "zeta"]);
  });

  it("readGoalTemplate returns null for missing template", async () => {
    expect(await readGoalTemplate(ws, "nope")).toBeNull();
  });

  it("readGoalTemplate returns parsed template", async () => {
    await writeTemplate(ws, "review", "---\ndescription: code review\n---\nReview {file}\n");
    const t = await readGoalTemplate(ws, "review");
    expect(t).not.toBeNull();
    expect(t!.description).toBe("code review");
    expect(t!.body).toContain("Review {file}");
  });
});

describe("expandTemplate", () => {
  const make = (body: string, variables: GoalTemplate["variables"] = []): GoalTemplate => ({
    name: "t",
    body,
    variables,
    path: "/dev/null",
  });

  it("substitutes a single placeholder", () => {
    expect(expandTemplate(make("Hello {who}"), { who: "world" })).toBe("Hello world");
  });

  it("substitutes multiple placeholders", () => {
    expect(
      expandTemplate(make("{a} + {b} = {c}"), { a: "1", b: "2", c: "3" }),
    ).toBe("1 + 2 = 3");
  });

  it("uses default when variable not provided", () => {
    const t = make("Hi {name}", [{ name: "name", default: "world" }]);
    expect(expandTemplate(t, {})).toBe("Hi world");
  });

  it("explicit value overrides default", () => {
    const t = make("Hi {name}", [{ name: "name", default: "world" }]);
    expect(expandTemplate(t, { name: "sub" })).toBe("Hi sub");
  });

  it("throws when required variable is missing", () => {
    const t = make("Hi {name}", [{ name: "name", required: true }]);
    expect(() => expandTemplate(t, {})).toThrow(/requires variable "name"/);
  });

  it("throws when body references unknown placeholder", () => {
    const t = make("Hi {oops}", []);
    expect(() => expandTemplate(t, {})).toThrow(/unknown variable "\{oops\}"/);
  });

  it("allows undeclared explicit variables (lenient input)", () => {
    expect(expandTemplate(make("Hi {ad_hoc}"), { ad_hoc: "ok" })).toBe("Hi ok");
  });

  it("preserves curly braces that don't look like placeholders", () => {
    expect(expandTemplate(make("{} not a placeholder"), {})).toBe("{} not a placeholder");
    expect(expandTemplate(make("{1number} not a placeholder"), {})).toBe("{1number} not a placeholder");
  });
});
