import { getEffortDetails } from "@/server/agent-gateway/services/efforts";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

type IncludeSection = "reviews" | "milestones" | "releases" | "stats";
const ALL_SECTIONS: IncludeSection[] = ["reviews", "milestones", "releases", "stats"];

export const readEffortDetailsTool: ToolDefinition = {
  name: "read_effort_details",
  description:
    "Read extended effort information including reviews, milestones, releases, and star count. Specify which sections to include or get all by default.",
  parameters: {
    type: "object",
    properties: {
      effortId: { type: "string", description: "The effort ID to read details for" },
      include: {
        type: "array",
        items: { type: "string", enum: ["reviews", "milestones", "releases", "stats"] },
        description: "Sections to include (default: all)",
      },
    },
    required: ["effortId"],
  },
  projectOnly: true,
  async execute(args, ctx) {
    return withToolSpan(
      "read_effort_details",
      { userId: ctx.userId },
      async () => {
    const effortId = String(args.effortId);
    const include = (args.include as IncludeSection[] | undefined) ?? ALL_SECTIONS;
    const sections = new Set(include);
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    // P0-2 / P1-4: sort `include` for a stable key so {reviews,stats} and
    // {stats,reviews} share one cache entry. Tool-name prefix required to
    // keep this distinct from `read_effort:E1`. instanceof Map check is
    // intentional — plain objects rejected by contract (see types.ts).
    const includeKey = [...include].sort().join(",");
    const cacheKey = `read_effort_details:${effortId}:${includeKey}`;
    if (ctx.runCache instanceof Map && ctx.runCache.has(cacheKey)) {
      const cached = ctx.runCache.get(cacheKey) as { text: string };
      return {
        success: true,
        data: cached.text,
        displayText: `Read effort details: ${effortId} (${include.join(", ")}) (已从本 run 缓存复用)`,
      };
    }

    try {
      const details = await getEffortDetails(principal, { id: effortId, include });
      const lines: string[] = [`# Effort Details: ${effortId}`, ""];

      // Reviews
      if (sections.has("reviews")) {
        const reviews = details.reviews ?? [];

        lines.push(`## Reviews (${reviews.length})`);
        for (const r of reviews) {
          lines.push(
            `- [${r.status}] by ${r.reviewerName ?? "unknown"} at ${r.createdAt?.toISOString() ?? "unknown"}${r.body ? `: ${r.body.slice(0, 200)}` : ""}`,
          );
        }
        lines.push("");
      }

      // Milestones
      if (sections.has("milestones")) {
        const milestones = details.milestones ?? [];

        lines.push(`## Milestones (${milestones.length})`);
        for (const m of milestones) {
          const due = m.dueDate ? ` due ${m.dueDate.toISOString()}` : "";
          lines.push(`- [${m.status}] **${m.title}**${due}${m.description ? ` — ${m.description.slice(0, 150)}` : ""}`);
        }
        lines.push("");
      }

      // Releases
      if (sections.has("releases")) {
        const releases = details.releases ?? [];

        lines.push(`## Releases (${releases.length})`);
        for (const r of releases) {
          const draft = r.isDraft ? " [DRAFT]" : "";
          lines.push(
            `- ${r.tag}: **${r.title}**${draft} by ${r.authorName ?? "unknown"} at ${r.createdAt?.toISOString() ?? "unknown"}`,
          );
        }
        lines.push("");
      }

      // Stats (star count)
      if (sections.has("stats")) {
        const starCount = details.stats?.stars ?? 0;
        lines.push(`## Stats`, `- Stars: ${starCount}`, "");
      }

      const text = lines.join("\n");
      // Only successes get cached — a forbidden/notfound error has to be able
      // to recover if the agent retries after gaining access (rare but real).
      if (ctx.runCache instanceof Map) {
        ctx.runCache.set(cacheKey, { text });
      }
      return {
        success: true,
        data: text,
        displayText: `Read effort details: ${effortId} (${include.join(", ")})`,
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
