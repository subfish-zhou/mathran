import { describe, expect, it } from "vitest";

import { buildWikiIndex } from "./build-index.js";
import { threePagePlan } from "./fixtures.js";

const written = [
  { slug: "overview", title: "Overview" },
  { slug: "circle-method", title: "Circle Method" },
  { slug: "bibliography", title: "Bibliography" },
];

describe("buildWikiIndex", () => {
  it("renders a title from the global thesis and a one-sentence intro", () => {
    const md = buildWikiIndex(threePagePlan(), written);
    expect(md).toContain("# Wiki — Goldbach via circle method");
    expect(md).toContain("3-page survey");
  });

  it("lists pages in pageOrder, numbered, with purposes as captions", () => {
    const md = buildWikiIndex(threePagePlan(), written);
    expect(md).toContain("1. [Overview](./overview.md)");
    expect(md).toContain("2. [Circle Method](./circle-method.md)");
    expect(md).toContain("3. [Bibliography](./bibliography.md)");
    expect(md).toContain("Purpose of circle-method");
    // ordering: overview index before circle-method index
    expect(md.indexOf("overview.md")).toBeLessThan(md.indexOf("circle-method.md"));
  });

  it("emits next/prev nav chips between consecutive pages", () => {
    const md = buildWikiIndex(threePagePlan(), written);
    expect(md).toContain("[next →](./circle-method.md)");
    expect(md).toContain("[← prev](./overview.md)");
    expect(md).toContain("[← prev](./circle-method.md)");
    // first page has no prev; last page has no next
    const lines = md.split("\n");
    const firstNav = lines.find((l) => l.includes("./circle-method.md") && l.includes("next →"));
    expect(firstNav).not.toMatch(/← prev/);
  });

  it("restricts the TOC to pages that were actually written", () => {
    const md = buildWikiIndex(threePagePlan(), [
      { slug: "overview", title: "Overview" },
      { slug: "bibliography", title: "Bibliography" },
    ]);
    expect(md).toContain("overview.md");
    expect(md).toContain("bibliography.md");
    expect(md).not.toContain("circle-method.md");
    // nav now links overview → bibliography directly
    expect(md).toContain("[next →](./bibliography.md)");
  });
});
