import { describe, it, expect } from "vitest";
import { splitSuggesterSections } from "./SlashSuggester.tsx";
import { buildSuggesterItems } from "../lib/slash-commands.ts";

describe("splitSuggesterSections", () => {
  const items = buildSuggesterItems(
    [
      { name: "compact", description: "c" },
      { name: "skills", description: "s" },
    ],
    [{ name: "explain", description: "e", body: "Explain $ARGUMENTS", layer: "workspace" }],
  );

  it("separates builtin from custom", () => {
    const { builtin, custom } = splitSuggesterSections(items);
    expect(builtin.map((i) => i.name)).toEqual(["compact", "skills"]);
    expect(custom.map((i) => i.name)).toEqual(["explain"]);
  });

  it("handles a builtin-only list (no custom section)", () => {
    const { custom } = splitSuggesterSections(
      buildSuggesterItems([{ name: "help", description: "h" }], []),
    );
    expect(custom).toHaveLength(0);
  });

  it("handles an empty list", () => {
    const { builtin, custom } = splitSuggesterSections([]);
    expect(builtin).toHaveLength(0);
    expect(custom).toHaveLength(0);
  });
});
