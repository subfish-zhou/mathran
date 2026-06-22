import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MATHRAN_DIR,
  SIGNATURE_FILE,
  SETTINGS_FILE,
  expandHome,
  isDangerousRoot,
  hasForbiddenSegment,
  resolveMathranRoot,
  initMathranRoot,
  validateMathranRoot,
  readSignature,
  looksLikeMathranRoot,
} from "./mathran-root.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-root-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("expandHome", () => {
  it("expands ~ and ~/x", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/proj", "/home/u")).toBe(path.join("/home/u", "proj"));
  });
  it("leaves absolute paths alone", () => {
    expect(expandHome("/abs/path", "/home/u")).toBe("/abs/path");
  });
});

describe("isDangerousRoot", () => {
  it("flags protected roots", () => {
    for (const p of ["/", "/etc", "/home", "/usr", "/tmp", "C:\\", "D:\\"]) {
      expect(isDangerousRoot(p)).toBe(true);
    }
  });
  it("allows subdirs of protected roots", () => {
    expect(isDangerousRoot("/home/alice")).toBe(false);
    expect(isDangerousRoot("/tmp/scratch")).toBe(false);
  });
  it("ignores a trailing slash", () => {
    expect(isDangerousRoot("/etc/")).toBe(true);
  });
});

describe("hasForbiddenSegment", () => {
  it("flags node_modules and .git", () => {
    expect(hasForbiddenSegment("/a/node_modules/b")).toBe(true);
    expect(hasForbiddenSegment("/a/.git/b")).toBe(true);
  });
  it("passes clean paths", () => {
    expect(hasForbiddenSegment("/a/b/.mathran")).toBe(false);
  });
});

describe("resolveMathranRoot", () => {
  it("auto-appends .mathran to a plain dir", () => {
    const r = resolveMathranRoot("/home/u/proj", { home: "/home/u" });
    expect(r.projectDir).toBe("/home/u/proj");
    expect(r.rootPath).toBe(path.join("/home/u/proj", MATHRAN_DIR));
  });
  it("does not double-append when path already ends in .mathran", () => {
    const r = resolveMathranRoot("/home/u/proj/.mathran", { home: "/home/u" });
    expect(r.rootPath).toBe("/home/u/proj/.mathran");
    expect(r.projectDir).toBe("/home/u/proj");
  });
  it("expands ~ before resolving", () => {
    const r = resolveMathranRoot("~/proj", { home: "/home/u" });
    expect(r.rootPath).toBe(path.join("/home/u/proj", MATHRAN_DIR));
  });
  it("rejects relative paths", () => {
    expect(() => resolveMathranRoot("relative/dir")).toThrow(/absolute/);
  });
  it("rejects dangerous roots (/etc)", () => {
    expect(() => resolveMathranRoot("/etc")).toThrow(/protected/);
  });
  it("rejects node_modules segment", () => {
    expect(() => resolveMathranRoot("/home/u/node_modules/x")).toThrow(/node_modules/);
  });
});

describe("initMathranRoot", () => {
  it("creates a fresh root with signature, gitignore, settings, skeleton", () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj);
    const res = initMathranRoot(proj, { version: "9.9.9" });
    expect(res.created).toBe(true);
    expect(fs.existsSync(path.join(res.rootPath, SIGNATURE_FILE))).toBe(true);
    expect(fs.existsSync(path.join(res.rootPath, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(res.rootPath, SETTINGS_FILE))).toBe(true);
    for (const sub of ["skills", "commands", "hooks"]) {
      expect(fs.existsSync(path.join(res.rootPath, sub))).toBe(true);
    }
    const sig = readSignature(res.rootPath);
    expect(sig?.version).toBe("9.9.9");
    expect(sig?.nonce.length).toBeGreaterThanOrEqual(8);
  });

  it("does not append twice when given .../.mathran", () => {
    const proj = path.join(tmp, "proj2");
    fs.mkdirSync(proj);
    const res = initMathranRoot(path.join(proj, ".mathran"), { version: "1.0.0" });
    expect(res.rootPath).toBe(path.join(proj, ".mathran"));
    expect(fs.existsSync(path.join(proj, ".mathran", ".mathran"))).toBe(false);
  });

  it("adopts an existing mathran root", () => {
    const proj = path.join(tmp, "proj3");
    fs.mkdirSync(proj);
    initMathranRoot(proj, { version: "1.0.0" });
    const again = initMathranRoot(proj, { version: "2.0.0" });
    expect(again.created).toBe(false);
    // signature preserved from first init
    expect(again.signature.version).toBe("1.0.0");
  });

  it("refuses to adopt a non-mathran existing directory", () => {
    const proj = path.join(tmp, "proj4");
    const rootPath = path.join(proj, MATHRAN_DIR);
    fs.mkdirSync(rootPath, { recursive: true });
    fs.writeFileSync(path.join(rootPath, "random.txt"), "hi");
    expect(() => initMathranRoot(proj, { version: "1.0.0" })).toThrow(/refusing/);
  });

  it("rejects when parent dir does not exist", () => {
    const missing = path.join(tmp, "does", "not", "exist");
    expect(() => initMathranRoot(missing, { version: "1.0.0" })).toThrow(
      /does not exist or is not/,
    );
  });

  it("rejects /etc via init", () => {
    expect(() => initMathranRoot("/etc", { version: "1.0.0" })).toThrow(/protected/);
  });
});

describe("validateMathranRoot + readSignature", () => {
  it("validates a freshly created root", () => {
    const proj = path.join(tmp, "v1");
    fs.mkdirSync(proj);
    initMathranRoot(proj, { version: "3.0.0" });
    const v = validateMathranRoot(proj);
    expect(v.signature.version).toBe("3.0.0");
  });

  it("throws on a malformed signature", () => {
    const proj = path.join(tmp, "v2");
    const rootPath = path.join(proj, MATHRAN_DIR);
    fs.mkdirSync(rootPath, { recursive: true });
    fs.writeFileSync(path.join(rootPath, SIGNATURE_FILE), JSON.stringify({ bad: true }));
    expect(() => readSignature(rootPath)).toThrow(/invalid signature/);
  });

  it("throws when root is missing", () => {
    expect(() => validateMathranRoot(path.join(tmp, "nope"))).toThrow(/does not exist/);
  });

  it("looksLikeMathranRoot detects settings.json only", () => {
    const rootPath = path.join(tmp, "v3", MATHRAN_DIR);
    fs.mkdirSync(rootPath, { recursive: true });
    expect(looksLikeMathranRoot(rootPath)).toBe(false);
    fs.writeFileSync(path.join(rootPath, SETTINGS_FILE), "{}");
    expect(looksLikeMathranRoot(rootPath)).toBe(true);
  });
});
