// Tiny typed client for the mathran local backend (src/server/serve.ts).

export interface ProjectSummary {
  slug: string;
  name?: string;
  created_at?: string;
  mathran_version?: string;
}

export interface ProjectDetail {
  slug: string;
  project: Record<string, unknown>;
  entries: string[];
}

export interface WikiPageSummary {
  page: string;
  title?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface WikiPage {
  page: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

export interface ProviderInfo {
  kind: string;
  model: string | null;
  key: "set" | "missing";
}

export interface ProvidersResponse {
  providers: Record<string, ProviderInfo>;
  defaultModel: string | null;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`bad response (${res.status})`);
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  async health(): Promise<{ ok: boolean; version: string; workspace: string }> {
    return jsonOrThrow(await fetch("/api/health"));
  },

  async listProjects(): Promise<ProjectSummary[]> {
    const data = await jsonOrThrow<{ projects: ProjectSummary[] }>(await fetch("/api/projects"));
    return data.projects;
  },

  async createProject(name: string): Promise<ProjectDetail> {
    return jsonOrThrow(
      await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
  },

  async getProject(slug: string): Promise<ProjectDetail> {
    return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(slug)}`));
  },

  async listWiki(slug: string): Promise<WikiPageSummary[]> {
    const data = await jsonOrThrow<{ pages: WikiPageSummary[] }>(
      await fetch(`/api/projects/${encodeURIComponent(slug)}/wiki`),
    );
    return data.pages;
  },

  async getWikiPage(slug: string, page: string): Promise<WikiPage> {
    return jsonOrThrow(
      await fetch(`/api/projects/${encodeURIComponent(slug)}/wiki/${encodeURIComponent(page)}`),
    );
  },

  async saveWikiPage(slug: string, page: string, body: string): Promise<WikiPage> {
    return jsonOrThrow(
      await fetch(`/api/projects/${encodeURIComponent(slug)}/wiki/${encodeURIComponent(page)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      }),
    );
  },

  async getProviders(): Promise<ProvidersResponse> {
    return jsonOrThrow(await fetch("/api/providers"));
  },

  async saveProviders(payload: {
    providers?: Record<string, Record<string, unknown>>;
    defaultModel?: string;
  }): Promise<ProvidersResponse> {
    return jsonOrThrow(
      await fetch("/api/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  },
};
