/**
 * Unit tests for custom slash-command resolution + injection.
 */
import { describe, it, expect } from "vitest";
import {
  substituteArguments,
  resolveCustomCommands,
  buildCustomPrompt,
  ARGUMENTS_PLACEHOLDER,
} from "./slash-custom.js";
import type { LoadedCommand } from "../commands/loader.js";

function cmd(name: string, body: string, description?: string): LoadedCommand {
  return {
    name,
    layer: "workspace",
    path: `/ws/.mathran/commands/${name}.md`,
    manifest: { name, body, ...(description ? { description } : {}) },
  };
}

describe("substituteArguments", () => {
  it("replaces a single placeholder", () => {
    expect(substituteArguments("Explain $ARGUMENTS in simple terms", "monads")).toBe(
      "Explain monads in simple terms",
    );
  });
  it("replaces every occurrence", () => {
    expect(substituteArguments("Echo $ARGUMENTS twice: $ARGUMENTS", "hi")).toBe(
      "Echo hi twice: hi",
    );
  });
  it("collapses to empty string when no args", () => {
    expect(substituteArguments("a $ARGUMENTS b", "")).toBe("a  b");
  });
  it("is case-sensitive (lowercase placeholder untouched)", () => {
    expect(substituteArguments("x $arguments y", "z")).toBe("x $arguments y");
  });
  it("does not shell-escape", () => {
    expect(substituteArguments("run $ARGUMENTS", "a; rm -rf /")).toBe("run a; rm -rf /");
  });
  it("exposes the literal placeholder constant", () => {
    expect(ARGUMENTS_PLACEHOLDER).toBe("$ARGUMENTS");
  });
});

describe("resolveCustomCommands conflict detection", () => {
  const builtins = new Set(["compact", "skills", "help"]);

  it("keeps non-conflicting commands", () => {
    const { commands, warnings } = resolveCustomCommands(
      [cmd("explain", "Explain $ARGUMENTS", "explainer")],
      builtins,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "explain",
      body: "Explain $ARGUMENTS",
      description: "explainer",
      layer: "workspace",
    });
    expect(warnings).toEqual([]);
  });

  it("drops a custom command that shadows a builtin and warns", () => {
    const { commands, warnings } = resolveCustomCommands(
      [cmd("compact", "nope"), cmd("explain", "ok")],
      builtins,
    );
    expect(commands.map((c) => c.name)).toEqual(["explain"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/compact/);
    expect(warnings[0]).toMatch(/shadows a builtin/);
  });

  it("omits description when absent", () => {
    const { commands } = resolveCustomCommands([cmd("x", "body")], builtins);
    expect(commands[0]!.description).toBeUndefined();
  });
});

describe("buildCustomPrompt", () => {
  it("trims args then substitutes", () => {
    expect(buildCustomPrompt({ body: "Echo $ARGUMENTS twice" }, "  hello world  ")).toBe(
      "Echo hello world twice",
    );
  });
});
