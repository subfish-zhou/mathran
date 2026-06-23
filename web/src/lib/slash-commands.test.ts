import { describe, it, expect } from "vitest";
import {
  isSlashTrigger,
  parseSlashInput,
  activeSlashPrefix,
  buildSuggesterItems,
  filterCommands,
  moveSelection,
  parseCdTarget,
  FALLBACK_BUILTINS,
  type SuggesterItem,
} from "./slash-commands.ts";

describe("FALLBACK_BUILTINS includes /diff and /rewind", () => {
  it("exposes diff + rewind with checkpoint-aware copy", () => {
    const byName = new Map(FALLBACK_BUILTINS.map((b) => [b.name, b]));
    expect(byName.has("diff")).toBe(true);
    expect(byName.has("rewind")).toBe(true);
    expect(byName.get("diff")!.description).toMatch(/checkpoint/i);
    expect(byName.get("rewind")!.description).toMatch(/checkpoint/i);
  });

  it("stays alphabetically sorted by name", () => {
    const names = FALLBACK_BUILTINS.map((b) => b.name);
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("isSlashTrigger", () => {
  it("matches leading slash only", () => {
    expect(isSlashTrigger("/co")).toBe(true);
    expect(isSlashTrigger("hello")).toBe(false);
    expect(isSlashTrigger("")).toBe(false);
  });
});

describe("parseSlashInput", () => {
  it("returns null for non-slash text", () => {
    expect(parseSlashInput("hello world")).toBeNull();
  });
  it("parses name + args", () => {
    expect(parseSlashInput("/explain monads now")).toEqual({
      name: "explain",
      args: "monads now",
    });
  });
  it("lowercases the name and trims args", () => {
    expect(parseSlashInput("/CD   projects/x  ")).toEqual({ name: "cd", args: "projects/x" });
  });
  it("handles a bare command with no args", () => {
    expect(parseSlashInput("/skills")).toEqual({ name: "skills", args: "" });
  });
});

describe("activeSlashPrefix", () => {
  it("returns the typed prefix before a space", () => {
    expect(activeSlashPrefix("/co")).toBe("co");
    expect(activeSlashPrefix("/")).toBe("");
  });
  it("returns null once a space is typed (name locked in)", () => {
    expect(activeSlashPrefix("/cd projects/x")).toBeNull();
  });
  it("returns null for non-slash text", () => {
    expect(activeSlashPrefix("hello")).toBeNull();
  });
});

describe("buildSuggesterItems + filterCommands", () => {
  const items = buildSuggesterItems(
    [
      { name: "compact", description: "c" },
      { name: "context", description: "ctx" },
      { name: "skills", description: "s" },
    ],
    [{ name: "explain", description: "e", body: "Explain $ARGUMENTS", layer: "workspace" }],
  );

  it("puts custom commands after builtin", () => {
    expect(items.map((i) => i.source)).toEqual(["builtin", "builtin", "builtin", "custom"]);
  });

  it("filters /co to compact + context", () => {
    const out = filterCommands(items, "co");
    expect(out.map((i) => i.name)).toEqual(["compact", "context"]);
  });

  it("empty prefix returns all", () => {
    expect(filterCommands(items, "")).toHaveLength(4);
  });

  it("custom command carries its body", () => {
    const explain = items.find((i) => i.name === "explain")!;
    expect(explain.body).toBe("Explain $ARGUMENTS");
  });
});

describe("moveSelection", () => {
  it("wraps forward and backward", () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
  });
  it("is safe for empty lists", () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});

describe("parseCdTarget sandbox", () => {
  it("accepts projects/<slug>", () => {
    expect(parseCdTarget("projects/smoke")).toEqual({ slug: "smoke" });
  });
  it("accepts a bare slug", () => {
    expect(parseCdTarget("smoke")).toEqual({ slug: "smoke" });
  });
  it("rejects absolute paths", () => {
    expect(parseCdTarget("/etc")).toMatchObject({ error: expect.stringContaining("absolute") });
  });
  it("rejects parent traversal", () => {
    expect(parseCdTarget("projects/../etc")).toMatchObject({
      error: expect.stringContaining(".."),
    });
  });
  it("rejects empty input", () => {
    expect(parseCdTarget("  ")).toMatchObject({ error: expect.stringContaining("usage") });
  });
});

describe("SuggesterItem shape", () => {
  it("builtin item has no body", () => {
    const items: SuggesterItem[] = buildSuggesterItems([{ name: "help", description: "h" }], []);
    expect(items[0]!.body).toBeUndefined();
  });
});
