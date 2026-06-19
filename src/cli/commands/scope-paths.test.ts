import { describe, it, expect } from "vitest";
import { resolveScopeRoot } from "./scope-paths.js";

describe("resolveScopeRoot", () => {
  const ws = "/home/u/mathran-workspace";

  it("global → workspace root", () => {
    expect(resolveScopeRoot(ws, { kind: "global" })).toBe(ws);
  });

  it("project → workspace/projects/<slug>", () => {
    expect(
      resolveScopeRoot(ws, { kind: "project", projectSlug: "smoke" }),
    ).toBe("/home/u/mathran-workspace/projects/smoke");
  });

  it("effort → workspace/projects/<p>/efforts/<e>", () => {
    expect(
      resolveScopeRoot(ws, {
        kind: "effort",
        projectSlug: "smoke",
        effortSlug: "exp-1",
      }),
    ).toBe("/home/u/mathran-workspace/projects/smoke/efforts/exp-1");
  });

  it("works with absolute weird workspace paths", () => {
    expect(
      resolveScopeRoot("/", { kind: "project", projectSlug: "p" }),
    ).toBe("/projects/p");
  });
});
