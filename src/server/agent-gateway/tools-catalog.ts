import { z } from "zod";
import { BOT_SCOPES, type BotScope } from "./scopes";
import { getToolSchemas } from "./tool-payload-schemas";

/**
 * Static catalog manifest of bot-callable tools (PRD §4.1, §4.2, §4.3).
 *
 * One entry per bot v1 endpoint that an LLM can invoke as a function-call.
 * Every entry's {@link ToolCatalogEntry.scope} MUST be a value of
 * {@link BOT_SCOPES} (enforced at compile-time via the `BotScope` type and
 * at test-time in `tools-catalog.test.ts`).
 *
 * **Hard gates** (PRD §4.4, §12.8):
 * - NO `wolfram.*` entry (Wolfram is not a platform tool — see scopes.ts).
 * - NO `sandbox` category in V1 (Python sandbox is V2).
 */

export const TOOL_CATEGORIES = [
  "lean",
  "search",
  "forum",
  "wiki",
  "effort",
  "project",
  "program",
  "blueprint",
  "message",
  "webhook",
  "sandbox",
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const toolCatalogEntrySchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.enum(TOOL_CATEGORIES),
  scope: z.string(),
  httpEndpoint: z.object({
    method: z.string(),
    path: z.string(),
  }),
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  rateLimit: z.object({
    kind: z.enum(["bot", "user-tool"]),
    maxPerMin: z.number(),
  }),
  notes: z.string().optional(),
});

export interface ToolCatalogEntry {
  name: string;
  title: string;
  description: string;
  category: ToolCategory;
  scope: BotScope;
  httpEndpoint: { method: string; path: string };
  // V1 ships `{}` placeholder; precise JSON Schemas land in M-B5 (OpenAPI sweep).
  // TODO(M-B5): derive from existing zod via zodToJsonSchema once tied to OpenAPI.
  inputSchema: unknown;
  outputSchema: unknown;
  rateLimit: { kind: "bot" | "user-tool"; maxPerMin: number };
  notes?: string;
}

const EMPTY_SCHEMA: unknown = {};

export const TOOLS_CATALOG: readonly ToolCatalogEntry[] = [
  // ---------- Lean (existing read/write — PRD §4.2) ----------
  {
    name: "lean.check",
    title: "Lean check",
    description: "Run a lightweight Lean syntax / elaboration check on a snippet.",
    category: "lean",
    scope: "lean.write",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/lean/check" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
  },
  {
    name: "lean.import",
    title: "Lean import",
    description: "Import an external Lean snippet/file into the bot's workspace context.",
    category: "lean",
    scope: "lean.write",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/lean/import" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 10 },
  },
  {
    name: "lean.status",
    title: "Lean job status",
    description: "Get status of a previously-submitted Lean job.",
    category: "lean",
    scope: "lean.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/lean/status/:id" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "lean.toolchains",
    title: "Lean toolchain allowlist",
    description: "Return the operator-provisioned allowlist of Lean toolchain versions.",
    category: "lean",
    scope: "lean.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/lean/toolchains" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },

  // ---------- Lean Path 1 (source build — V1 new, M-B3) ----------
  {
    name: "lean.source.build",
    title: "Lean source build",
    description:
      "Submit a Lean source tree (zip or git URL) to be built with `lake build` in the project workspace. Returns a buildId; poll lean.builds.get for status.",
    category: "lean",
    scope: "lean.build",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/lean/source/build" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 1 },
    notes:
      "Path 1 — quota 10 builds / bot / 24h; per-build wall-clock cap 5 min. Mathub trusts only what Mathub builds (#print axioms summary returned on success).",
  },
  {
    name: "lean.builds.list",
    title: "List Lean builds",
    description: "List the bot's Lean source builds (filterable by status / project).",
    category: "lean",
    scope: "lean.build",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/lean/builds" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
  },
  {
    name: "lean.builds.get",
    title: "Get Lean build",
    description:
      "Get status, axioms summary, and log tail for a Lean source build.",
    category: "lean",
    scope: "lean.build",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/lean/builds/:id" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "lean.builds.cancel",
    title: "Cancel Lean build",
    description: "Cancel a queued or running Lean source build owned by this bot.",
    category: "lean",
    scope: "lean.build",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/lean/builds/:id/cancel" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 10 },
  },

  // ---------- Lean Path 2 (artifact storage — V1 new, M-A6) ----------
  {
    name: "lean.artifacts.upload",
    title: "Upload Lean artifact",
    description:
      "Upload a Lean build artifact (oleans / build cache) for storage. Content-addressed by hash.",
    category: "lean",
    scope: "lean.artifact.write",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/lean/artifacts" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 10 },
    notes:
      "Path 2 — verified:false. Mathub stores and serves the artifact but does NOT typecheck it. Consumers must rerun verification.",
  },
  {
    name: "lean.artifacts.get",
    title: "Get Lean artifact",
    description: "Download a Lean artifact by its content hash.",
    category: "lean",
    scope: "lean.artifact.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/lean/artifacts/:hash" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
    notes: "verified:false — Mathub stores, does not typecheck.",
  },
  {
    name: "lean.artifacts.list",
    title: "List Lean artifacts",
    description: "List Lean artifacts visible to this bot.",
    category: "lean",
    scope: "lean.artifact.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/lean/artifacts" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
  },
  {
    name: "lean.artifacts.delete",
    title: "Delete Lean artifact",
    description: "Delete a Lean artifact owned by this bot.",
    category: "lean",
    scope: "lean.artifact.write",
    httpEndpoint: { method: "DELETE", path: "/api/bot/v1/lean/artifacts/:hash" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 10 },
  },

  // ---------- Search ----------
  {
    name: "search.web",
    title: "Web search",
    description: "Multi-source web search.",
    category: "search",
    scope: "search",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/search" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
  },
  {
    name: "search.wiki",
    title: "Wiki search",
    description: "Search wiki pages.",
    category: "search",
    scope: "search",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/search" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
    notes: "Use /search with source='wiki'.",
  },
  {
    name: "search.efforts",
    title: "Effort search",
    description: "Search workspace efforts.",
    category: "search",
    scope: "search",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/search" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
    notes: "Use /search with source='effort'.",
  },
  {
    name: "search.forum",
    title: "Forum search",
    description: "Search forum threads and posts.",
    category: "search",
    scope: "search",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/search" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
    notes: "Use /search with source='forum'.",
  },
  {
    name: "search.arxiv",
    title: "arXiv search",
    description: "Search arXiv preprints.",
    category: "search",
    scope: "search",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/search" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
    notes: "Use /search with source='arxiv'.",
  },
  {
    name: "search.github",
    title: "GitHub search",
    description: "Search GitHub for code, issues, repos.",
    category: "search",
    scope: "search",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/search" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
    notes: "Use /search with source='github'.",
  },

  // ---------- Forum ----------
  {
    name: "forum.threads.get",
    title: "Get forum thread",
    description: "Fetch a forum thread by id (metadata + post list).",
    category: "forum",
    scope: "forum.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/threads/:id" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "forum.posts.create",
    title: "Create forum post",
    description: "Create a new post on a forum thread.",
    category: "forum",
    scope: "forum.write",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/threads/:id/posts" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
  },
  {
    name: "forum.posts.react",
    title: "React to forum post",
    description: "Add a reaction to a forum post.",
    category: "forum",
    scope: "forum.write",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/posts/:id/reactions" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },

  // ---------- Wiki ----------
  {
    name: "wiki.get",
    title: "Get wiki page",
    description: "Fetch a wiki page by id.",
    category: "wiki",
    scope: "wiki.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/wiki/:id" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "wiki.update",
    title: "Update wiki page",
    description: "Patch a wiki page (markdown body).",
    category: "wiki",
    scope: "wiki.write",
    httpEndpoint: { method: "PATCH", path: "/api/bot/v1/wiki/:id" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 10 },
  },

  // ---------- Effort ----------
  {
    name: "effort.get",
    title: "Get effort",
    description: "Fetch an effort summary by id.",
    category: "effort",
    scope: "effort.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/efforts/:id" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "effort.details",
    title: "Get effort details",
    description: "Fetch full effort details (description, fields, members).",
    category: "effort",
    scope: "effort.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/efforts/:id/details" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "effort.issues",
    title: "List effort issues",
    description: "List issues attached to an effort.",
    category: "effort",
    scope: "effort.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/efforts/:id/issues" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "effort.relations",
    title: "List effort relations",
    description: "List effort relations (depends-on, blocks, etc).",
    category: "effort",
    scope: "effort.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/efforts/:id/relations" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },

  // ---------- Project ----------
  {
    name: "project.get",
    title: "Get project",
    description: "Fetch project metadata by slug.",
    category: "project",
    scope: "project.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/projects/:slug" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "project.efforts",
    title: "List project efforts",
    description: "List efforts in a project.",
    category: "project",
    scope: "project.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/projects/:slug/efforts" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "project.threads",
    title: "List project threads",
    description: "List forum threads in a project.",
    category: "project",
    scope: "project.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/projects/:slug/threads" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "project.wiki",
    title: "List project wiki pages",
    description: "List wiki pages in a project.",
    category: "project",
    scope: "project.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/projects/:slug/wiki" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "project.index",
    title: "Project index",
    description: "Combined project index (efforts + threads + wiki summary).",
    category: "project",
    scope: "project.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/projects/:slug/index" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
  },

  // ---------- Program ----------
  {
    name: "program.get",
    title: "Get program",
    description: "Fetch program metadata by slug.",
    category: "program",
    scope: "program.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/programs/:slug" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "program.index",
    title: "Program index",
    description: "Combined program index (members + projects + summary).",
    category: "program",
    scope: "program.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/programs/:slug/index" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
  },

  // ---------- Blueprint ----------
  {
    name: "blueprint.get",
    title: "Get blueprint",
    description: "Fetch a blueprint by id.",
    category: "blueprint",
    scope: "blueprint.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/blueprint/:id" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "blueprint.effort.get",
    title: "Get effort blueprint",
    description: "Fetch the blueprint associated with an effort.",
    category: "blueprint",
    scope: "blueprint.read",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/blueprint/effort/:id" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },

  // ---------- Message (existing DM + new chat-plane) ----------
  {
    name: "dm.send",
    title: "Send direct message",
    description: "Send a direct message to a user (existing /messages endpoint).",
    category: "message",
    scope: "message",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/messages" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
  },
  {
    name: "mentions.list",
    title: "List mentions",
    description: "List bot mentions (existing /mentions endpoint).",
    category: "message",
    scope: "message",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/mentions" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "channel.message.post",
    title: "Post channel message",
    description: "Post a message to a chat-plane channel (M-A3).",
    category: "message",
    scope: "message.write",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/channels/:id/messages" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },
  {
    name: "channel.message.react",
    title: "React to channel message",
    description: "Add a reaction to a chat-plane message (M-A3).",
    category: "message",
    scope: "reaction.write",
    httpEndpoint: {
      method: "POST",
      path: "/api/bot/v1/messages/:id/reactions",
    },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 60 },
  },

  // ---------- Webhook ----------
  {
    name: "webhook.list",
    title: "List webhooks",
    description: "List the bot's registered webhook endpoints.",
    category: "webhook",
    scope: "webhook.manage",
    httpEndpoint: { method: "GET", path: "/api/bot/v1/webhooks" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 30 },
  },
  {
    name: "webhook.create",
    title: "Create webhook",
    description: "Register a new webhook endpoint for event delivery.",
    category: "webhook",
    scope: "webhook.manage",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/webhooks" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 10 },
  },
  {
    name: "webhook.test",
    title: "Test webhook",
    description: "Dispatch a synthetic event to a webhook to verify delivery.",
    category: "webhook",
    scope: "webhook.manage",
    httpEndpoint: { method: "POST", path: "/api/bot/v1/webhooks/:id/test" },
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    rateLimit: { kind: "bot", maxPerMin: 10 },
  },
];

const TOOLS_BY_NAME: ReadonlyMap<string, ToolCatalogEntry> = new Map(
  TOOLS_CATALOG.map((t) => [t.name, t]),
);

// M-B5: hydrate each entry's `inputSchema`/`outputSchema` from the central
// tool-payload-schemas registry. The catalog literals above keep
// `EMPTY_SCHEMA` placeholders so that the structural shape of TOOLS_CATALOG
// is stable; this loop swaps them for real JSON Schemas at module-load.
//
// Tools missing a registry entry get a permissive object schema (not `{}`)
// — see `getToolSchemas` fallback in tool-payload-schemas.ts.
for (const entry of TOOLS_CATALOG) {
  const pair = getToolSchemas(entry.name);
  (entry as { inputSchema: unknown }).inputSchema = pair.inputSchema;
  (entry as { outputSchema: unknown }).outputSchema = pair.outputSchema;
}

export function getToolByName(name: string): ToolCatalogEntry | undefined {
  return TOOLS_BY_NAME.get(name);
}

export function listTools(filter?: {
  category?: ToolCategory;
}): ToolCatalogEntry[] {
  let out: ToolCatalogEntry[] = [...TOOLS_CATALOG];
  if (filter?.category) {
    out = out.filter((t) => t.category === filter.category);
  }
  return out;
}

// Compile-time sanity: every entry's `scope` is a real BotScope.
// (`scope: BotScope` already guarantees this, but the export of the runtime
// scope list helps the test file double-check at runtime against BOT_SCOPES.)
export const _BOT_SCOPES_RUNTIME = BOT_SCOPES;
