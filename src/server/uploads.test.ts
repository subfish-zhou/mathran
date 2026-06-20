/**
 * Tests for `POST /api/uploads` — the v0.17 mathub-parity file-upload
 * backend. Drives the real Hono server over `fetch`, mirroring the style of
 * `serve.test.ts`.
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
  MAX_UPLOAD_BYTES,
  sanitizeUploadFilename,
} from "./upload-routes.js";
import { ChatSession } from "../core/chat/index.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../core/providers/llm.js";

/** Tiny no-op LLM — uploads don't touch the chat path but startServer needs one. */
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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-uploads-"));
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

/** Build a multipart form with a single `file` entry and POST it. */
async function postUpload(
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<Response> {
  const form = new FormData();
  form.set("file", new Blob([bytes as unknown as BlobPart], { type: mimeType }), filename);
  return fetch(`${base}/api/uploads`, { method: "POST", body: form });
}

describe("POST /api/uploads", () => {
  it("happy path: accepts a small PNG and returns path/filename/mimeType/size", async () => {
    // 8-byte PNG signature is enough — we never decode the bytes server-side.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await postUpload("hello world.png", "image/png", png);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      filename: string;
      mimeType: string;
      size: number;
    };
    // Filename is sanitised (space → underscore) and the response surfaces
    // metadata the SPA needs to render an attachment chip.
    expect(body.filename).toBe("hello_world.png");
    expect(body.mimeType).toBe("image/png");
    expect(body.size).toBe(png.byteLength);
    // Path is absolute and lives under the workspace's `.mathran/uploads/` dir.
    expect(path.isAbsolute(body.path)).toBe(true);
    expect(body.path.startsWith(path.join(workspace, ".mathran", "uploads") + path.sep)).toBe(true);
    // …and the bytes are actually on disk.
    const onDisk = await fs.readFile(body.path);
    expect(onDisk.equals(Buffer.from(png))).toBe(true);
  });

  it("413 when payload exceeds MAX_UPLOAD_BYTES", async () => {
    // One byte past the cap. We don't care about content, only Content-Length.
    const oversize = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    const res = await postUpload("big.bin", "application/pdf", oversize);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("too large");
  });

  it("415 when MIME type is not in the allowlist", async () => {
    const res = await postUpload(
      "evil.exe",
      "application/x-msdownload",
      new Uint8Array([0x4d, 0x5a]),
    );
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("type not allowed");
  });

  it("400 when the `file` field is missing", async () => {
    const form = new FormData();
    form.set("not-file", "oops");
    const res = await fetch(`${base}/api/uploads`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing file field");
  });
});

describe("sanitizeUploadFilename", () => {
  it("strips path traversal and shell metacharacters", () => {
    expect(sanitizeUploadFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeUploadFilename("a b;c$d.png")).toBe("a_b_c_d.png");
  });

  it("falls back to 'file' when sanitisation strips everything", () => {
    // An all-illegal-char name (slashes, spaces, etc.) survives as a string of
    // underscores; but a single illegal char that gets stripped to empty after
    // the slice falls back to the literal `file`.
    expect(sanitizeUploadFilename("")).toBe("file");
  });

  it("truncates to 100 characters", () => {
    const long = "a".repeat(500) + ".txt";
    expect(sanitizeUploadFilename(long).length).toBe(100);
  });
});
