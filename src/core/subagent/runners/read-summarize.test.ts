/**
 * Tests for the read_summarize subagent runner (v0.2 §9).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_MAX_FILE_BYTES,
  READ_SUMMARIZE_PROMPT_TEMPLATE,
  TRUNCATION_MARKER,
  buildSummarizePrompt,
  looksBinary,
  readSummarizeRunner,
  resolveInsideWorkspace,
  type ReadSummarizeRunnerInput,
} from "./read-summarize.js";
import { SubagentRegistry } from "../registry.js";
import { SubagentScheduler } from "../scheduler.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";

/**
 * Mock LLM: records every request it sees and replies with a configurable
 * stream. Tests can assert on `seen[0].messages[1].content` (the user prompt)
 * to verify the runner built the right prompt — that's the integration point
 * we care about.
 */
class MockLLM implements LLMProvider {
  readonly seen: LLMRequest[] = [];
  shouldThrow: Error | null = null;
  constructor(private response: string) {}
  async describe() {
    return { name: "mock-llm" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.seen.push(req);
    if (this.shouldThrow) throw this.shouldThrow;
    const resp = this.response;
    return {
      async *stream(): AsyncIterable<LLMStreamChunk> {
        yield { type: "text", delta: resp };
        yield { type: "done", finishReason: "stop" };
      },
    };
  }
}

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-readsum-"));
});
afterEach(async () => {
  if (workspace && fssync.existsSync(workspace)) {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

/** Build a scheduler wired with just the read_summarize runner. */
function buildScheduler(): SubagentScheduler {
  const reg = new SubagentRegistry();
  reg.register(readSummarizeRunner);
  return new SubagentScheduler({ workspace, registry: reg });
}

// ─── Pure-helper unit tests ────────────────────────────────────────────────

describe("read_summarize — resolveInsideWorkspace", () => {
  it("accepts a simple relative path", () => {
    const r = resolveInsideWorkspace("/tmp/ws", "notes.txt");
    expect(r).toBe(path.resolve("/tmp/ws/notes.txt"));
  });
  it("accepts an absolute path inside the workspace", () => {
    const r = resolveInsideWorkspace("/tmp/ws", "/tmp/ws/sub/x.md");
    expect(r).toBe(path.resolve("/tmp/ws/sub/x.md"));
  });
  it("rejects ../ escape", () => {
    expect(resolveInsideWorkspace("/tmp/ws", "../etc/passwd")).toBeNull();
    expect(resolveInsideWorkspace("/tmp/ws", "../../etc/passwd")).toBeNull();
  });
  it("rejects absolute path outside workspace", () => {
    expect(resolveInsideWorkspace("/tmp/ws", "/etc/passwd")).toBeNull();
  });
  it("rejects sibling-prefix attack (/wsX vs /ws)", () => {
    expect(resolveInsideWorkspace("/tmp/ws", "/tmp/wsX/notes.txt")).toBeNull();
  });
});

describe("read_summarize — looksBinary", () => {
  it("returns false for pure ASCII", () => {
    expect(looksBinary(Buffer.from("hello world\nthis is text"))).toBe(false);
  });
  it("returns false for UTF-8 multi-byte text", () => {
    expect(looksBinary(Buffer.from("héllo 世界 ⚡️"))).toBe(false);
  });
  it("returns true when any NUL byte is in the first 1KB", () => {
    expect(looksBinary(Buffer.from([0x48, 0x00, 0x49]))).toBe(true);
  });
  it("returns true for typical binary header (PNG IHDR with NUL chunk-length bytes)", () => {
    // Full PNG magic followed by an IHDR chunk; the 4-byte chunk length and
    // multi-byte width/height fields contain NULs in real PNG files.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // magic
      0x00, 0x00, 0x00, 0x0d,                         // IHDR length = 13
      0x49, 0x48, 0x44, 0x52,                         // "IHDR"
      0x00, 0x00, 0x00, 0x10,                         // width=16
    ]);
    expect(looksBinary(png)).toBe(true);
  });
});

describe("read_summarize — buildSummarizePrompt", () => {
  it("inserts all three placeholders verbatim", () => {
    const out = buildSummarizePrompt("foo.md", "What is X?", "BODY");
    expect(out).toContain("`foo.md`");
    expect(out).toContain("> What is X?");
    expect(out).toContain("BODY");
    // And the closing instruction is present.
    expect(out).toContain("Write a concise summary");
  });
});

// ─── Runner integration tests ──────────────────────────────────────────────

describe("read_summarize runner — normal small file", () => {
  it("reads the file, calls the LLM, writes the artifact, returns the summary", async () => {
    const sched = buildScheduler();
    const filePath = path.join(workspace, "doc.txt");
    const body = "Mathran v0.2 ships a subagent infrastructure with a compact runner.\n";
    await fs.writeFile(filePath, body);
    const llm = new MockLLM("Mathran v0.2 has a subagent system; compact runner included.");

    const input: ReadSummarizeRunnerInput = {
      path: "doc.txt",
      question: "What does v0.2 ship?",
      llm,
    };
    const result = await sched.dispatch({
      type: "read_summarize",
      input: input as unknown as Record<string, unknown>,
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe(
      "Mathran v0.2 has a subagent system; compact runner included.",
    );
    expect(result.artifactPath).toMatch(
      /^\.mathran\/subagents\/sub-[0-9a-f]+\/source\.txt$/,
    );
    // Artifact contains the original bytes.
    const artifactAbs = path.join(workspace, result.artifactPath!);
    const onDisk = await fs.readFile(artifactAbs, "utf8");
    expect(onDisk).toBe(body);
    // LLM saw the right prompt + tools=[] (no recursion).
    expect(llm.seen.length).toBe(1);
    const userMsg = llm.seen[0].messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("doc.txt");
    expect(userMsg?.content).toContain("What does v0.2 ship?");
    expect(userMsg?.content).toContain(body.trim());
    expect(llm.seen[0].tools).toEqual([]);
  });
});

describe("read_summarize runner — large file truncation", () => {
  it("truncates the prompt body and writes only readBytes to the artifact", async () => {
    const sched = buildScheduler();
    const filePath = path.join(workspace, "big.txt");
    // 3 KB of distinct content (with no NULs).
    const big = "X".repeat(3072);
    await fs.writeFile(filePath, big);
    const llm = new MockLLM("Summary of big.txt");

    const input: ReadSummarizeRunnerInput = {
      path: "big.txt",
      question: "Describe this file briefly",
      maxFileBytes: 1024, // force truncation
      llm,
    };
    const result = await sched.dispatch({
      type: "read_summarize",
      input: input as unknown as Record<string, unknown>,
    });

    expect(result.status).toBe("ok");
    // Prompt body contains the marker.
    const userMsg = llm.seen[0].messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain(TRUNCATION_MARKER.trim());
    // The body in the prompt is the first 1024 bytes of X's, NOT all 3072.
    // The fence between ``` and ``` should hold exactly 1024 X chars + the
    // marker; checking length is the cleanest assertion.
    const xRun = (userMsg?.content ?? "").match(/X+/);
    expect(xRun?.[0].length).toBe(1024);
    // Artifact has exactly the read bytes (1024 X chars), not 3072.
    const artifactAbs = path.join(workspace, result.artifactPath!);
    const onDisk = await fs.readFile(artifactAbs, "utf8");
    expect(onDisk.length).toBe(1024);
    expect(onDisk).toBe("X".repeat(1024));
  });
});

describe("read_summarize runner — file not found", () => {
  it("returns status:error with a human-readable summary", async () => {
    const sched = buildScheduler();
    const llm = new MockLLM("unused");
    const result = await sched.dispatch({
      type: "read_summarize",
      input: {
        path: "does-not-exist.txt",
        question: "anything",
        llm,
      } as unknown as Record<string, unknown>,
    });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("File not found");
    expect(result.artifactPath).toBeNull();
    // LLM was never called.
    expect(llm.seen.length).toBe(0);
  });
});

describe("read_summarize runner — path escape", () => {
  it("blocks ../../etc/passwd before reading or calling the LLM", async () => {
    const sched = buildScheduler();
    const llm = new MockLLM("unused");
    const result = await sched.dispatch({
      type: "read_summarize",
      input: {
        path: "../../etc/passwd",
        question: "what is in this file",
        llm,
      } as unknown as Record<string, unknown>,
    });
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/escape|workspace/i);
    expect(result.artifactPath).toBeNull();
    expect(llm.seen.length).toBe(0);
  });

  it("blocks an absolute path outside the workspace", async () => {
    const sched = buildScheduler();
    const llm = new MockLLM("unused");
    const result = await sched.dispatch({
      type: "read_summarize",
      input: {
        path: "/etc/hostname",
        question: "what is this",
        llm,
      } as unknown as Record<string, unknown>,
    });
    expect(result.status).toBe("error");
    expect(result.artifactPath).toBeNull();
    expect(llm.seen.length).toBe(0);
  });
});

describe("read_summarize runner — binary file", () => {
  it("rejects a file with a NUL byte in the first 1KB", async () => {
    const sched = buildScheduler();
    const filePath = path.join(workspace, "blob.bin");
    await fs.writeFile(
      filePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
    );
    const llm = new MockLLM("unused");
    const result = await sched.dispatch({
      type: "read_summarize",
      input: {
        path: "blob.bin",
        question: "what is this",
        llm,
      } as unknown as Record<string, unknown>,
    });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Binary file not supported");
    expect(llm.seen.length).toBe(0);
  });
});

describe("read_summarize runner — LLM throws", () => {
  it("returns status:error with the failure reason in the summary", async () => {
    const sched = buildScheduler();
    const filePath = path.join(workspace, "doc.txt");
    await fs.writeFile(filePath, "some text");
    const llm = new MockLLM("unused");
    llm.shouldThrow = new Error("upstream 503");
    const result = await sched.dispatch({
      type: "read_summarize",
      input: {
        path: "doc.txt",
        question: "what is this",
        llm,
      } as unknown as Record<string, unknown>,
    });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("upstream 503");
    // Artifact was still written (we got the read bytes before the LLM call).
    expect(result.artifactPath).toMatch(/source\.txt$/);
  });
});

describe("read_summarize runner — custom maxFileBytes", () => {
  it("honors a custom maxFileBytes setting", async () => {
    const sched = buildScheduler();
    const filePath = path.join(workspace, "med.txt");
    await fs.writeFile(filePath, "A".repeat(500));
    const llm = new MockLLM("ok");
    const result = await sched.dispatch({
      type: "read_summarize",
      input: {
        path: "med.txt",
        question: "what",
        maxFileBytes: 100,
        llm,
      } as unknown as Record<string, unknown>,
    });
    expect(result.status).toBe("ok");
    const artifactAbs = path.join(workspace, result.artifactPath!);
    const onDisk = await fs.readFile(artifactAbs, "utf8");
    // Exactly 100 bytes of A's were persisted.
    expect(onDisk).toBe("A".repeat(100));
    // And the prompt body shows the truncation marker because 500 > 100.
    const userMsg = llm.seen[0].messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain(TRUNCATION_MARKER.trim());
  });
});

// Sanity: the runner is registered with the right type string.
describe("read_summarize runner — registration", () => {
  it("exposes type='read_summarize'", () => {
    expect(readSummarizeRunner.type).toBe("read_summarize");
  });
});

// Defensive: the exported defaults are sensible.
describe("read_summarize runner — defaults", () => {
  it("DEFAULT_MAX_FILE_BYTES is 1 MiB", () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(1_048_576);
  });
  it("READ_SUMMARIZE_PROMPT_TEMPLATE contains all three placeholders", () => {
    expect(READ_SUMMARIZE_PROMPT_TEMPLATE).toContain("{path}");
    expect(READ_SUMMARIZE_PROMPT_TEMPLATE).toContain("{question}");
    expect(READ_SUMMARIZE_PROMPT_TEMPLATE).toContain("{body}");
  });
});
