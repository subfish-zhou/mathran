import { getEffort } from "@/server/agent-gateway/services/efforts";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const readEffortTool: ToolDefinition = {
  name: "read_effort",
  description:
    "Read the full details of a specific workspace effort by its ID. Use get_project_index or search_efforts first to find effort IDs.",
  parameters: {
    type: "object",
    properties: {
      effortId: { type: "string", description: "The effort ID to read" },
    },
    required: ["effortId"],
  },
  projectOnly: true,
  async execute(args, ctx) {
    return withToolSpan(
      "read_effort",
      { userId: ctx.userId },
      async () => {
    const effortId = String(args.effortId);
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    // P0-2 / P1-4: short-circuit on cache hit. effortId fully scopes the read
    // (principal is derived from ctx.userId which is invariant within a run);
    // the tool-name prefix is mandatory to keep `read_effort:E1` and e.g.
    // `read_effort_details:E1` from colliding. instanceof Map check is
    // deliberate — plain objects are explicitly rejected (see types.ts).
    const cacheKey = `read_effort:${effortId}`;
    if (ctx.runCache instanceof Map && ctx.runCache.has(cacheKey)) {
      const cached = ctx.runCache.get(cacheKey) as { text: string; title: string };
      return {
        success: true,
        data: cached.text,
        displayText: `Read effort: ${cached.title} (已从本 run 缓存复用)`,
      };
    }

    try {
      const { effort, creator } = await getEffort(principal, { id: effortId });
      const authorName = creator?.name ?? null;

      const lines: string[] = [
        `# ${effort.title}`,
        `Type: ${effort.type ?? "unknown"} | Status: ${effort.status ?? "unknown"}`,
        `Author: ${authorName ?? "unknown"} | Created: ${effort.createdAt?.toISOString() ?? "unknown"}`,
      ];

      // `tags` is a plain text column that historically holds either a
      // comma-separated string or (rarely) a JSON array. Normalise both
      // shapes before rendering so a non-array value can't crash `.join`.
      const tagList = Array.isArray(effort.tags)
        ? (effort.tags as string[])
        : typeof effort.tags === "string"
          ? effort.tags.split(",").map((t) => t.trim()).filter(Boolean)
          : [];
      if (tagList.length > 0) {
        lines.push(`Tags: ${tagList.join(", ")}`);
      }
      if (effort.arxivId) lines.push(`arXiv: ${effort.arxivId}`);
      if (effort.doi) lines.push(`DOI: ${effort.doi}`);

      if (effort.description) {
        lines.push("", "## Description", effort.description);
      }
      if (effort.document) {
        lines.push("", "## Document", effort.document);
      }

      const text = lines.join("\n");
      // Cache successes only — storing failures would make a transient
      // permission/notfound error sticky for the whole run.
      if (ctx.runCache instanceof Map) {
        ctx.runCache.set(cacheKey, { text, title: effort.title });
      }
      return {
        success: true,
        data: text,
        displayText: `Read effort: ${effort.title}`,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        notFound: "Effort not found",
        forbidden: "You don't have access to this effort.",
      });
    }
  },
    );
  },
};
