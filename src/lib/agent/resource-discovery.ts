/**
 * Resource discovery for GitHub repos, code, datasets, and supplementary materials.
 * Used by Init Agent and Patrol Agent to enrich efforts with external resources.
 */

// TODO(mathran-v0.1): import { safeFetch } from "@/lib/safe-fetch";
import { sleep } from "./init-crawlers";
// TODO(mathran-v0.1): import { workspaceEffortFiles } from "@/server/db/schema/workspace";
// TODO(mathran-v0.1): import type { getDb } from "@/server/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResourceLink {
  url: string;
  title: string;
  sourceType:
    | "github"
    | "papers_with_code"
    | "arxiv_supplementary"
    | "project_website"
    | "dataset";
  description?: string;
  language?: string;
}

// ---------------------------------------------------------------------------
// 1. arXiv page scraping – find GitHub/GitLab links
// ---------------------------------------------------------------------------

export async function findArxivCodeLinks(
  arxivId: string,
): Promise<ResourceLink[]> {
  const results: ResourceLink[] = [];
  try {
    const res = await safeFetch(`https://arxiv.org/abs/${arxivId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();

    // Match GitHub and GitLab URLs
    const ghRegex =
      /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+(?:\/[^\s"'<)}\]]*)?/g;
    const glRegex =
      /https?:\/\/(?:www\.)?gitlab\.com\/[\w.-]+\/[\w.-]+(?:\/[^\s"'<)}\]]*)?/g;

    const seen = new Set<string>();
    for (const match of html.matchAll(ghRegex)) {
      // Normalise to repo root
      const url = match[0]
        .replace(/\/tree\/.*$/, "")
        .replace(/\/blob\/.*$/, "")
        .replace(/\/issues.*$/, "")
        .replace(/\/pull.*$/, "")
        .replace(/\/$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      const repoName = url.split("/").slice(-2).join("/");
      results.push({
        url,
        title: repoName,
        sourceType: url.includes("arxiv")
          ? "arxiv_supplementary"
          : "github",
        description: `Code repository found on arXiv page for ${arxivId}`,
      });
    }
    for (const match of html.matchAll(glRegex)) {
      const url = match[0].replace(/\/tree\/.*$/, "").replace(/\/$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      const repoName = url.split("/").slice(-2).join("/");
      results.push({
        url,
        title: repoName,
        sourceType: "arxiv_supplementary",
        description: `GitLab repository found on arXiv page for ${arxivId}`,
      });
    }
  } catch {
    // Never let discovery errors propagate
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. Papers With Code API
// ---------------------------------------------------------------------------

export async function findPapersWithCode(
  title: string,
  arxivId?: string,
): Promise<ResourceLink[]> {
  const results: ResourceLink[] = [];
  try {
    const query = arxivId ?? title;
    const url = `https://paperswithcode.com/api/v1/papers/?q=${encodeURIComponent(query)}`;
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
    const data = (await res.json()) as {
      results?: Array<{
        id?: string;
        paper_title?: string;
        url_abs?: string;
        proceeding?: string;
        repositories?: Array<{
          url?: string;
          description?: string;
          language?: string;
        }>;
      }>;
    };

    if (data.results) {
      for (const paper of data.results.slice(0, 3)) {
        if (paper.url_abs) {
          results.push({
            url: paper.url_abs,
            title: paper.paper_title ?? title,
            sourceType: "papers_with_code",
            description: paper.proceeding ?? undefined,
          });
        }
        if (paper.repositories) {
          for (const repo of paper.repositories) {
            if (repo.url) {
              results.push({
                url: repo.url,
                title: paper.paper_title ?? title,
                sourceType: "papers_with_code",
                description: repo.description ?? undefined,
                language: repo.language ?? undefined,
              });
            }
          }
        }
      }
    }

    // Rate limiting
    await sleep(1_000);
  } catch {
    // Never let discovery errors propagate
  }
  return results;
}

// ---------------------------------------------------------------------------
// 3. GitHub repository search
// ---------------------------------------------------------------------------

export async function findGitHubRepo(
  query: string,
): Promise<ResourceLink[]> {
  const results: ResourceLink[] = [];
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=3`;
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Mathub-ResourceDiscovery/1.0",
      },
    });
    const data = (await res.json()) as {
      items?: Array<{
        html_url?: string;
        full_name?: string;
        description?: string;
        language?: string;
      }>;
    };

    if (data.items) {
      for (const repo of data.items.slice(0, 3)) {
        if (repo.html_url) {
          results.push({
            url: repo.html_url,
            title: repo.full_name ?? query,
            sourceType: "github",
            description: repo.description ?? undefined,
            language: repo.language ?? undefined,
          });
        }
      }
    }
  } catch {
    // Never let discovery errors propagate
  }
  return results;
}

// ---------------------------------------------------------------------------
// 4. Semantic Scholar supplementary materials
// ---------------------------------------------------------------------------

export async function findSemanticScholarSupplementary(
  paperId: string,
): Promise<ResourceLink[]> {
  const results: ResourceLink[] = [];
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/${paperId}?fields=openAccessPdf,externalIds,url`;
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
    const data = (await res.json()) as {
      openAccessPdf?: { url?: string };
      externalIds?: Record<string, string>;
      url?: string;
    };

    // Check for GitHub links in externalIds
    if (data.externalIds) {
      for (const [key, value] of Object.entries(data.externalIds)) {
        if (
          typeof value === "string" &&
          value.includes("github.com")
        ) {
          results.push({
            url: value,
            title: `GitHub (via Semantic Scholar ${key})`,
            sourceType: "github",
            description: `Found in Semantic Scholar externalIds.${key}`,
          });
        }
      }
    }

    // Open access PDF
    if (data.openAccessPdf?.url) {
      results.push({
        url: data.openAccessPdf.url,
        title: "Open Access PDF",
        sourceType: "arxiv_supplementary",
        description: "Open access PDF via Semantic Scholar",
      });
    }

    // Semantic Scholar page
    if (data.url) {
      results.push({
        url: data.url,
        title: "Semantic Scholar page",
        sourceType: "project_website",
        description: "Paper page on Semantic Scholar",
      });
    }
  } catch {
    // Never let discovery errors propagate
  }
  return results;
}

// ---------------------------------------------------------------------------
// 5. Orchestrator — discover all resources for a paper
// ---------------------------------------------------------------------------

export async function discoverResourcesForPaper(paper: {
  title: string;
  arxivId?: string;
  semanticScholarId?: string;
}): Promise<ResourceLink[]> {
  const promises: Promise<ResourceLink[]>[] = [];

  if (paper.arxivId) {
    promises.push(findArxivCodeLinks(paper.arxivId));
  }

  promises.push(findPapersWithCode(paper.title, paper.arxivId));
  promises.push(findGitHubRepo(paper.title));

  if (paper.semanticScholarId) {
    promises.push(findSemanticScholarSupplementary(paper.semanticScholarId));
  }

  const settled = await Promise.allSettled(promises);

  const all: ResourceLink[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      all.push(...result.value);
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const deduplicated: ResourceLink[] = [];
  for (const link of all) {
    const normalized = link.url.replace(/\/$/, "").toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduplicated.push(link);
  }

  return deduplicated;
}

// ---------------------------------------------------------------------------
// 6. Effort-level discovery — discover and persist resources for an effort
// ---------------------------------------------------------------------------

function sanitizeUrlForPath(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._/-]/g, "_")
    .slice(0, 200);
}

export async function discoverEffortResources(
  effortId: string,
  sources: Array<{ title: string; arxivId?: string; url?: string }>,
  db: ReturnType<typeof getDb>,
  emit?: (event: { type: string; [key: string]: unknown }) => void,
): Promise<ResourceLink[]> {
  const allResources: ResourceLink[] = [];

  for (const source of sources) {
    if (!source.arxivId) continue;
    try {
      const resources = await discoverResourcesForPaper({
        title: source.title,
        arxivId: source.arxivId,
      });

      for (const resource of resources) {
        try {
          await db
            .insert(workspaceEffortFiles)
            .values({
              effortId,
              name: resource.title,
              path: `resources/${sanitizeUrlForPath(resource.url)}`,
              type: "file",
              url: resource.url,
              sourceType: resource.sourceType,
              size: 0,
            })
            .onConflictDoNothing();

          emit?.({
            type: "resource_found",
            effortId,
            url: resource.url,
            title: resource.title,
            sourceType: resource.sourceType,
          });
        } catch {
          // DB insert failure should not break discovery
        }
      }

      allResources.push(...resources);
    } catch {
      // Individual source failure should not break the loop
    }
  }

  return allResources;
}
