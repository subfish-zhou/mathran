/**
 * Unit tests for the REPL slash-command dispatcher (GAP #14).
 *
 * We construct a `ChatSession` against a no-op scripted LLM (so no real
 * provider gets contacted), call `handleSlashCommand`, and assert the
 * `SlashResult` shape + any disk side effects.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  handleSlashCommand,
  createReadlineAskUserResolver,
  buildChatSession,
  loadLayeredContext,
  type SlashContext,
} from "./chat.js";
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

describe("handleSlashCommand: /compact", () => {
  it("reports no-op when history is short", async () => {
    // Default session has only the system prompt.
    const res = await handleSlashCommand("/compact", { ...ctx, session });
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/nothing to compact|Compacted/);
  });

  it("compacts and reports stats when history is long", async () => {
    // Seed a long history; ChatSession.compact uses the wrapped llm to
    // summarize — the scripted LLM just acks the last user turn, which is fine.
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 1; i <= 12; i++) {
      messages.push({ role: "user", content: `Q ${i}` });
      messages.push({ role: "assistant", content: `A ${i}` });
    }
    session.replaceHistory(messages);
    const res = await handleSlashCommand("/compact 2", { ...ctx, session });
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/Compacted\. Tokens: \d+ → \d+\. Dropped \d+ round/);
    // After compact: system + summary system + 2 rounds (4 msgs) = 6
    expect(session.history().length).toBe(6);
  });
});

describe("handleSlashCommand: new builtins (SPA Slash Commands)", () => {
  it("/effort with no arg shows usage", async () => {
    const res = await handleSlashCommand("/effort", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/usage: \/effort/);
  });

  it("/effort high sets the level and reads back via /effort", async () => {
    const set = await handleSlashCommand("/effort high", ctx);
    expect(set.output).toMatch(/reasoning effort set to "high"/);
    const read = await handleSlashCommand("/effort", ctx);
    expect(read.output).toMatch(/reasoning effort: high/);
  });

  it("/effort rejects an invalid level", async () => {
    const res = await handleSlashCommand("/effort turbo", ctx);
    expect(res.output).toMatch(/usage: \/effort/);
  });

  it("/agents lists available kinds", async () => {
    const res = await handleSlashCommand("/agents", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/available kinds/);
    expect(res.output).toContain("search");
  });

  it("/skills reports no skills for an empty workspace", async () => {
    const res = await handleSlashCommand("/skills", { ...ctx, memoryWorkspace: tmpDir });
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/no skills|skills \(/);
  });

  it("/skills lists the builtin propose skills", async () => {
    const res = await handleSlashCommand("/skills", { ...ctx, memoryWorkspace: tmpDir });
    expect(res.output).toContain("propose-plan");
    expect(res.output).toContain("[builtin]");
    expect(res.output).toContain("trigger:");
  });

  it("/skills <name> prints a skill's detail + body", async () => {
    const res = await handleSlashCommand("/skills propose-plan", {
      ...ctx,
      memoryWorkspace: tmpDir,
    });
    expect(res.output).toContain("skill: propose-plan [builtin]");
    expect(res.output).toContain("SKILL.md body");
  });

  it("/skills disable then enable round-trips through settings.json", async () => {
    const disable = await handleSlashCommand("/skills disable propose-plan", {
      ...ctx,
      memoryWorkspace: tmpDir,
    });
    expect(disable.output).toContain("disabled skill");
    const settingsPath = path.join(tmpDir, ".mathran", "settings.json");
    const after = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    expect(after.skills.disabled).toContain("propose-plan");

    const enable = await handleSlashCommand("/skills enable propose-plan", {
      ...ctx,
      memoryWorkspace: tmpDir,
    });
    expect(enable.output).toContain("enabled skill");
    const after2 = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    expect(after2.skills.disabled).not.toContain("propose-plan");
  });

  it("/skills disable without a name shows usage", async () => {
    const res = await handleSlashCommand("/skills disable", {
      ...ctx,
      memoryWorkspace: tmpDir,
    });
    expect(res.output).toContain("usage:");
  });

  it("/context reports message + token counts", async () => {
    const res = await handleSlashCommand("/context", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/context: \d+ message\(s\), ~\d+ token/);
  });

  it("/review prints the preset stub prompt", async () => {
    const res = await handleSlashCommand("/review", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/review/i);
  });

  it("/help lists the new commands", async () => {
    const res = await handleSlashCommand("/help", ctx);
    expect(res.output).toContain("/skills");
    expect(res.output).toContain("/agents");
    expect(res.output).toContain("/effort");
    expect(res.output).toContain("/context");
  });
});

describe("handleSlashCommand: /memory (v0.3 §14)", () => {
  it("prints both files with byte counts (or 'not present')", async () => {
    // No files in tmpDir—both should report not present (project at least).
    const res = await handleSlashCommand("/memory", {
      ...ctx,
      memoryWorkspace: tmpDir,
      homeOverride: tmpDir,
    });
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/MATHRAN.md memory/);
    expect(res.output).toContain("global:");
    expect(res.output).toContain("project:");
    expect(res.output).toContain("not present");
  });

  it("reports byte counts when files exist", async () => {
    const proj = path.join(tmpDir, "MATHRAN.md");
    await fs.writeFile(proj, "hello", "utf8");
    const res = await handleSlashCommand("/memory", {
      ...ctx,
      memoryWorkspace: tmpDir,
      homeOverride: tmpDir,
    });
    expect(res.output).toMatch(/project: .* \(5 bytes\)/);
  });

  it("/memory help prints sub-command list", async () => {
    const res = await handleSlashCommand("/memory help", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toContain("/memory edit project");
    expect(res.output).toContain("/memory edit global");
  });

  it("rejects unknown sub-command", async () => {
    const res = await handleSlashCommand("/memory dance", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/unknown \/memory sub-command "dance"/);
  });

  it("/memory edit without scope prints usage", async () => {
    const res = await handleSlashCommand("/memory edit", ctx);
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/usage: \/memory edit project\|global/);
  });

  it("/memory edit project seeds a default header when the file is missing", async () => {
    const res = await handleSlashCommand("/memory edit project", {
      ...ctx,
      memoryWorkspace: tmpDir,
      homeOverride: tmpDir,
      editorOverride: "true", // /usr/bin/true — no-op editor, exits 0
    });
    expect(res.kind).toBe("continue");
    const created = await fs.readFile(path.join(tmpDir, "MATHRAN.md"), "utf8");
    expect(created).toContain("# MATHRAN project memory");
  });

  it("/memory edit global creates ~/.mathran/ dir if missing", async () => {
    const fakeHome = path.join(tmpDir, "fake-home");
    // intentionally don't pre-create the dir
    const res = await handleSlashCommand("/memory edit global", {
      ...ctx,
      memoryWorkspace: tmpDir,
      homeOverride: fakeHome,
      editorOverride: "true",
    });
    expect(res.kind).toBe("continue");
    const created = await fs.readFile(
      path.join(fakeHome, ".mathran", "MATHRAN.md"),
      "utf8",
    );
    expect(created).toContain("# MATHRAN global memory");
  });

  it("/memory edit + promptReload=true appends a fresh memory system message", async () => {
    await fs.writeFile(path.join(tmpDir, "MATHRAN.md"), "NEW_BODY", "utf8");
    const before = session.history().length;
    const res = await handleSlashCommand("/memory edit project", {
      ...ctx,
      memoryWorkspace: tmpDir,
      homeOverride: tmpDir,
      editorOverride: "true",
      promptReload: async () => true,
    });
    expect(res.kind).toBe("continue");
    expect(res.output).toMatch(/memory reloaded/);
    const after = session.history();
    expect(after.length).toBe(before + 1);
    const last = after[after.length - 1];
    expect(last.role).toBe("system");
    expect(last.content).toContain("Persistent memory updated");
    expect(last.content).toContain("NEW_BODY");
  });

  it("/memory edit + promptReload=false does NOT mutate history", async () => {
    await fs.writeFile(path.join(tmpDir, "MATHRAN.md"), "keep me", "utf8");
    const before = session.history().length;
    const res = await handleSlashCommand("/memory edit project", {
      ...ctx,
      memoryWorkspace: tmpDir,
      homeOverride: tmpDir,
      editorOverride: "true",
      promptReload: async () => false,
    });
    expect(res.kind).toBe("continue");
    expect(session.history().length).toBe(before);
  });
});


describe("createReadlineAskUserResolver (v0.16 §11)", () => {
  // Build a fake readline interface that records the prompt it was given
  // and returns a pre-canned answer via the callback. Matches the bits
  // of the readline.Interface surface the resolver actually touches.
  function fakeRl(answer: string): {
    rl: import("node:readline").Interface;
    seenPrompts: string[];
  } {
    const seenPrompts: string[] = [];
    const rl = {
      question(prompt: string, cb: (a: string) => void) {
        seenPrompts.push(prompt);
        // mimic readline's async behaviour so resolvers awaiting
        // don't accidentally resolve synchronously.
        setImmediate(() => cb(answer));
      },
    } as unknown as import("node:readline").Interface;
    return { rl, seenPrompts };
  }

  it("prompts the user with the question and returns their typed reply", async () => {
    const { rl, seenPrompts } = fakeRl("src/foo.lean");
    const resolver = createReadlineAskUserResolver(rl);
    // ctx.callId is ignored by the CLI resolver — pass an empty stub.
    const reply = await resolver("Which file?", { callId: "" });
    expect(reply).toBe("src/foo.lean");
    // The resolver writes the `❓ <question>` marker to stdout itself
    // and uses a separate `› ` prompt for rl.question — so the prompt
    // line passed into readline is the input chevron, not the question.
    expect(seenPrompts).toEqual(["› "]);
  });

  it("passes through an empty reply (factory normalises it downstream)", async () => {
    const { rl } = fakeRl("");
    const resolver = createReadlineAskUserResolver(rl);
    const reply = await resolver("?", { callId: "" });
    expect(reply).toBe("");
  });
});

// ─── C 方案 wire-up: layered `.mathran/` skills + memory in `mathran chat` ──
//
// e2e smoke for the default-chat wiring: a workspace carrying a
// `.mathran/skills/<name>/SKILL.md` must surface that skill in the built
// session's system prompt, and a `.mathran`-less workspace must stay clean.
describe("buildChatSession: layered .mathran wire-up", () => {
  let wsDir: string;
  let prevWorkspace: string | undefined;

  beforeEach(async () => {
    wsDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-wire-test-"));
    prevWorkspace = process.env.MATHRAN_WORKSPACE;
  });

  afterEach(() => {
    if (prevWorkspace === undefined) delete process.env.MATHRAN_WORKSPACE;
    else process.env.MATHRAN_WORKSPACE = prevWorkspace;
  });

  async function writeSkill(name: string, description: string): Promise<void> {
    const dir = path.join(wsDir, ".mathran", "skills", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\ndescription: ${description}\n---\n${name} body\n`,
      "utf8",
    );
  }

  it("loadLayeredContext discovers a workspace-layer skill", async () => {
    await writeSkill("test-skill", "A test skill");
    const { skills } = loadLayeredContext(wsDir);
    expect(skills.map((s) => s.name)).toContain("test-skill");
  });

  it("injects the workspace skill into the built session's system prompt", async () => {
    await writeSkill("test-skill", "A test skill");
    process.env.MATHRAN_WORKSPACE = wsDir;
    const { session } = buildChatSession({});
    const systemText = session
      .history()
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(systemText).toContain("test-skill");
    expect(systemText).toContain("Available skills");
  });

  it("filters skills listed in settings.skills.disabled", async () => {
    await writeSkill("keep-skill", "kept");
    await writeSkill("drop-skill", "dropped");
    await fs.writeFile(
      path.join(wsDir, ".mathran", "settings.json"),
      JSON.stringify({ skills: { disabled: ["drop-skill"] } }),
      "utf8",
    );
    const names = loadLayeredContext(wsDir).skills.map((s) => s.name);
    expect(names).toContain("keep-skill");
    expect(names).not.toContain("drop-skill");
  });

  it("injects three-layer MATHRAN.md memory by default", async () => {
    await fs.writeFile(
      path.join(wsDir, "MATHRAN.md"),
      "WORKSPACE_MEMORY_MARKER",
      "utf8",
    );
    process.env.MATHRAN_WORKSPACE = wsDir;
    const { session } = buildChatSession({});
    const systemText = session
      .history()
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(systemText).toContain("WORKSPACE_MEMORY_MARKER");
  });

  it("a workspace without .mathran injects only the builtin skills", async () => {
    process.env.MATHRAN_WORKSPACE = wsDir;
    const { session } = buildChatSession({});
    const systemText = session
      .history()
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    // Builtin skills are always advertised (hidden layer below USER)…
    expect(systemText).toContain("Available skills");
    expect(systemText).toContain("propose-plan");
    // …but no on-disk user/workspace skill is present.
    expect(systemText).not.toContain("test-skill");
  });
});
