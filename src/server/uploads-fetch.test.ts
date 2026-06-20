/**
 * Tests for `GET /api/uploads/<encoded-path>` — the v0.17 mathub-parity
 * fetch endpoint that lets the SPA render attachment chips (image thumbs
 * + binary/textual download anchors) for previously-uploaded files.
 *
 * Mirrors the style of `uploads.test.ts`: spins up the real Hono server
 * with a no-op LLM, writes bytes under `<workspace>/.mathran/uploads/`,
 * then issues `fetch` GETs against `${base}/api/uploads/<encoded>`. We
 * verify three contract points:
 *   - 200 + correct `Content-Type` for files inside the sandbox
 *   - 403 for paths outside `<workspace>/.mathran/uploads/`
 *   - 404 for paths that look fine but reference no file on disk
 *
 * The endpoint is the read-side counterpart of `POST /api/uploads` and
 * shares the same sandbox-validation logic: every request is realpath-
 * resolved on both sides and rejected unless it sits under the uploads
 * subtree. Symlink escape attempts therefore can't slip past either route.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, type RunningServer } from "./serve.js";
import { ChatSession } from "../core/chat/index.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../core/providers/llm.js";

/** No-op LLM provider — none of these tests exercise the chat path, but
 *  `startServer` requires a factory. */
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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-uploads-fetch-"));
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

/** Write a file directly under the uploads sandbox, bypassing the POST
 *  route. Returns the absolute path so the test can hand it to the GET. */
async function seedUpload(
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = path.join(workspace, ".mathran", "uploads");
  await fs.mkdir(dir, { recursive: true });
  const full = path.join(dir, filename);
  await fs.writeFile(full, bytes);
  return full;
}

/** Build the wire URL: `/api/uploads/<encodeURIComponent(absolute path)>`. */
function uploadUrl(absolutePath: string): string {
  return `${base}/api/uploads/${encodeURIComponent(absolutePath)}`;
}

describe("GET /api/uploads/<encoded-path>", () => {
  it("happy path: returns 200 + correct Content-Type for a PNG", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const full = await seedUpload("hello.png", png);

    const res = await fetch(uploadUrl(full));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const got = new Uint8Array(await res.arrayBuffer());
    // Bytes round-trip identically — the route is a thin readFile passthrough.
    expect(Buffer.from(got).equals(Buffer.from(png))).toBe(true);
  });

  it("infers Content-Type from extension for text/markdown/json/pdf", async () => {
    // Each entry: filename, declared mime we expect on the response.
    const cases: Array<{ name: string; mime: string }> = [
      { name: "note.txt", mime: "text/plain; charset=utf-8" },
      { name: "readme.md", mime: "text/markdown; charset=utf-8" },
      { name: "data.json", mime: "application/json" },
      { name: "doc.pdf", mime: "application/pdf" },
      { name: "chart.csv", mime: "text/csv; charset=utf-8" },
    ];
    for (const { name, mime } of cases) {
      const full = await seedUpload(name, new TextEncoder().encode("hi"));
      const res = await fetch(uploadUrl(full));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(mime);
    }
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    const full = await seedUpload("mystery.dat", new Uint8Array([0, 1, 2]));
    const res = await fetch(uploadUrl(full));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("403 when the path escapes the uploads sandbox", async () => {
    // /etc/passwd exists on Linux but is outside `.mathran/uploads/`. The
    // route must reject it before reading any bytes.
    const res = await fetch(uploadUrl("/etc/passwd"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("outside uploads sandbox");
  });

  it("403 when the path points just outside the sandbox (sibling dir)", async () => {
    // Create a sibling file at `<workspace>/.mathran/not-uploads/leak.txt`
    // and try to fetch it. Path-prefix substring tricks (e.g. a sibling
    // directory whose name shares the uploads prefix) must not slip by.
    const siblingDir = path.join(workspace, ".mathran", "uploads-evil");
    await fs.mkdir(siblingDir, { recursive: true });
    const sibling = path.join(siblingDir, "leak.txt");
    await fs.writeFile(sibling, "secret");

    const res = await fetch(uploadUrl(sibling));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("outside uploads sandbox");
  });

  it("404 when the file is missing", async () => {
    const missing = path.join(workspace, ".mathran", "uploads", "ghost.txt");
    const res = await fetch(uploadUrl(missing));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });

  it("400 when the absolute-path requirement is violated", async () => {
    // A relative path makes no sense for this endpoint — even if the
    // sandbox check would pass, we reject early.
    const res = await fetch(`${base}/api/uploads/${encodeURIComponent("relative/path.txt")}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path must be absolute");
  });
});
