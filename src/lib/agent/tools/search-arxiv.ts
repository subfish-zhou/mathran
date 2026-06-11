import type { ToolDefinition } from "./types";

export const searchArxivTool: ToolDefinition = {
  name: "search_arxiv",
  description:
    "Search arXiv for academic papers by keyword. Returns paper titles, authors, abstracts, and links.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query for arXiv papers" },
      maxResults: { type: "number", description: "Maximum number of results (default 5, max 10)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query);
    const maxResults = Math.min(Number(args.maxResults) || 5, 10);

    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return {
          success: false,
          data: null,
          displayText: `arXiv API returned ${response.status}`,
        };
      }

      const xml = await response.text();

      // Parse entries from Atom XML with regex
      const entries: Array<{
        title: string;
        authors: string[];
        abstract: string;
        link: string;
        published: string;
      }> = [];

      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
      let match;
      while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1]!;

        const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
        const abstract = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
        const link = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? "";
        const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ?? "";

        const authors: string[] = [];
        const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>/g;
        let authorMatch;
        while ((authorMatch = authorRegex.exec(entry)) !== null) {
          authors.push(authorMatch[1]!.trim());
        }

        entries.push({ title, authors, abstract: abstract.slice(0, 500), link, published });
      }

      return {
        success: true,
        data: entries,
        displayText: `Found ${entries.length} arXiv paper(s) for "${query}"`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return {
        success: false,
        data: null,
        displayText: `arXiv search failed: ${msg}`,
      };
    }
  },
};
