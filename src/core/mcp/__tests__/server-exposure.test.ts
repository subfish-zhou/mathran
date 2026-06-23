import { describe, it, expect } from "vitest";
import {
  decideExposureFor,
  decideExposure,
  selectExposedTools,
  isMutatingRisk,
  isNeverExposed,
  type ExposureCandidate,
} from "../server-exposure.js";
import { McpServerExposureConfigSchema } from "../schema.js";
import type { ToolSpec } from "../../chat/session.js";

const cfg = (over: Record<string, unknown> = {}) =>
  McpServerExposureConfigSchema.parse(over);

describe("server-exposure policy gate", () => {
  it("never exposes bash even when allow-listed + exposeMutating", () => {
    const d = decideExposureFor(
      { name: "bash", riskClass: "exec" },
      cfg({ exposeMutating: true, allowedTools: ["bash"] }),
    );
    expect(d.exposed).toBe(false);
    expect(d.reason).toContain("denylist");
    expect(isNeverExposed("bash")).toBe(true);
  });

  it("exposes read tools by default", () => {
    const d = decideExposureFor({ name: "read_file", riskClass: "read" }, cfg());
    expect(d.exposed).toBe(true);
  });

  it("hides mutating tools by default (read-only)", () => {
    const w = decideExposureFor({ name: "write_file", riskClass: "write" }, cfg());
    const e = decideExposureFor({ name: "edit_file", riskClass: "write" }, cfg());
    expect(w.exposed).toBe(false);
    expect(e.exposed).toBe(false);
    expect(w.reason).toContain("exposeMutating");
  });

  it("exposes mutating tools when exposeMutating is true", () => {
    const w = decideExposureFor(
      { name: "write_file", riskClass: "write" },
      cfg({ exposeMutating: true }),
    );
    expect(w.exposed).toBe(true);
  });

  it("classifies write/exec/net as mutating, read/undefined as not", () => {
    expect(isMutatingRisk("write")).toBe(true);
    expect(isMutatingRisk("exec")).toBe(true);
    expect(isMutatingRisk("net")).toBe(true);
    expect(isMutatingRisk("read")).toBe(false);
    expect(isMutatingRisk(undefined)).toBe(false);
  });

  it("allowedTools acts as an intersection filter", () => {
    const c = cfg({ allowedTools: ["read_file"] });
    expect(decideExposureFor({ name: "read_file", riskClass: "read" }, c).exposed).toBe(true);
    const other = decideExposureFor({ name: "read_file_summary", riskClass: "read" }, c);
    expect(other.exposed).toBe(false);
    expect(other.reason).toContain("allowedTools");
  });

  it("denylist beats allowedTools", () => {
    const c = cfg({ allowedTools: ["bash", "read_file"], exposeMutating: true });
    expect(decideExposureFor({ name: "bash", riskClass: "exec" }, c).exposed).toBe(false);
  });

  it("decideExposure maps every candidate", () => {
    const cands: ExposureCandidate[] = [
      { name: "read_file", riskClass: "read" },
      { name: "bash", riskClass: "exec" },
      { name: "write_file", riskClass: "write" },
    ];
    const decisions = decideExposure(cands, cfg());
    expect(decisions.map((d) => d.exposed)).toEqual([true, false, false]);
  });

  it("selectExposedTools filters ToolSpecs without mutating them", () => {
    const specs: ToolSpec[] = [
      { name: "read_file", riskClass: "read", parameters: {}, execute: async () => ({ ok: true, content: "" }) },
      { name: "bash", riskClass: "exec", parameters: {}, execute: async () => ({ ok: true, content: "" }) },
      { name: "write_file", riskClass: "write", parameters: {}, execute: async () => ({ ok: true, content: "" }) },
    ];
    const ro = selectExposedTools(specs, cfg());
    expect(ro.map((s) => s.name)).toEqual(["read_file"]);
    const rw = selectExposedTools(specs, cfg({ exposeMutating: true }));
    expect(rw.map((s) => s.name)).toEqual(["read_file", "write_file"]);
  });
});
