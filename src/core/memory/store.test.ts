/**
 * Tests for the topic-based memory store (gap #3).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  listTopics,
  readTopic,
  writeTopic,
  appendTopic,
  searchTopics,
  assertValidTopic,
} from "./store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-memstore-test-"));
});

describe("memory store", () => {
  it("listTopics returns [] when no memory dir exists", async () => {
    expect(await listTopics(workspace)).toEqual([]);
  });

  it("writeTopic creates the file at the canonical path and readTopic reads it", async () => {
    await writeTopic(workspace, "prefs", "likes tea\n");
    const onDisk = await fs.readFile(
      path.join(workspace, ".mathran", "memory", "prefs.md"),
      "utf-8",
    );
    expect(onDisk).toBe("likes tea\n");
    expect(await readTopic(workspace, "prefs")).toBe("likes tea\n");
  });

  it("listTopics returns sorted topic names without .md", async () => {
    await writeTopic(workspace, "zeta", "z");
    await writeTopic(workspace, "alpha", "a");
    expect(await listTopics(workspace)).toEqual(["alpha", "zeta"]);
  });

  it("readTopic returns null for a missing topic", async () => {
    expect(await readTopic(workspace, "nope")).toBeNull();
  });

  it("appendTopic creates and then appends lines with newline normalization", async () => {
    await appendTopic(workspace, "log", "first");
    await appendTopic(workspace, "log", "second");
    expect(await readTopic(workspace, "log")).toBe("first\nsecond\n");
  });

  it("appendTopic inserts a separating newline when existing content lacks one", async () => {
    await writeTopic(workspace, "log", "nonewline");
    await appendTopic(workspace, "log", "added");
    expect(await readTopic(workspace, "log")).toBe("nonewline\nadded\n");
  });

  it("searchTopics finds case-insensitive substring hits with line numbers", async () => {
    await writeTopic(workspace, "a", "alpha\nBeta line\ngamma");
    await writeTopic(workspace, "b", "nothing here");
    const hits = await searchTopics(workspace, "beta");
    expect(hits).toEqual([{ topic: "a", lineNum: 2, line: "Beta line" }]);
  });

  it("assertValidTopic rejects path traversal and separators", () => {
    expect(() => assertValidTopic("../escape")).toThrow();
    expect(() => assertValidTopic("a/b")).toThrow();
    expect(() => assertValidTopic("")).toThrow();
    expect(() => assertValidTopic("ok-topic_1")).not.toThrow();
  });
});
