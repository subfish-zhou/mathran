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
});

describe("POST /api/global-chat with attachments", () => {
  it("textual attachment: inlines UTF-8 contents under `[Attachment: …]`", async () => {
    const body = "# Hello\n\nThis is a markdown attachment.\n";
    const up = await uploadFile("hello.md", "text/markdown", new TextEncoder().encode(body));

    const send = await postChatMessage("Look at this file", [up]);
    expect(send.status).toBe(200);
    expect(send.conversationId).toBeTruthy();

    const history = await readHistory(send.conversationId!);
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    // Body comes first, attachment block follows after a blank line.
    expect(userMsg!.content).toMatch(/^Look at this file\n\n\[Attachment: hello\.md\]\n/);
    // Inlined file body is present verbatim.
    expect(userMsg!.content).toContain(body);
    // No `[Image: …]` / `[Binary: …]` mis-render.
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

  it("oversize text attachment: truncates and appends `[truncated]` marker", async () => {
    // 250 KB of repetitive text — larger than MAX_TEXT_ATTACHMENT_BYTES (200 KB).
    const big = "a".repeat(MAX_TEXT_ATTACHMENT_BYTES + 50 * 1024);
    const up = await uploadFile("big.txt", "text/plain", new TextEncoder().encode(big));

    const send = await postChatMessage("Summarise this", [up]);
    expect(send.status).toBe(200);

    const history = await readHistory(send.conversationId!);
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    // Truncation marker is present…
    expect(userMsg!.content).toMatch(/… \[truncated\]\s*$/);
    // …and the inlined body is exactly MAX_TEXT_ATTACHMENT_BYTES of 'a',
    // not the full 250 KB. We count by extracting the body between the
    // header and the truncated marker.
    const header = "[Attachment: big.txt]\n";
    const start = userMsg!.content.indexOf(header) + header.length;
    const end = userMsg!.content.lastIndexOf("\n… [truncated]");
    expect(end - start).toBe(MAX_TEXT_ATTACHMENT_BYTES);
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
