/**
 * Built-in `create_wiki_page` tool (gap #1).
 *
 * Create a new wiki page. Fails if the page already exists — use
 * `update_wiki_page` instead in that case. Writes YAML frontmatter
 * (title, tags, version=1, …) and the body as-is. Auto-snapshots into
 * `.history/` only on subsequent updates.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { createWikiPage, isSafeSlug } from "../../wiki/store.js";

export interface CreateWikiPageToolOptions {
  workspace?: string;
}

export function createCreateWikiPageTool(
  opts: CreateWikiPageToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "create_wiki_page",
    riskClass: "write",
    readOnly: false,
    description:
      "Create a brand-new wiki page in a project. Fails (ok=false) if the page slug already exists — " +
      "use `update_wiki_page` for existing pages. The `body` is markdown without frontmatter; the tool prepends " +
      "YAML frontmatter automatically. Output: `{ page, version, title }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        page: { type: "string", description: "New wiki page slug (lowercase alnum + - _ .)." },
        title: { type: "string", description: "Human-readable title for the page." },
        body: { type: "string", description: "Markdown body (no frontmatter; the tool prepends it)." },
        parent: { type: "string", description: "Optional parent page slug for tree navigation." },
        sortOrder: { type: "number", description: "Optional display sort order within parent." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of tags. Defaults to ['wiki'].",
        },
      },
      required: ["project", "page", "body"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const page = typeof args.page === "string" ? args.page : "";
      const body = typeof args.body === "string" ? args.body : null;
      if (!project) return { ok: false, content: "error: create_wiki_page requires 'project'" };
      if (!page) return { ok: false, content: "error: create_wiki_page requires 'page'" };
      if (body === null) return { ok: false, content: "error: create_wiki_page requires 'body' (string)" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(page)) return { ok: false, content: `error: invalid wiki page slug '${page}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      const title = typeof args.title === "string" ? args.title : undefined;
      const parent = typeof args.parent === "string" ? args.parent : undefined;
      const sortOrder = typeof args.sortOrder === "number" ? args.sortOrder : undefined;
      const tags = Array.isArray(args.tags)
        ? (args.tags.filter((t) => typeof t === "string") as string[])
        : undefined;
      try {
        const r = await createWikiPage(workspace, project, page, body, {
          ...(title !== undefined ? { title } : {}),
          ...(parent !== undefined ? { parent } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
          ...(tags !== undefined ? { tags } : {}),
        });
        return {
          ok: true,
          content: JSON.stringify(
            { page: r.page, version: r.version, title: r.frontmatter.title ?? r.page },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `create_wiki_page error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
