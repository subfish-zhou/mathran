/**
 * Built-in `read_wiki_page` tool (gap #1).
 *
 * Read the body + frontmatter of a wiki page in a project. Use this when
 * the LLM needs the *contents* of a known wiki page; use `list_wiki_pages`
 * first to discover available pages.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { readWikiPage, isSafeSlug } from "../../wiki/store.js";

export interface ReadWikiPageToolOptions {
  /**
   * Workspace root for resolving `projects/<project>/wiki/...`. When omitted
   * the tool reads `ctx.workspace`.
   */
  workspace?: string;
}

export function createReadWikiPageTool(
  opts: ReadWikiPageToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "read_wiki_page",
    riskClass: "read",
    readOnly: true,
    description:
      "Read a wiki page from a mathran project. Returns the page body (markdown without the YAML frontmatter) " +
      "along with title, version, parent, and tags. " +
      "Use `list_wiki_pages` first if you do not know which pages exist. " +
      "Output is a JSON-encoded object: `{ page, title, version, body, frontmatter }`.",
    parameters: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project slug (e.g. 'liouville-rieman' or 'lrc-rc1').",
        },
        page: {
          type: "string",
          description: "Wiki page slug (e.g. 'index', 'references', 'concept-x').",
        },
      },
      required: ["project", "page"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const page = typeof args.page === "string" ? args.page : "";
      if (!project) return { ok: false, content: "error: read_wiki_page requires 'project'" };
      if (!page) return { ok: false, content: "error: read_wiki_page requires 'page'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(page)) return { ok: false, content: `error: invalid wiki page slug '${page}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const found = await readWikiPage(workspace, project, page);
        if (!found) return { ok: false, content: `wiki page not found: ${project}/${page}` };
        return {
          ok: true,
          content: JSON.stringify(
            {
              page: found.page,
              title: found.frontmatter.title ?? found.page,
              version: found.version,
              parent: found.frontmatter.parent ?? null,
              tags: found.frontmatter.tags ?? [],
              deleted: found.frontmatter.deleted === true,
              frontmatter: found.frontmatter,
              body: found.body,
            },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `read_wiki_page error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
