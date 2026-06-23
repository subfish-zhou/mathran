/**
 * server.ts — build a mathran MCP **server**: project mathran's own builtin
 * tools, file-based prompts, and skills/workspace files into the SDK `Server`
 * so an external MCP client (Claude Desktop / Cursor) can drive mathran.
 *
 * Exposure is governed entirely by {@link selectExposedTools} (server-exposure.ts):
 * read-only by default, `bash` never exposed, mutate tools behind
 * `exposeMutating`. This module only wires the *transport-agnostic* request
 * handlers — the concrete stdio/http transport is attached by transports.ts.
 *
 * We use the low-level `Server` (not the sugar `McpServer`) because mathran's
 * tools already carry JSON-Schema `parameters`; the low-level list/call
 * handlers let us forward those schemas verbatim without a zod round-trip.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MATHRAN_DIR } from "../config/mathran-root.js";
import type { ToolSpec } from "../chat/session.js";
import { createReadFileTool } from "../chat/tools/read-file.js";
import { createWriteFileTool } from "../chat/tools/write-file.js";
import { createEditFileTool } from "../chat/tools/edit-file.js";
import { createBashTool } from "../chat/tools/bash.js";
import { loadLayeredSkills, type LoadedSkill } from "../skills/loader.js";
import { selectExposedTools } from "./server-exposure.js";
import type { McpServerExposureConfig } from "./schema.js";

export interface BuildMcpServerOpts {
  workspace: string;
  config: McpServerExposureConfig;
  /** Override $HOME (tests). */
  home?: string;
  /** Inject the candidate tool list (tests). Defaults to mathran builtins. */
  candidateTools?: ToolSpec[];
}

/** A file-based prompt loaded from `.mathran/prompts/*.md`. */
export interface LoadedPrompt {
  name: string;
  description: string;
  body: string;
}

/**
 * The full mathran builtin tool set that is *eligible* for exposure (before the
 * policy gate). `bash` is included here so the gate can explicitly deny it (and
 * a test can prove the denial), never because we intend to expose it.
 */
export function candidateBuiltinTools(workspace: string): ToolSpec[] {
  const opts = { workspace };
  return [
    createReadFileTool(opts),
    createWriteFileTool(opts),
    createEditFileTool(opts),
    createBashTool(opts),
  ];
}

/** Read `.mathran/prompts/*.md` from the user then workspace layer (ws wins). */
export function loadFilePrompts(workspace: string, home?: string): LoadedPrompt[] {
  const dirs = [
    path.join(home ?? os.homedir(), MATHRAN_DIR, "prompts"),
    path.join(workspace, MATHRAN_DIR, "prompts"),
  ];
  const byName = new Map<string, LoadedPrompt>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.endsWith(".md")) continue;
      const name = ent.slice(0, -3);
      let body: string;
      try {
        body = fs.readFileSync(path.join(dir, ent), "utf-8");
      } catch {
        continue;
      }
      const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? name;
      byName.set(name, {
        name,
        description: firstLine.replace(/^#+\s*/, "").slice(0, 200),
        body,
      });
    }
  }
  return [...byName.values()];
}

/** Resource view of a skill: `skill://<name>`. */
export function skillResources(skills: ReadonlyArray<LoadedSkill>): Array<{
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  body: string;
}> {
  return skills.map((s) => ({
    uri: `skill://${s.name}`,
    name: s.name,
    description: s.manifest?.description ?? `mathran skill ${s.name}`,
    mimeType: "text/markdown",
    body: s.body,
  }));
}

/**
 * Build a configured (but not yet connected) SDK `Server`. Returns the server
 * plus the resolved exposed-tool list so callers / tests can introspect.
 */
export async function buildMcpServer(opts: BuildMcpServerOpts): Promise<{
  server: import("@modelcontextprotocol/sdk/server/index.js").Server;
  exposedTools: ToolSpec[];
  prompts: LoadedPrompt[];
  resources: ReturnType<typeof skillResources>;
}> {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
  } = await import("@modelcontextprotocol/sdk/types.js");

  const candidates = opts.candidateTools ?? candidateBuiltinTools(opts.workspace);
  const exposedTools = selectExposedTools(candidates, opts.config);
  const toolByName = new Map(exposedTools.map((t) => [t.name, t]));

  const prompts = opts.config.exposePrompts
    ? loadFilePrompts(opts.workspace, opts.home)
    : [];
  const promptByName = new Map(prompts.map((p) => [p.name, p]));

  const resources = opts.config.exposeResources
    ? skillResources(
        loadLayeredSkills({
          workspace: opts.workspace,
          ...(opts.home ? { home: opts.home } : {}),
        }).skills,
      )
    : [];
  const resourceByUri = new Map(resources.map((r) => [r.uri, r]));

  const capabilities: Record<string, unknown> = { tools: {} };
  if (opts.config.exposePrompts) capabilities.prompts = {};
  if (opts.config.exposeResources) capabilities.resources = {};

  const server = new Server(
    { name: "mathran", version: "0.12.0" },
    { capabilities },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema:
        t.parameters && typeof t.parameters === "object" && (t.parameters as { type?: string }).type === "object"
          ? (t.parameters as Record<string, unknown>)
          : { type: "object", properties: {} },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = toolByName.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `mathran does not expose a tool named "${name}"` }],
      };
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await tool.execute(args, { workspace: opts.workspace });
    return {
      isError: !result.ok,
      content: [{ type: "text", text: result.content }],
    };
  });

  if (opts.config.exposePrompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: prompts.map((p) => ({ name: p.name, description: p.description })),
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const p = promptByName.get(req.params.name);
      if (!p) throw new Error(`unknown prompt "${req.params.name}"`);
      return {
        description: p.description,
        messages: [{ role: "user", content: { type: "text", text: p.body } }],
      };
    });
  }

  if (opts.config.exposeResources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const r = resourceByUri.get(req.params.uri);
      if (!r) throw new Error(`unknown resource "${req.params.uri}"`);
      return {
        contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.body }],
      };
    });
  }

  return { server, exposedTools, prompts, resources };
}
