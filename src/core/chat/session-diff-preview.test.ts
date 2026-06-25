import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatSession, type ChatEvent } from "./session.js";
import { createWriteFileTool } from "./tools/write-file.js";
import { ApprovalBroker } from "./approval-broker.js";
import type { Rule } from "../approval/rules.js";
import type {
  WriteProposal,
  WriteProposalDecision,
} from "../approval/diff-preview.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../providers/llm.js";

function responseOf(chunks: LLMStreamChunk[]): LLMResponse {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

class ScriptedLLM implements LLMProvider {
  private i = 0;
  constructor(private turns: LLMStreamChunk[][]) {}
  async describe() {
    return { name: "scripted" };
  }
  async chat(_req: LLMRequest): Promise<LLMResponse> {
    const turn = this.turns[this.i] ?? [{ type: "done", finishReason: "stop" }];
    this.i += 1;
    return responseOf(turn);
  }
}

function callWriteThenStop(p: string, content: string): LLMStreamChunk[][] {
  return [
    [
      {
        type: "tool-call",
        id: "w1",
        name: "write_file",
        argsDelta: JSON.stringify({ path: p, content }),
      },
      { type: "done", finishReason: "tool_calls" },
    ],
    [
      { type: "text", delta: "ok" },
      { type: "done", finishReason: "stop" },
    ],
  ];
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function previewBroker(rules: Rule[]): ApprovalBroker {
  return new ApprovalBroker({
    policy: "on-request",
    learning: false,
    inlineRules: rules,
  });
}

const PREVIEW_RULE: Rule = {
  tool: "write_file",
  pathGlob: "**",
  action: "allow",
  requireDiffPreview: true,
};

describe("ChatSession × diff preview (requireDiffPreview)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-diff-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeSession(
    llm: ScriptedLLM,
    broker: ApprovalBroker,
    resolver?: (p: WriteProposal) => Promise<WriteProposalDecision>,
  ): ChatSession {
    return new ChatSession({
      llm,
      tools: [createWriteFileTool({ workspace: dir })],
      approvalBroker: broker,
      workspace: dir,
      toolContext: { workspace: dir },
      ...(resolver ? { writeProposalResolver: resolver } : {}),
    });
  }

  it("emits propose-write and writes the file on accept", async () => {
    const target = "out.txt";
    const llm = new ScriptedLLM(callWriteThenStop(target, "hello world\n"));
    const seen: WriteProposal[] = [];
    const session = makeSession(llm, previewBroker([PREVIEW_RULE]), async (p) => {
      seen.push(p);
      return { outcome: "accept" };
    });

    const events = await collect(session.send("go"));

    const proposeEv = events.find((e) => e.type === "propose-write") as any;
    expect(proposeEv).toBeTruthy();
    expect(proposeEv.proposal.path).toBe(target);
    expect(proposeEv.proposal.mode).toBe("create");
    expect(proposeEv.proposal.diffText).toContain("+hello world");
    expect(proposeEv.proposal.toolCallId).toBe("w1");

    const resolvedEv = events.find(
      (e) => e.type === "propose-write-resolved",
    ) as any;
    expect(resolvedEv.decision.outcome).toBe("accept");

    expect(seen.length).toBe(1);
    const written = await fs.readFile(path.join(dir, target), "utf-8");
    expect(written).toBe("hello world\n");
  });

  it("does NOT write the file on decline and reports a rejection", async () => {
    const target = "nope.txt";
    const llm = new ScriptedLLM(callWriteThenStop(target, "secret\n"));
    const session = makeSession(llm, previewBroker([PREVIEW_RULE]), async () => ({
      outcome: "decline",
    }));

    const events = await collect(session.send("go"));

    await expect(fs.readFile(path.join(dir, target), "utf-8")).rejects.toThrow();
    const tr = events.find((e) => e.type === "tool-result") as any;
    expect(tr.ok).toBe(false);
    expect(tr.content).toContain("rejected by user");
  });

  it("writes the user-edited content on accept-with-edit", async () => {
    const target = "edited.txt";
    const llm = new ScriptedLLM(callWriteThenStop(target, "model version\n"));
    const session = makeSession(llm, previewBroker([PREVIEW_RULE]), async () => ({
      outcome: "accept",
      editedContent: "user version\n",
    }));

    await collect(session.send("go"));

    const written = await fs.readFile(path.join(dir, target), "utf-8");
    expect(written).toBe("user version\n");
  });

  it("backward compat: an allow rule WITHOUT requireDiffPreview writes silently", async () => {
    const target = "silent.txt";
    const llm = new ScriptedLLM(callWriteThenStop(target, "data\n"));
    const plainRule: Rule = {
      tool: "write_file",
      pathGlob: "**",
      action: "allow",
    };
    let resolverCalls = 0;
    const session = makeSession(llm, previewBroker([plainRule]), async () => {
      resolverCalls++;
      return { outcome: "accept" };
    });

    const events = await collect(session.send("go"));

    expect(resolverCalls).toBe(0);
    expect(events.find((e) => e.type === "propose-write")).toBeUndefined();
    const written = await fs.readFile(path.join(dir, target), "utf-8");
    expect(written).toBe("data\n");
  });

  it("no writeProposalResolver wired: requireDiffPreview degrades to silent write", async () => {
    const target = "degrade.txt";
    const llm = new ScriptedLLM(callWriteThenStop(target, "x\n"));
    const session = makeSession(llm, previewBroker([PREVIEW_RULE]));

    const events = await collect(session.send("go"));

    expect(events.find((e) => e.type === "propose-write")).toBeUndefined();
    const written = await fs.readFile(path.join(dir, target), "utf-8");
    expect(written).toBe("x\n");
  });

  it("a workspace-escaping path is NOT previewed and is rejected by the tool", async () => {
    const llm = new ScriptedLLM(callWriteThenStop("../escape.txt", "evil\n"));
    let resolverCalls = 0;
    const session = makeSession(llm, previewBroker([PREVIEW_RULE]), async () => {
      resolverCalls++;
      return { outcome: "accept" };
    });

    const events = await collect(session.send("go"));

    expect(resolverCalls).toBe(0);
    expect(events.find((e) => e.type === "propose-write")).toBeUndefined();
    const tr = events.find((e) => e.type === "tool-result") as any;
    expect(tr.ok).toBe(false);
    expect(tr.content).toContain("escapes workspace");
    // The file must not have been written anywhere above the workspace.
    await expect(
      fs.readFile(path.join(dir, "..", "escape.txt"), "utf-8"),
    ).rejects.toThrow();
  });
});
