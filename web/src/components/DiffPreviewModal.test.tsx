import { describe, it, expect } from "vitest";
import { classifyDiffLine } from "./DiffPreviewModal.tsx";

describe("classifyDiffLine (UX gap A)", () => {
  it("classifies file-header lines as meta", () => {
    expect(classifyDiffLine("+++ b/a.txt")).toBe("meta");
    expect(classifyDiffLine("--- a/a.txt")).toBe("meta");
  });

  it("classifies hunk headers", () => {
    expect(classifyDiffLine("@@ -1,3 +1,3 @@")).toBe("hunk");
  });

  it("classifies additions and deletions", () => {
    expect(classifyDiffLine("+new line")).toBe("add");
    expect(classifyDiffLine("-old line")).toBe("del");
  });

  it("classifies unchanged context", () => {
    expect(classifyDiffLine(" unchanged")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });
});
