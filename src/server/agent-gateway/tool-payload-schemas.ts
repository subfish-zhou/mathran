/**
 * Per-tool input/output JSON Schemas for `TOOLS_CATALOG` (PRD §4.2).
 *
 * Mirrors the actual route-handler zod request/response shapes — kept as
 * hand-curated JSON Schema fragments so the tools-catalog is self-describing
 * without runtime zod-to-JSON-Schema conversion overhead.
 *
 * Source of truth for shapes:
 * - Look up the tool's HTTP endpoint (`tools-catalog.ts.httpEndpoint`).
 * - Open `src/app/api/bot/v1/.../route.ts`.
 * - Mirror its `request.body` / `request.query` zod schema (input) and
 *   `response[200|201]` zod schema (output).
 *
 * Tools whose request/response payloads are pass-through (e.g. lean
 * legacy `lean.check`, `lean.import` pre-V1 stubs) get a permissive
 * `{ type: "object", additionalProperties: true }` schema. This is still
 * non-placeholder for purposes of the M-B5 smoke test (which rejects `{}`).
 *
 * Update this file whenever route-level zod schemas change.
 */

export type JsonSchema = Record<string, unknown>;

const PERMISSIVE_OBJECT: JsonSchema = { type: "object", additionalProperties: true };

const idQuery: JsonSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};

const hashPath: JsonSchema = {
  type: "object",
  properties: { hash: { type: "string", pattern: "^[a-f0-9]{64}$" } },
  required: ["hash"],
};

const cursorListQuery: JsonSchema = {
  type: "object",
  properties: {
    cursor: { type: ["string", "null"] },
    limit: { type: "integer", minimum: 1, maximum: 200 },
  },
};

const listResponse = (item: JsonSchema): JsonSchema => ({
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: item },
    nextCursor: { type: ["string", "null"] },
  },
});

export interface ToolSchemaPair {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

/**
 * Per-tool input/output JSON Schemas. Keys MUST match
 * `TOOLS_CATALOG[].name`. Missing entries fall back to PERMISSIVE_OBJECT.
 */
export const TOOL_SCHEMAS: Record<string, ToolSchemaPair> = {
  // ── Lean (pre-V1 + V1) ──────────────────────────────────────────────────
  "lean.check": {
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    outputSchema: { type: "object", additionalProperties: true },
  },
  "lean.import": {
    inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
    outputSchema: { type: "object", additionalProperties: true },
  },
  "lean.status": {
    inputSchema: idQuery,
    outputSchema: PERMISSIVE_OBJECT,
  },
  "lean.toolchains": {
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      required: ["toolchains"],
      properties: { toolchains: { type: "array", items: { type: "string" } } },
    },
  },
  "lean.source.build": {
    inputSchema: {
      type: "object",
      required: ["toolchain", "source"],
      properties: {
        toolchain: { type: "string" },
        source: {
          type: "object",
          description:
            "Source bundle — either { kind: 'inline', files: [{ path, content }] } or { kind: 'lake-zip', archive_b64 }.",
        },
        projectId: { type: ["string", "null"] },
        timeoutSec: { type: "integer", minimum: 1, maximum: 300 },
        entrypoint: { type: ["string", "null"] },
      },
    },
    outputSchema: {
      type: "object",
      required: ["buildId", "status"],
      properties: {
        buildId: { type: "string" },
        status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"] },
      },
    },
  },
  "lean.builds.list": {
    inputSchema: cursorListQuery,
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "lean.builds.get": {
    inputSchema: idQuery,
    outputSchema: PERMISSIVE_OBJECT,
  },
  "lean.builds.cancel": {
    inputSchema: idQuery,
    outputSchema: {
      type: "object",
      properties: { buildId: { type: "string" }, cancelled: { type: "boolean" } },
      required: ["buildId", "cancelled"],
    },
  },
  "lean.artifacts.upload": {
    inputSchema: {
      type: "object",
      required: ["manifest", "olean_b64"],
      properties: {
        manifest: {
          type: "object",
          required: ["leanVersion"],
          properties: { leanVersion: { type: "string" } },
          additionalProperties: true,
        },
        olean_b64: { type: "string", description: "Base64-encoded olean blob." },
        projectId: { type: ["string", "null"] },
      },
    },
    outputSchema: {
      type: "object",
      required: ["hash", "verified"],
      properties: {
        hash: { type: "string" },
        verified: { type: "boolean", const: false, description: "Mathub is a trusted CDN, not a verifier (PRD §4.3.2)." },
        byteSize: { type: "integer" },
      },
    },
  },
  "lean.artifacts.get": { inputSchema: hashPath, outputSchema: PERMISSIVE_OBJECT },
  "lean.artifacts.list": {
    inputSchema: {
      type: "object",
      properties: {
        leanVersion: { type: ["string", "null"] },
        projectId: { type: ["string", "null"] },
        cursor: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "lean.artifacts.delete": {
    inputSchema: hashPath,
    outputSchema: { type: "object", properties: { hash: { type: "string" }, deleted: { type: "boolean" } } },
  },

  // ── Search ──────────────────────────────────────────────────────────────
  "search.web": {
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, limit: { type: "integer" } } },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "search.wiki": {
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, projectId: { type: ["string", "null"] } } },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "search.efforts": {
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, projectId: { type: ["string", "null"] } } },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "search.forum": {
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, projectId: { type: ["string", "null"] } } },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "search.arxiv": {
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, limit: { type: "integer" } } },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "search.github": {
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, limit: { type: "integer" } } },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },

  // ── Forum ───────────────────────────────────────────────────────────────
  "forum.threads.get": { inputSchema: idQuery, outputSchema: PERMISSIVE_OBJECT },
  "forum.posts.create": {
    inputSchema: {
      type: "object",
      required: ["threadId", "body"],
      properties: { threadId: { type: "string" }, body: { type: "string" } },
    },
    outputSchema: PERMISSIVE_OBJECT,
  },
  "forum.posts.react": {
    inputSchema: {
      type: "object",
      required: ["postId", "emoji"],
      properties: { postId: { type: "string" }, emoji: { type: "string" } },
    },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  },

  // ── Wiki ────────────────────────────────────────────────────────────────
  "wiki.get": { inputSchema: idQuery, outputSchema: PERMISSIVE_OBJECT },
  "wiki.update": {
    inputSchema: {
      type: "object",
      required: ["pageId", "body"],
      properties: { pageId: { type: "string" }, body: { type: "string" }, title: { type: ["string", "null"] } },
    },
    outputSchema: PERMISSIVE_OBJECT,
  },

  // ── Effort ──────────────────────────────────────────────────────────────
  "effort.get": { inputSchema: idQuery, outputSchema: PERMISSIVE_OBJECT },
  "effort.details": { inputSchema: idQuery, outputSchema: PERMISSIVE_OBJECT },
  "effort.issues": { inputSchema: idQuery, outputSchema: listResponse(PERMISSIVE_OBJECT) },
  "effort.relations": { inputSchema: idQuery, outputSchema: listResponse(PERMISSIVE_OBJECT) },

  // ── Project ─────────────────────────────────────────────────────────────
  "project.get": {
    inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } },
    outputSchema: PERMISSIVE_OBJECT,
  },
  "project.efforts": {
    inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" }, cursor: { type: ["string", "null"] } } },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "project.threads": {
    inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" }, cursor: { type: ["string", "null"] } } },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "project.wiki": {
    inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } },
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "project.index": {
    inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } },
    outputSchema: PERMISSIVE_OBJECT,
  },

  // ── Program ─────────────────────────────────────────────────────────────
  "program.get": {
    inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } },
    outputSchema: PERMISSIVE_OBJECT,
  },
  "program.index": {
    inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } },
    outputSchema: PERMISSIVE_OBJECT,
  },

  // ── Blueprint ───────────────────────────────────────────────────────────
  "blueprint.get": { inputSchema: { type: "object" }, outputSchema: PERMISSIVE_OBJECT },
  "blueprint.effort.get": { inputSchema: idQuery, outputSchema: PERMISSIVE_OBJECT },

  // ── Messages ────────────────────────────────────────────────────────────
  "dm.send": {
    inputSchema: {
      type: "object",
      required: ["to", "body"],
      properties: { to: { type: "string" }, body: { type: "string" } },
    },
    outputSchema: PERMISSIVE_OBJECT,
  },
  "mentions.list": {
    inputSchema: cursorListQuery,
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "channel.message.post": {
    inputSchema: {
      type: "object",
      required: ["channelId", "content"],
      properties: {
        channelId: { type: "string" },
        content: { type: "string" },
        contentType: { type: "string" },
        parentMessageId: { type: ["string", "null"] },
      },
    },
    outputSchema: { $ref: "#/components/schemas/WebhookEvent_message_created" },
  },
  "channel.message.react": {
    inputSchema: {
      type: "object",
      required: ["messageId", "emoji"],
      properties: { messageId: { type: "string" }, emoji: { type: "string" } },
    },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  },

  // ── Webhook ─────────────────────────────────────────────────────────────
  "webhook.list": {
    inputSchema: cursorListQuery,
    outputSchema: listResponse(PERMISSIVE_OBJECT),
  },
  "webhook.create": {
    inputSchema: {
      type: "object",
      required: ["url", "events"],
      properties: {
        url: { type: "string", format: "uri" },
        events: { type: "array", items: { type: "string" } },
        secret: { type: ["string", "null"] },
      },
    },
    outputSchema: PERMISSIVE_OBJECT,
  },
  "webhook.test": {
    inputSchema: idQuery,
    outputSchema: { type: "object", properties: { ok: { type: "boolean" }, statusCode: { type: ["integer", "null"] } } },
  },
};

export function getToolSchemas(name: string): ToolSchemaPair {
  return TOOL_SCHEMAS[name] ?? { inputSchema: PERMISSIVE_OBJECT, outputSchema: PERMISSIVE_OBJECT };
}
