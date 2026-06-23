import { describe, expect, it } from "vitest";

import {
  ACCEPTED_EXTENSIONS,
  acceptAttribute,
  acceptedMimeTypes,
  formatFileSize,
  isAcceptedFilename,
} from "./file-upload-helpers.ts";

describe("formatFileSize", () => {
  it("formats bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
  });

  it("formats kilobytes with one decimal", () => {
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("formats megabytes with one decimal", () => {
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("guards against negative / non-finite input", () => {
    expect(formatFileSize(-5)).toBe("0 B");
    expect(formatFileSize(NaN)).toBe("0 B");
  });
});

describe("acceptAttribute", () => {
  it("joins the accepted extensions", () => {
    expect(acceptAttribute()).toBe(".pdf,.tex,.bib,.md,.txt");
  });
});

describe("acceptedMimeTypes", () => {
  it("includes pdf and tex types", () => {
    const types = acceptedMimeTypes();
    expect(types).toContain("application/pdf");
    expect(types).toContain("application/x-tex");
    expect(types.length).toBeGreaterThan(0);
  });
});

describe("isAcceptedFilename", () => {
  it("accepts the documented extensions (case-insensitive)", () => {
    for (const ext of ACCEPTED_EXTENSIONS) {
      expect(isAcceptedFilename(`paper${ext}`)).toBe(true);
      expect(isAcceptedFilename(`PAPER${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it("rejects other extensions", () => {
    expect(isAcceptedFilename("malware.exe")).toBe(false);
    expect(isAcceptedFilename("image.png")).toBe(false);
    expect(isAcceptedFilename("noext")).toBe(false);
  });
});
