import { describe, it, expect } from "vitest";
import {
  buildHookEnv,
  interpreterFor,
  hookCwd,
  FORWARDED_ENV_KEYS,
  type HookExecutionContext,
} from "./context.js";

const base: HookExecutionContext = {
  hookType: "post-edit",
  workspace: "/ws",
};

describe("buildHookEnv", () => {
  it("injects MATHRAN_* variables for the present context fields", () => {
    const env = buildHookEnv(
      {
        hookType: "post-edit",
        workspace: "/ws",
        projectSlug: "p1",
        filePath: "/ws/foo.ts",
        bashCommand: "git commit -m x",
        toolName: "write_file",
        goalText: "prove lemma",
      },
      {},
    );
    expect(env.MATHRAN_HOOK_TYPE).toBe("post-edit");
    expect(env.MATHRAN_WORKSPACE).toBe("/ws");
    expect(env.MATHRAN_PROJECT_SLUG).toBe("p1");
    expect(env.MATHRAN_FILE_PATH).toBe("/ws/foo.ts");
    expect(env.MATHRAN_BASH_COMMAND).toBe("git commit -m x");
    expect(env.MATHRAN_TOOL_NAME).toBe("write_file");
    expect(env.MATHRAN_GOAL_TEXT).toBe("prove lemma");
  });

  it("omits MATHRAN_* keys that are not set", () => {
    const env = buildHookEnv(base, {});
    expect(env.MATHRAN_FILE_PATH).toBeUndefined();
    expect(env.MATHRAN_BASH_COMMAND).toBeUndefined();
    expect(env.MATHRAN_TOOL_NAME).toBeUndefined();
    expect(env.MATHRAN_GOAL_TEXT).toBeUndefined();
    expect(env.MATHRAN_PROJECT_SLUG).toBeUndefined();
  });

  it("forwards only the whitelisted parent-env keys (no secret leak)", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      USER: "u",
      LANG: "C",
      TZ: "UTC",
      OPENAI_API_KEY: "sk-secret",
      MATHRAN_PRIVATE: "leak",
    };
    const env = buildHookEnv(base, parent);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.USER).toBe("u");
    expect(env.LANG).toBe("C");
    expect(env.TZ).toBe("UTC");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // MATHRAN_PRIVATE from parent must not survive — we rebuild MATHRAN_*.
    expect(env.MATHRAN_PRIVATE).toBeUndefined();
  });

  it("does not mutate the parent env", () => {
    const parent = { PATH: "/usr/bin" };
    buildHookEnv(base, parent);
    expect(Object.keys(parent)).toEqual(["PATH"]);
  });

  it("exposes the forwarded-key list", () => {
    expect([...FORWARDED_ENV_KEYS]).toEqual(["PATH", "HOME", "USER", "LANG", "TZ"]);
  });
});

describe("interpreterFor", () => {
  it("uses node for .js", () => {
    expect(interpreterFor("/x/pre-bash.js").command).toBe("node");
  });
  it("uses python3 for .py", () => {
    expect(interpreterFor("/x/pre-commit.py").command).toBe("python3");
  });
  it("uses bash for .sh/.bash/extensionless", () => {
    expect(interpreterFor("/x/post-edit.sh").command).toBe("/bin/bash");
    expect(interpreterFor("/x/post-edit.bash").command).toBe("/bin/bash");
    expect(interpreterFor("/x/post-edit").command).toBe("/bin/bash");
  });
});

describe("hookCwd", () => {
  it("returns workspace root for non-project hooks", () => {
    expect(hookCwd(base)).toBe("/ws");
  });
  it("returns the project dir for project hooks", () => {
    expect(hookCwd({ ...base, projectSlug: "p1" })).toBe("/ws/projects/p1");
  });
});
