import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadLayeredSkills } from "./loader.js";
import { MATHRAN_DIR } from "../config/mathran-root.js";

let tmp: string;
let workspace: string;
let home: string;

function writeSkill(baseDir: string, name: string, frontmatter: string, body = "body") {
  const dir = path.join(baseDir, MATHRAN_DIR, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : "";
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${fm}${body}`);
}

function projectDir(): string {
  const d = path.join(workspace, "projects", "p1");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-skills-test-"));
  workspace = path.join(tmp, "ws");
  home = path.join(tmp, "home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("loadLayeredSkills", () => {
  it("returns empty when no skills exist", () => {
    const r = loadLayeredSkills({ workspace, home });
    expect(r.skills).toEqual([]);
  });

  it("loads a skill from each layer", () => {
    writeSkill(home, "user-skill", "name: user-skill\ndescription: U");
    writeSkill(workspace, "ws-skill", "name: ws-skill\ndescription: W");
    writeSkill(projectDir(), "proj-skill", "name: proj-skill\ndescription: P");
    const r = loadLayeredSkills({ workspace, home, projectSlug: "p1" });
    const names = r.skills.map((s) => s.name).sort();
    expect(names).toEqual(["proj-skill", "user-skill", "ws-skill"]);
  });

  it("dedups by name: PROJECT > WORKSPACE > USER", () => {
    writeSkill(home, "dup", "name: dup\ndescription: from-user");
    writeSkill(workspace, "dup", "name: dup\ndescription: from-ws");
    writeSkill(projectDir(), "dup", "name: dup\ndescription: from-proj");
    const r = loadLayeredSkills({ workspace, home, projectSlug: "p1" });
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].layer).toBe("project");
    expect(r.skills[0].manifest.description).toBe("from-proj");
  });

  it("workspace beats user when no project layer", () => {
    writeSkill(home, "dup", "name: dup\ndescription: from-user");
    writeSkill(workspace, "dup", "name: dup\ndescription: from-ws");
    const r = loadLayeredSkills({ workspace, home });
    expect(r.skills[0].layer).toBe("workspace");
  });

  it("defaults name to the directory when frontmatter omits it", () => {
    writeSkill(workspace, "implicit", "description: no-name-field");
    const r = loadLayeredSkills({ workspace, home });
    expect(r.skills[0].name).toBe("implicit");
  });

  it("filters disabled names", () => {
    writeSkill(workspace, "keep", "name: keep");
    writeSkill(workspace, "drop", "name: drop");
    const r = loadLayeredSkills({ workspace, home, disabled: ["drop"] });
    expect(r.skills.map((s) => s.name)).toEqual(["keep"]);
  });

  it("warns on malformed frontmatter and skips the skill", () => {
    const dir = path.join(workspace, MATHRAN_DIR, "skills", "bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\n: : bad: :\n---\nbody");
    const r = loadLayeredSkills({ workspace, home });
    expect(r.skills).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("captures the body sans frontmatter", () => {
    writeSkill(workspace, "withbody", "name: withbody", "## Heading\ncontent");
    const r = loadLayeredSkills({ workspace, home });
    expect(r.skills[0].body.trim()).toBe("## Heading\ncontent");
  });
});
