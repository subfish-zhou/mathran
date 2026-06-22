import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadBuiltinSkills } from "./loader.js";
import { loadLayeredSkills } from "../../skills/loader.js";
import { MATHRAN_DIR } from "../../config/mathran-root.js";

describe("loadBuiltinSkills", () => {
  it("loads the shipped builtin skills at layer 'builtin'", () => {
    const { skills } = loadBuiltinSkills();
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["propose-goal", "propose-plan"]);
    for (const s of skills) {
      expect(s.layer).toBe("builtin");
      expect(s.manifest.allowedTools?.length).toBeGreaterThan(0);
      // No trigger ⇒ "always" skill.
      expect(s.manifest.trigger).toBeUndefined();
    }
  });

  it("propose-plan declares its tool whitelist + body", () => {
    const { skills } = loadBuiltinSkills();
    const plan = skills.find((s) => s.name === "propose-plan")!;
    expect(plan.manifest.allowedTools).toContain("propose_plan");
    expect(plan.body).toContain("propose_plan");
  });
});

describe("loadLayeredSkills builtin integration", () => {
  it("includes builtins as the lowest layer by default", () => {
    const { skills } = loadLayeredSkills({
      workspace: path.join(os.tmpdir(), "mathran-no-such-ws"),
      home: path.join(os.tmpdir(), "mathran-no-such-home"),
    });
    const builtins = skills.filter((s) => s.layer === "builtin");
    expect(builtins.map((s) => s.name).sort()).toEqual([
      "propose-goal",
      "propose-plan",
    ]);
  });

  it("can be opted out with includeBuiltins: false", () => {
    const { skills } = loadLayeredSkills({
      workspace: path.join(os.tmpdir(), "mathran-no-such-ws"),
      home: path.join(os.tmpdir(), "mathran-no-such-home"),
      includeBuiltins: false,
    });
    expect(skills.filter((s) => s.layer === "builtin")).toEqual([]);
  });

  it("a same-named USER skill overrides the builtin", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-skill-home-"));
    const skillDir = path.join(home, MATHRAN_DIR, "skills", "propose-plan");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: propose-plan\ndescription: user override\n---\nMy own plan skill.\n",
    );
    try {
      const { skills } = loadLayeredSkills({
        workspace: path.join(os.tmpdir(), "mathran-no-such-ws"),
        home,
      });
      const plan = skills.find((s) => s.name === "propose-plan")!;
      expect(plan.layer).toBe("user");
      expect(plan.manifest.description).toBe("user override");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
