import { describe, it, expect } from "vitest";
import { reasoningSummary } from "./ReasoningBlock.tsx";

describe("reasoningSummary (UX gap B)", () => {
  it("renders a collapsed expand hint when not streaming", () => {
    expect(reasoningSummary(1234, false)).toBe(
      "💭 1234 reasoning chars (click to expand)",
    );
  });

  it("uses the singular 'char' for a single character", () => {
    expect(reasoningSummary(1, false)).toBe("💭 1 reasoning char (click to expand)");
  });

  it("shows a live thinking label while streaming", () => {
    expect(reasoningSummary(42, true)).toBe("💭 thinking… 42 chars");
  });
});
