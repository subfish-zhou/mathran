/**
 * Tests for the v0.17 mathub-parity chat-attachment injection — the
 * server half of the composer file-upload flow.
 *
 * Drives the real Hono server end-to-end (POST /api/uploads → POST a chat
 * message with `attachments:[…]`) and inspects the persisted history to
 * assert the user message was rewritten the right way.
 *
 * Style mirrors `uploads.test.ts` and `serve.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  startServer,
  type RunningServer,
} from "./serve.js";
import {
  MAX_TEXT_ATTACHMENT_BYTES,
  buildUserMessageWithAttachments,
  BadAttachmentError,
} from "./chat-attachments.js";
import { ChatSession } from "../core/chat/index.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../core/providers/llm.js";

/**
 * Tiny scripted LLM: yields a single empty assistant turn then stops.
 * We don't care about the assistant body for these tests — we just need
 * the server to round-trip the message through `session.send()` so it
 * lands in the persisted history.
 */
function nullLlm(): LLMProvider {
  return {
    async describe() {
      return { name: "null" };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

/**
 * Vision-aware fake LLM that also records the most recent `messages`
 * payload so the test can assert image parts survived the round-trip from
 * the SPA → chat-attachments → ChatSession.send() pipeline.
 *
 * `supportsVision = true` flips the server's `providerSupportsVision()`
 * probe in `serve.ts` so attachments render as `ContentPart[]`.
 */
function visionLlm(): LLMProvider & { lastMessages: LLMRequest["messages"] | null } {
  const adapter = {
    lastMessages: null as LLMRequest["messages"] | null,
    supportsVision: true as const,
    async describe() {
      return { name: "vision-fake" };
    },
    async chat(req: LLMRequest): Promise<LLMResponse> {
      adapter.lastMessages = req.messages;
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
  return adapter;
}

let workspace: string;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-chat-attach-"));
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    chatSessionFactory: ({ model }) =>
      new ChatSession({ llm: nullLlm(), model }),
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * Upload a single file via `POST /api/uploads` and return the JSON the
 * SPA would feed back into `attachments:[]` on the next chat POST.
 */
async function uploadFile(
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<{ path: string; filename: string; mimeType: string; size: number }> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([bytes as unknown as BlobPart], { type: mimeType }),
    filename,
  );
  const res = await fetch(`${base}/api/uploads`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as {
    path: string;
    filename: string;
    mimeType: string;
    size: number;
  };
}

/**
 * Send a chat message + attachments via `POST /api/global-chat`, drain
 * the SSE stream so the server flushes history, and return the
 * conversationId the route minted on the first frame.
 *
 * We don't parse the SSE payloads beyond pulling `conversationId` out of
 * the first `event: session` frame — the assertion target is the
 * persisted history blob on disk, which we read separately.
 */
async function postChatMessage(
  message: string,
  attachments: Array<{ path: string; filename: string; mimeType: string }>,
): Promise<{ status: number; conversationId: string | null; errorBody: any }> {
  const res = await fetch(`${base}/api/global-chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, attachments }),
  });

  // Non-2xx: return the JSON error body for the caller's assertions.
  // SSE 200 paths fall through below.
  if (!res.ok) {
    let errorBody: any = null;
    try { errorBody = await res.json(); } catch { /* ignore */ }
    return { status: res.status, conversationId: null, errorBody };
  }

  // Drain the SSE stream — server only flushes history to disk after the
  // stream closes, so we have to wait for EOF.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let conversationId: string | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (!conversationId) {
      // Look for the first `event: session` frame.
      const m = buf.match(/event: session\ndata: (.+)/);
      if (m) {
        try {
          const data = JSON.parse(m[1]);
          conversationId = data.conversationId ?? data.sessionId ?? null;
        } catch { /* ignore */ }
      }
    }
  }
  return { status: res.status, conversationId, errorBody: null };
}

/** Read the persisted history file for a global-scope conversation. */
async function readHistory(
  conversationId: string,
): Promise<Array<{ role: string; content: string }>> {
  // Layout (see src/core/chat/store.ts):
  //   global:  <workspace>/.mathran/global-chat/<id>.jsonl
  // Each line is one serialized LLMMessage.
  const file = path.join(
    workspace,
    ".mathran",
    "global-chat",
    `${conversationId}.jsonl`,
  );
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const messages = lines.map((l) => JSON.parse(l) as { role: string; content: any });
  // Normalize the `content` field — provider-shape messages may carry
  // tool-result blocks, but for our purposes we only inspect the user
  // message which is always plain string content.
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));
}

describe("buildUserMessageWithAttachments (unit)", () => {
  it("returns body unchanged when no attachments are supplied", async () => {
    const out = await buildUserMessageWithAttachments(workspace, "hello", []);
    expect(out).toBe("hello");
    const out2 = await buildUserMessageWithAttachments(workspace, "hi", undefined);
    expect(out2).toBe("hi");
  });

  it("rejects attachments outside the uploads sandbox", async () => {
    // Pick a real file the user owns (any /etc file) — even though it
    // exists, it lives outside `<workspace>/.mathran/uploads/`, so the
    // realpath check must reject it.
    await expect(
      buildUserMessageWithAttachments(workspace, "x", [
        { path: "/etc/hostname", filename: "hostname", mimeType: "text/plain" },
      ]),
    ).rejects.toBeInstanceOf(BadAttachmentError);
  });

  it("rejects non-existent paths even when they pretend to be in uploads/", async () => {
    const fake = path.join(workspace, ".mathran", "uploads", "no-such-file.txt");
    await expect(
      buildUserMessageWithAttachments(workspace, "x", [
        { path: fake, filename: "no-such-file.txt", mimeType: "text/plain" },
      ]),
    ).rejects.toBeInstanceOf(BadAttachmentError);
  });

  // ---- C-round Commit 3 vision tests ----------------------------------
  it("enableVision=true: image attachment returns ContentPart[] with base64 image part", async () => {
    // Write a tiny image directly under uploads (skip the upload route).
    const uploadsDir = path.join(workspace, ".mathran", "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    const imgPath = path.join(uploadsDir, "vision-test.png");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(imgPath, pngBytes);

    const result = await buildUserMessageWithAttachments(
      workspace,
      "what is this?",
      [{ path: imgPath, filename: "vision-test.png", mimeType: "image/png" }],
      { enableVision: true },
    );
    expect(Array.isArray(result)).toBe(true);
    const parts = result as Array<
      | { type: "text"; text: string }
      | { type: "image"; mimeType: string; dataBase64: string }
    >;
    // [text-with-body, image-part]
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "what is this?" });
    expect(parts[1].type).toBe("image");
    expect((parts[1] as any).mimeType).toBe("image/png");
    expect((parts[1] as any).dataBase64).toBe(pngBytes.toString("base64"));
  });

  it("enableVision=true but oversize image: degrades to text marker with size hint", async () => {
    // 5 MB > MAX_INLINE_IMAGE_BYTES (4 MB) — the renderer must NOT inline.
    const uploadsDir = path.join(workspace, ".mathran", "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    const imgPath = path.join(uploadsDir, "huge.png");
    const big = Buffer.alloc(5 * 1024 * 1024, 0xaa);
    await fs.writeFile(imgPath, big);

    const result = await buildUserMessageWithAttachments(
      workspace,
      "check",
      [{ path: imgPath, filename: "huge.png", mimeType: "image/png" }],
      { enableVision: true },
    );
    // Falls back to a string — not ContentPart[].
    expect(typeof result).toBe("string");
    expect(result as string).toContain("too-large-for-inline-vision");
    expect(result as string).toContain("[Image: huge.png");
  });

  it("enableVision=false: image attachment stays a `[Image: ...]` text marker (legacy)", async () => {
    const uploadsDir = path.join(workspace, ".mathran", "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    const imgPath = path.join(uploadsDir, "legacy.png");
    await fs.writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await buildUserMessageWithAttachments(
      workspace,
      "hi",
      [{ path: imgPath, filename: "legacy.png", mimeType: "image/png" }],
      { enableVision: false },
    );
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/^hi\n\n\[Image: legacy\.png @ /);
  });
});

describe("POST /api/global-chat with attachments", () => {
  it("textual attachment: emits a path-only marker (no inline content)", async () => {
    // 2026-06-25 — Codex/OpenClaw parity: text attachments are NOT inlined
    // anymore. The chat sees a path marker and pulls the content with
    // `read_file` on demand. Test asserts the new behaviour.
    const body = "# Hello\n\nThis is a markdown attachment.\n";
    const up = await uploadFile("hello.md", "text/markdown", new TextEncoder().encode(body));

    const send = await postChatMessage("Look at this file", [up]);
    expect(send.status).toBe(200);
    expect(send.conversationId).toBeTruthy();

    const history = await readHistory(send.conversationId!);
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toMatch(/^Look at this file\n\n\[Attachment: hello\.md\]\n/);
    expect(userMsg!.content).toMatch(/  path: .*hello\.md/);
    expect(userMsg!.content).toMatch(/  size: \d+ bytes/);
    expect(userMsg!.content).toMatch(/  peek: # Hello/);
    expect(userMsg!.content).toMatch(/→ Use `read_file path=/);
    // Raw body NOT inlined verbatim — peek strips newlines.
    expect(userMsg!.content).not.toContain(body);
    expect(userMsg!.content).not.toMatch(/\[Image:/);
    expect(userMsg!.content).not.toMatch(/\[Binary:/);
  });

  it("image attachment: surfaces `[Image: …]` marker without raw bytes", async () => {
    // 8-byte PNG signature — the marker should NOT contain these bytes
    // because we don't inline images. The model just learns "an image
    // is attached".
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const up = await uploadFile("diagram.png", "image/png", png);

    const send = await postChatMessage("What's in this diagram?", [up]);
    expect(send.status).toBe(200);

    const history = await readHistory(send.conversationId!);
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toMatch(/\[Image: diagram\.png @ /);
    // Raw PNG signature bytes must NOT appear in the inline message.
    // Look for the literal `\x89PNG` prefix as a UTF-8-ish string.
    expect(userMsg!.content).not.toContain("\x89PNG");
    expect(userMsg!.content).not.toMatch(/\[Attachment: diagram\.png\]/);
  });

  it("oversize text attachment: still emits path-only marker (size visible)", async () => {
    // 2026-06-25 — Codex/OpenClaw parity: oversize file is NOT truncated
    // and inlined; the path-only marker just shows the size, and the
    // model uses `read_file` with offset/limit to pull whatever segments
    // it actually needs. So this test now verifies the size marker
    // matches the upload size rather than checking for truncation.
    const big = "a".repeat(MAX_TEXT_ATTACHMENT_BYTES + 50 * 1024);
    const up = await uploadFile("big.txt", "text/plain", new TextEncoder().encode(big));

    const send = await postChatMessage("Summarise this", [up]);
    expect(send.status).toBe(200);

    const history = await readHistory(send.conversationId!);
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    // Header + path marker present.
    expect(userMsg!.content).toContain("[Attachment: big.txt]");
    expect(userMsg!.content).toMatch(/  path: .*big\.txt/);
    // Size matches the upload — model can decide whether it's worth
    // reading at all.
    const expectedSize = MAX_TEXT_ATTACHMENT_BYTES + 50 * 1024;
    expect(userMsg!.content).toContain(`size: ${expectedSize} bytes`);
    // No truncation marker (we don't inline anymore).
    expect(userMsg!.content).not.toMatch(/\[truncated\]/);
    // The body is NOT inlined — message body should be radically
    // smaller than the file (header + path + size + peek + hint ≈
    // a few hundred bytes, vs 250 KB).
    expect(userMsg!.content.length).toBeLessThan(2_000);
  });

  it("400 on bad attachment path (escape attempt)", async () => {
    const res = await postChatMessage("hack", [
      { path: "/etc/passwd", filename: "passwd", mimeType: "text/plain" },
    ]);
    expect(res.status).toBe(400);
    expect(res.errorBody?.error).toMatch(/outside uploads sandbox|not found/);
  });

  it("400 on bad attachment path (non-existent inside uploads/)", async () => {
    const fake = path.join(workspace, ".mathran", "uploads", "ghost-file.txt");
    const res = await postChatMessage("test", [
      { path: fake, filename: "ghost-file.txt", mimeType: "text/plain" },
    ]);
    expect(res.status).toBe(400);
    expect(res.errorBody?.error).toMatch(/not found/);
  });

  it("400 when both message body and attachments are empty", async () => {
    const res = await fetch(`${base}/api/global-chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "", attachments: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/message is required/);
  });

  it("accepts a send with empty body + a single attachment (attachments-only)", async () => {
    // Composer enables Send when text is empty but at least one
    // attachment is queued. The server must not 400 in that case.
    const up = await uploadFile(
      "notes.txt",
      "text/plain",
      new TextEncoder().encode("just a note"),
    );
    const send = await postChatMessage("", [up]);
    expect(send.status).toBe(200);

    const history = await readHistory(send.conversationId!);
    const userMsg = history.find((m) => m.role === "user");
    // Body is empty → the user message starts directly with the
    // attachment block (no leading blank line).
    expect(userMsg!.content.startsWith("[Attachment: notes.txt]\n")).toBe(true);
    expect(userMsg!.content).toContain("just a note");
  });
});

describe("POST /api/global-chat with attachments (C-round vision)", () => {
  let visionWorkspace: string;
  let visionServer: RunningServer;
  let visionBase: string;
  let lastVisionLlm: ReturnType<typeof visionLlm>;

  beforeAll(async () => {
    visionWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-vision-attach-"));
    visionServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace: visionWorkspace,
      chatSessionFactory: ({ model }) => {
        lastVisionLlm = visionLlm();
        return new ChatSession({ llm: lastVisionLlm, model });
      },
    });
    visionBase = visionServer.url;
  });

  afterAll(async () => {
    await visionServer.close();
    await fs.rm(visionWorkspace, { recursive: true, force: true });
  });

  async function uploadVision(
    filename: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<{ path: string; filename: string; mimeType: string; size: number }> {
    const form = new FormData();
    form.set(
      "file",
      new Blob([bytes as unknown as BlobPart], { type: mimeType }),
      filename,
    );
    const res = await fetch(`${visionBase}/api/uploads`, { method: "POST", body: form });
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  }

  async function postChatVision(
    message: string,
    attachments: Array<{ path: string; filename: string; mimeType: string; size?: number }>,
  ): Promise<{ status: number; conversationId: string | null }> {
    const res = await fetch(`${visionBase}/api/global-chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, attachments }),
    });
    if (res.status !== 200) {
      return { status: res.status, conversationId: null };
    }
    let conversationId: string | null = null;
    // Drain the SSE stream so the kernel actually runs the round.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      const sessIdx = buf.indexOf("event: session");
      if (conversationId === null && sessIdx >= 0) {
        const m = buf.slice(sessIdx).match(/"conversationId":"([^"]+)"/);
        if (m) conversationId = m[1];
      }
    }
    return { status: res.status, conversationId };
  }

  it("vision-enabled provider: image attachment reaches LLM as ContentPart[] image part", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const up = await uploadVision("see-me.png", "image/png", png);
    const { status, conversationId } = await postChatVision("describe this please", [up]);
    expect(status).toBe(200);
    expect(conversationId).not.toBeNull();

    // The fake LLM captured `req.messages`; the LAST user turn should
    // carry a ContentPart[] with one image part.
    const captured = lastVisionLlm.lastMessages;
    expect(captured).not.toBeNull();
    const userTurn = captured!.find((m) => m.role === "user")!;
    expect(Array.isArray(userTurn.content)).toBe(true);
    const parts = userTurn.content as Array<{ type: string; mimeType?: string }>;
    const imgPart = parts.find((p) => p.type === "image");
    expect(imgPart).toBeDefined();
    expect(imgPart!.mimeType).toBe("image/png");

    // History persistence: .jsonl flattens the ContentPart[] to a text
    // marker so disk usage stays bounded.
    const file = path.join(
      visionWorkspace,
      ".mathran",
      "global-chat",
      `${conversationId}.jsonl`,
    );
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    const userLine = lines.find((l: any) => l.role === "user")!;
    expect(typeof userLine.content).toBe("string");
    expect(userLine.content).toContain("[Image: image/png]");
    expect(userLine.content).toContain("describe this please");
  });

  it("vision-enabled provider: textual attachment still collapses to a plain string user turn", async () => {
    // No image → enableVision doesn't matter; the legacy string path runs.
    const up = await uploadVision(
      "plain.txt",
      "text/plain",
      new TextEncoder().encode("hello world"),
    );
    const { status } = await postChatVision("summarize", [up]);
    expect(status).toBe(200);
    const userTurn = lastVisionLlm.lastMessages!.find((m) => m.role === "user")!;
    expect(typeof userTurn.content).toBe("string");
    expect(userTurn.content as string).toContain("summarize");
    expect(userTurn.content as string).toContain("[Attachment: plain.txt]");
    expect(userTurn.content as string).toContain("hello world");
  });
});
