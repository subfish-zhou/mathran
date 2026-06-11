import type { ToolDefinition } from "./types";

type SearchType = "repositories" | "code" | "issues";

const VALID_TYPES: SearchType[] = ["repositories", "code", "issues"];

export const searchGithubTool: ToolDefinition = {
  name: "search_github",
  description:
    "Search GitHub for repositories, code, or issues. Returns relevant results with metadata.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query for GitHub" },
      type: {
        type: "string",
        enum: ["repositories", "code", "issues"],
        description: 'Type of search: "repositories", "code", or "issues" (default "repositories")',
      },
      count: { type: "number", description: "Number of results (default 5, max 10)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query);
    const searchType: SearchType = VALID_TYPES.includes(args.type as SearchType)
      ? (args.type as SearchType)
      : "repositories";
    const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);

    const token = process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const url = `https://api.github.com/search/${searchType}?q=${encodeURIComponent(query)}&per_page=${count}`;

    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return {
          success: false,
          data: null,
          displayText: `GitHub API returned ${response.status}`,
        };
      }

      const json = await response.json() as { items?: unknown[] };
      const items = json.items ?? [];

      const results = items.map((item: unknown) => {
        const r = item as Record<string, unknown>;
        switch (searchType) {
          case "repositories":
            return {
              name: r.full_name ?? "",
              url: r.html_url ?? "",
              description: (r.description as string | null)?.slice(0, 300) ?? "",
              stars: r.stargazers_count ?? 0,
              language: r.language ?? null,
            };
          case "code":
            return {
              name: r.name ?? "",
              path: r.path ?? "",
              url: r.html_url ?? "",
              repository: (r.repository as Record<string, unknown>)?.full_name ?? "",
            };
          case "issues":
            return {
              title: r.title ?? "",
              url: r.html_url ?? "",
              state: r.state ?? "",
              repository: (r.repository_url as string)?.replace("https://api.github.com/repos/", "") ?? "",
            };
        }
      });

      return {
        success: true,
        data: results,
        displayText: `Found ${results.length} GitHub ${searchType} result(s) for "${query}"`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return {
        success: false,
        data: null,
        displayText: `GitHub search failed: ${msg}`,
      };
    }
  },
};
