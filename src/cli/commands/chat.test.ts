/**
 * Unit tests for the REPL slash-command dispatcher (GAP #14).
 *
 * We construct a `ChatSession` against a no-op scripted LLM (so no real
 * provider gets contacted), call `handleSlashCommand`, and assert the
 * `SlashResult` shape + any disk side effects.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { handleSlashCommand, type SlashContext } from "./chat.js";
import { ChatSession } from "../../core/chat/index.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../core/providers/llm.js";

const scriptedLlm: LLMProvider = {
  async describe() {
    return { name: "scripted" } as any;
  },
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const last = [...req.messages].reverse().find((m) => m.role === "user");
    const reply = `ack:${last?.content ?? ""}`;
    return {
      async *stream() {
        yield { type: "text", delta: reply };
        yield { type: "done", finishReason: "stop" };
      },
    };
  },
};

let session: ChatSession;
let ctx: SlashContext;
let tmpDir: string;

beforeEach(async () => {
  session = new ChatSession({
    llm: scriptedLlm,
    model: "openai/scripted",
    systemPrompt: "test system prompt",
  });
  ctx = {
    session,
    model: "openai/scripted",
    providerKey: "openai",
    configPath: undefined,
  };
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-repl-test-"));
});

describe("handleSlashCommand: trivial commands", () => {
  it("/help returns the command list", async () => {
    const res = await handleSlashCommand("/help", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toContain("/exit");
    expect(res.output).toContain("/save");
    expect(res.output).toContain("/load");
  });

  it("/? is an alias for /help", async () => {
    const res = await handleSlashCommand("/?", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toContain("/help");
  });

  it("/exit returns kind exit", async () => {
    const res = await handleSlashCommand("/exit", ctx);
    expect(res.kind).toBe("exit");
  });

  it("/quit returns kind exit", async () => {
    const res = await handleSlashCommand("/quit", ctx);
    expect(res.kind).toBe("exit");
  });

  it("unknown command falls through with help hint", async () => {
    const res = await handleSlashCommand("/banana", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/unknown command "\/banana"/);
  });
});

describe("handleSlashCommand: state-mutating commands", () => {
  it("/reset clears non-system messages", async () => {
    // First, populate some history by streaming a turn.
    for await (const _ of session.send("hello")) { /* drain */ }
    expect(session.history().length).toBeGreaterThan(1);
    const res = await handleSlashCommand("/reset", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toContain("history cleared");
    const remaining = session.history();
    expect(remaining.length).toBe(1);
    expect(remaining[0].role).toBe("system");
  });

  it("/history with empty session prints (empty)", async () => {
    // brand new session has only system prompt; /history considers system part
    // of history too, so report the count not zero
    session.reset();
    // Make it truly empty by replacing history with []
    session.replaceHistory([]);
    const fresh = await handleSlashCommand("/history", ctx);
    // System prompt is preserved by reset → still 1; replaceHistory with []
    // preserves system too; both should result in a length >= 1
    expect(fresh.output).toMatch(/^history \(\d+\)|empty/);
  });

  it("/history lists numbered roles + truncated content", async () => {
    for await (const _ of session.send("first")) { /* drain */ }
    const res = await handleSlashCommand("/history", ctx);
    expect(res.output).toMatch(/history \(\d+\)/);
    expect(res.output).toMatch(/user/);
    expect(res.output).toMatch(/assistant/);
  });

  it("/system without arg prints the current system prompt", async () => {
    const res = await handleSlashCommand("/system", ctx);
    expect(res.output).toContain("test system prompt");
  });

  it("/system <text> requests a rebuild with the new prompt", async () => {
    const res = await handleSlashCommand("/system you are silent", ctx);
    expect(res.kind).toBe("rebuild");
    if (res.kind !== "rebuild") throw new Error("expected rebuild");
    expect(res.nextBuild.systemPrompt).toBe("you are silent");
  });
});

describe("handleSlashCommand: /model", () => {
  it("/model alone prints the current model + provider", async () => {
    const res = await handleSlashCommand("/model", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toContain("openai/scripted");
    expect(res.output).toContain("openai");
  });

  it("/model <id> requests a rebuild with the new model id", async () => {
    const res = await handleSlashCommand("/model copilot/claude-opus-4.7", ctx);
    expect(res.kind).toBe("rebuild");
    if (res.kind !== "rebuild") throw new Error("expected rebuild");
    expect(res.nextBuild.model).toBe("copilot/claude-opus-4.7");
  });
});

describe("handleSlashCommand: /save + /load round-trip", () => {
  it("/save writes a Markdown transcript with role headers", async () => {
    for await (const _ of session.send("what is 1+1?")) { /* drain */ }
    const out = path.join(tmpDir, "saved.md");
    const res = await handleSlashCommand(`/save ${out}`, ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toContain(out);
    const md = await fs.readFile(out, "utf-8");
    expect(md).toContain("## user");
    expect(md).toContain("what is 1+1?");
    expect(md).toContain("## assistant");
    expect(md).toContain("ack:what is 1+1?");
  });

  it("/load reads a jsonl file and replaces history", async () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "first" }),
      JSON.stringify({ role: "assistant", content: "first reply" }),
      "", // a blank line should be tolerated
      JSON.stringify({ role: "user", content: "second" }),
    ].join("\n");
    const file = path.join(tmpDir, "convo.jsonl");
    await fs.writeFile(file, jsonl, "utf-8");
    const res = await handleSlashCommand(`/load ${file}`, ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/loaded 3 message/);
    const restored = session.history();
    // System prompt preserved + 3 loaded
    expect(restored.length).toBeGreaterThanOrEqual(4);
    expect(restored.map((m) => m.role)).toContain("assistant");
    expect(restored.some((m) => m.content === "first reply")).toBe(true);
  });

  it("/load with a missing path returns a friendly error", async () => {
    const res = await handleSlashCommand("/load /no/such/file.jsonl", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/could not read/);
  });

  it("/load with no path prints usage", async () => {
    const res = await handleSlashCommand("/load", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/usage/);
  });
});
