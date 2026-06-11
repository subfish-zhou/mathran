import { describe, it, expect } from "vitest";
import {
  mapVerificationStatus,
  mapVerificationSeverity,
  mapWorkspaceEffortType,
  mapWSStatus,
  extractArxivIdFromUrl,
  chunkString,
} from "./init-parsers";

describe("mapVerificationStatus", () => {
  it("maps verified", () => expect(mapVerificationStatus("verified")).toBe("verified"));
  it("maps Verified (case-insensitive)", () => expect(mapVerificationStatus("Verified")).toBe("verified"));
  it("maps incorrect", () => expect(mapVerificationStatus("incorrect")).toBe("incorrect"));
  it("maps corrected", () => expect(mapVerificationStatus("corrected")).toBe("corrected"));
  it("defaults to unverified", () => expect(mapVerificationStatus("unknown")).toBe("unverified"));
  it("defaults for empty string", () => expect(mapVerificationStatus("")).toBe("unverified"));
});

describe("mapVerificationSeverity", () => {
  it("maps correct", () => expect(mapVerificationSeverity("correct")).toBe("correct"));
  it("maps major", () => expect(mapVerificationSeverity("Major")).toBe("major"));
  it("maps critical", () => expect(mapVerificationSeverity("CRITICAL")).toBe("critical"));
  it("defaults to minor", () => expect(mapVerificationSeverity("something")).toBe("minor"));
});

describe("mapWorkspaceEffortType", () => {
  it("maps valid types", () => {
    expect(mapWorkspaceEffortType("REFERENCE")).toBe("REFERENCE");
    expect(mapWorkspaceEffortType("CONSTRUCTION")).toBe("CONSTRUCTION");
    expect(mapWorkspaceEffortType("ESTIMATE")).toBe("ESTIMATE");
    expect(mapWorkspaceEffortType("PROOF_ATTEMPT")).toBe("PROOF_ATTEMPT");
    expect(mapWorkspaceEffortType("REDUCTION")).toBe("REDUCTION");
    expect(mapWorkspaceEffortType("COMPUTATION")).toBe("COMPUTATION");
    expect(mapWorkspaceEffortType("FORMALIZATION")).toBe("FORMALIZATION");
    expect(mapWorkspaceEffortType("AUXILIARY")).toBe("AUXILIARY");
  });
  it("maps DEAD_END to PROOF_ATTEMPT", () => expect(mapWorkspaceEffortType("DEAD_END")).toBe("PROOF_ATTEMPT"));
  it("case-insensitive", () => expect(mapWorkspaceEffortType("estimate")).toBe("ESTIMATE"));
  it("defaults to CONSTRUCTION for unknown", () => expect(mapWorkspaceEffortType("INVALID")).toBe("CONSTRUCTION"));
});

describe("mapWSStatus", () => {
  it("maps DEAD_END", () => expect(mapWSStatus("DEAD_END")).toBe("DEAD_END"));
  it("maps VERIFIED", () => expect(mapWSStatus("VERIFIED")).toBe("VERIFIED"));
  it("maps REFERENCE", () => expect(mapWSStatus("REFERENCE")).toBe("REFERENCE"));
  it("maps ERRATUM", () => expect(mapWSStatus("ERRATUM")).toBe("ERRATUM"));
  it("defaults to DRAFT", () => expect(mapWSStatus("unknown")).toBe("DRAFT"));
  it("case-insensitive", () => expect(mapWSStatus("dead_end")).toBe("DEAD_END"));
});

describe("extractArxivIdFromUrl", () => {
  it("extracts from valid url", () => expect(extractArxivIdFromUrl("https://arxiv.org/abs/2301.12345")).toBe("2301.12345"));
  it("extracts 4-digit suffix", () => expect(extractArxivIdFromUrl("https://arxiv.org/abs/2301.1234")).toBe("2301.1234"));
  it("returns null for undefined", () => expect(extractArxivIdFromUrl(undefined)).toBeNull());
  it("returns null for non-arxiv url", () => expect(extractArxivIdFromUrl("https://example.com")).toBeNull());
  it("returns null for empty string", () => expect(extractArxivIdFromUrl("")).toBeNull());
});

describe("chunkString", () => {
  it("chunks a string", () => expect(chunkString("abcdef", 2)).toEqual(["ab", "cd", "ef"]));
  it("handles remainder", () => expect(chunkString("abcde", 2)).toEqual(["ab", "cd", "e"]));
  it("handles empty string", () => expect(chunkString("", 5)).toEqual([]));
  it("chunk larger than string", () => expect(chunkString("ab", 10)).toEqual(["ab"]));
  it("handles unicode", () => expect(chunkString("你好世界", 2)).toEqual(["你好", "世界"]));
});
