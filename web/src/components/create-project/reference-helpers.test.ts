import { describe, expect, it } from "vitest";

import { classifyReference, isValidReference } from "./reference-helpers.ts";

describe("classifyReference", () => {
  it("recognizes a bare arXiv id", () => {
    expect(classifyReference("2301.10828")).toEqual({ type: "arxiv", normalized: "2301.10828" });
  });

  it("recognizes an arXiv id with prefix and version, normalizing case", () => {
    expect(classifyReference("arXiv:1234.5678v2")).toEqual({
      type: "arxiv",
      normalized: "1234.5678v2",
    });
  });

  it("recognizes a bare DOI", () => {
    expect(classifyReference("10.1103/PhysRevLett.96.010401")).toEqual({
      type: "doi",
      normalized: "10.1103/PhysRevLett.96.010401",
    });
  });

  it("recognizes a doi.org URL and extracts the bare DOI", () => {
    expect(classifyReference("https://doi.org/10.1000/xyz123")).toEqual({
      type: "doi",
      normalized: "10.1000/xyz123",
    });
  });

  it("recognizes a doi: prefixed DOI", () => {
    expect(classifyReference("doi:10.1000/abc")).toEqual({ type: "doi", normalized: "10.1000/abc" });
  });

  it("recognizes a plain http(s) URL", () => {
    expect(classifyReference("https://example.com/paper.pdf")).toEqual({
      type: "url",
      normalized: "https://example.com/paper.pdf",
    });
  });

  it("classifies empty/whitespace input as unknown with empty normalized", () => {
    expect(classifyReference("   ")).toEqual({ type: "unknown", normalized: "" });
  });

  it("classifies arbitrary text as unknown", () => {
    expect(classifyReference("just some words")).toEqual({
      type: "unknown",
      normalized: "just some words",
    });
  });
});

describe("isValidReference", () => {
  it("rejects empty input", () => {
    expect(isValidReference("")).toBe(false);
  });

  it("rejects unrecognized text", () => {
    expect(isValidReference("hello world")).toBe(false);
  });

  it("accepts arXiv / DOI / URL", () => {
    expect(isValidReference("2301.10828")).toBe(true);
    expect(isValidReference("10.1000/xyz")).toBe(true);
    expect(isValidReference("http://example.com")).toBe(true);
  });
});
