// Tiny typed client for the mathran local backend (src/server/serve.ts).

import type {
  EffectiveSettingsResponse,
  LayerSettingsResponse,
  SettingsLayerName,
} from "./settings-client.ts";

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
  parent?: string;
  sortOrder?: number;
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

export interface WikiHistoryEntry {
  version: number;
  savedAt: string;
}

export interface WikiDiffSide {
  /** Either a positive integer (history) or the literal string "current". */
  version: number | "current";
  /** Human-readable label like "v1" or "current (v3)". */
  label: string;
}

export interface WikiDiffResponse {
  page: string;
  from: WikiDiffSide;
  to: WikiDiffSide;
  /** Unified-diff text produced by jsdiff's createTwoFilesPatch. */
  patch: string;
}

export interface ProviderInfo {
  kind: string;
  model: string | null;
  baseUrl?: string | null;
  endpoint?: string | null;
  deployment?: string | null;
  apiVersion?: string | null;
  key: "set" | "missing";
}

export interface ProvidersResponse {
  providers: Record<string, ProviderInfo>;
  defaultModel: string | null;
}

export interface EffortSummary {
  slug: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  lastUsedAt: string;
  messageCount: number;
}

/** Response shape of `GET <chat-base>/:id/usage` (v0.3 §19). */
export interface UsageStats {
  tokens: number;
  messages: number;
  contextWindow: number;
  percentage: number;
  warning: string | null;
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

const enc = encodeURIComponent;

export const api = {
  async health(): Promise<{ ok: boolean; version: string; workspace: string }> {
    return jsonOrThrow(await fetch("/api/health"));
  },

  // ─── Projects ─────────────────────────────────────────────────────────────
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
    return jsonOrThrow(await fetch(`/api/projects/${enc(slug)}`));
  },

  // ─── Wiki (multi-page + versioned) ───────────────────────────────────────
  async listWiki(slug: string): Promise<WikiPageSummary[]> {
    const data = await jsonOrThrow<{ pages: WikiPageSummary[] }>(
      await fetch(`/api/projects/${enc(slug)}/wiki`),
    );
    return data.pages;
  },
  async getWikiPage(slug: string, page: string): Promise<WikiPage> {
    return jsonOrThrow(await fetch(`/api/projects/${enc(slug)}/wiki/${enc(page)}`));
  },
  async saveWikiPage(
    slug: string,
    page: string,
    body: string,
    extra: { title?: string; parent?: string; sortOrder?: number } = {},
  ): Promise<WikiPage> {
    return jsonOrThrow(
      await fetch(`/api/projects/${enc(slug)}/wiki/${enc(page)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, ...extra }),
      }),
    );
  },
  async wikiHistory(slug: string, page: string): Promise<WikiHistoryEntry[]> {
    const data = await jsonOrThrow<{ versions: WikiHistoryEntry[] }>(
      await fetch(`/api/projects/${enc(slug)}/wiki/${enc(page)}/history`),
    );
    return data.versions;
  },
  async wikiHistoryVersion(slug: string, page: string, version: number): Promise<WikiPage> {
    return jsonOrThrow(
      await fetch(`/api/projects/${enc(slug)}/wiki/${enc(page)}/history/${version}`),
    );
  },
  /**
   * Fetch a unified diff between two versions of a wiki page (GAP #10).
   * `from` / `to` accept a positive integer (a snapshot in `.history/`) or the
   * literal string `"current"`. Defaults: from=latest history snapshot,
   * to=current.
   */
  async wikiDiff(
    slug: string,
    page: string,
    opts: { from?: number | "current"; to?: number | "current" } = {},
  ): Promise<WikiDiffResponse> {
    const params = new URLSearchParams();
    if (opts.from !== undefined) params.set("from", String(opts.from));
    if (opts.to !== undefined) params.set("to", String(opts.to));
    const qs = params.toString();
    return jsonOrThrow(
      await fetch(`/api/projects/${enc(slug)}/wiki/${enc(page)}/diff${qs ? `?${qs}` : ""}`),
    );
  },

  // ─── Efforts ──────────────────────────────────────────────────────────────
  async listEfforts(slug: string): Promise<EffortSummary[]> {
    const data = await jsonOrThrow<{ efforts: EffortSummary[] }>(
      await fetch(`/api/projects/${enc(slug)}/efforts`),
    );
    return data.efforts;
  },
  async createEffort(
    slug: string,
    payload: { title: string; type: string; description?: string },
  ): Promise<{ slug: string; metadata: EffortSummary }> {
    return jsonOrThrow(
      await fetch(`/api/projects/${enc(slug)}/efforts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  },
  async getEffort(slug: string, effortSlug: string): Promise<{ effort: EffortSummary }> {
    return jsonOrThrow(await fetch(`/api/projects/${enc(slug)}/effort/${enc(effortSlug)}`));
  },
  async patchEffort(
    slug: string,
    effortSlug: string,
    patch: Partial<{ title: string; status: string; description: string }>,
  ): Promise<{ effort: EffortSummary }> {
    return jsonOrThrow(
      await fetch(`/api/projects/${enc(slug)}/effort/${enc(effortSlug)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },
  async getEffortDocument(slug: string, effortSlug: string): Promise<{ document: string }> {
    return jsonOrThrow(
      await fetch(`/api/projects/${enc(slug)}/effort/${enc(effortSlug)}/document`),
    );
  },
  async saveEffortDocument(slug: string, effortSlug: string, document: string): Promise<{ document: string }> {
    return jsonOrThrow(
      await fetch(`/api/projects/${enc(slug)}/effort/${enc(effortSlug)}/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document }),
      }),
    );
  },
  async listEffortFiles(slug: string, effortSlug: string): Promise<string[]> {
    const data = await jsonOrThrow<{ files: string[] }>(
      await fetch(`/api/projects/${enc(slug)}/effort/${enc(effortSlug)}/files`),
    );
    return data.files;
  },
  async getEffortFile(slug: string, effortSlug: string, filePath: string): Promise<{ content: string }> {
    return jsonOrThrow(
      await fetch(
        `/api/projects/${enc(slug)}/effort/${enc(effortSlug)}/files/${filePath.split("/").map(enc).join("/")}`,
      ),
    );
  },
  async saveEffortFile(slug: string, effortSlug: string, filePath: string, content: string): Promise<void> {
    await jsonOrThrow(
      await fetch(
        `/api/projects/${enc(slug)}/effort/${enc(effortSlug)}/files/${filePath.split("/").map(enc).join("/")}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        },
      ),
    );
  },
  async snapshotEffort(slug: string, effortSlug: string): Promise<{ version: number }> {
    return jsonOrThrow(
      await fetch(`/api/projects/${enc(slug)}/effort/${enc(effortSlug)}/snapshot`, {
        method: "POST",
      }),
    );
  },
  async listEffortVersions(slug: string, effortSlug: string): Promise<number[]> {
    const data = await jsonOrThrow<{ versions: number[] }>(
      await fetch(`/api/projects/${enc(slug)}/effort/${enc(effortSlug)}/versions`),
    );
    return data.versions;
  },

  // ─── Chat (scoped) ────────────────────────────────────────────────────────
  async listGlobalChats(): Promise<ConversationSummary[]> {
    const data = await jsonOrThrow<{ conversations: ConversationSummary[] }>(
      await fetch("/api/global-chat"),
    );
    return data.conversations;
  },
  async listProjectChats(slug: string): Promise<ConversationSummary[]> {
    const data = await jsonOrThrow<{ conversations: ConversationSummary[] }>(
      await fetch(`/api/projects/${enc(slug)}/chat`),
    );
    return data.conversations;
  },
  async listEffortChats(slug: string, effortSlug: string): Promise<ConversationSummary[]> {
    const data = await jsonOrThrow<{ conversations: ConversationSummary[] }>(
      await fetch(`/api/projects/${enc(slug)}/effort/${enc(effortSlug)}/chat`),
    );
    return data.conversations;
  },
  async dropChat(scope: ChatScopeSpec, conversationId: string): Promise<void> {
    await jsonOrThrow(
      await fetch(`${chatScopeBase(scope)}/${enc(conversationId)}`, { method: "DELETE" }),
    );
  },

  /** List conversations for any scope (dispatch by kind). */
  async listChats(scope: ChatScopeSpec): Promise<ConversationSummary[]> {
    switch (scope.kind) {
      case "global":
        return this.listGlobalChats();
      case "project":
        return this.listProjectChats(scope.projectSlug);
      case "effort":
        return this.listEffortChats(scope.projectSlug, scope.effortSlug);
    }
  },

  /**
   * Read the on-disk history of one conversation (any scope). Returns the
   * full LLMMessage[] sequence so a refresh / sidebar click can re-hydrate
   * the chat panel.
   */
  async getChatHistory(
    scope: ChatScopeSpec,
    conversationId: string,
  ): Promise<{ conversationId: string; history: any[] }> {
    return jsonOrThrow<{ conversationId: string; history: any[] }>(
      await fetch(`${chatScopeBase(scope)}/${enc(conversationId)}`),
    );
  },
  async getChatUsage(
    scope: ChatScopeSpec,
    conversationId: string,
    modelHint?: string,
  ): Promise<UsageStats> {
    const url = new URL(
      `${chatScopeBase(scope)}/${enc(conversationId)}/usage`,
      window.location.origin,
    );
    if (modelHint) url.searchParams.set("model", modelHint);
    return jsonOrThrow<UsageStats>(
      await fetch(url.pathname + url.search),
    );
  },

  // ─── Providers ────────────────────────────────────────────────────────────
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

  // ─── Layered settings (.mathran/settings.json) ───────────────────────────
  async getEffectiveSettings(projectSlug?: string): Promise<EffectiveSettingsResponse> {
    const qs = projectSlug ? `?projectSlug=${enc(projectSlug)}` : "";
    return jsonOrThrow(await fetch(`/api/settings/effective${qs}`));
  },
  async getSettings(
    layer: SettingsLayerName,
    projectSlug?: string,
  ): Promise<LayerSettingsResponse> {
    const qs = projectSlug ? `?projectSlug=${enc(projectSlug)}` : "";
    return jsonOrThrow(await fetch(`/api/settings/${enc(layer)}${qs}`));
  },
  async putSettings(
    layer: SettingsLayerName,
    patch: Record<string, unknown>,
    projectSlug?: string,
  ): Promise<LayerSettingsResponse> {
    const qs = projectSlug ? `?projectSlug=${enc(projectSlug)}` : "";
    return jsonOrThrow(
      await fetch(`/api/settings/${enc(layer)}${qs}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },
};

export type ChatScopeSpec =
  | { kind: "global" }
  | { kind: "project"; projectSlug: string }
  | { kind: "effort"; projectSlug: string; effortSlug: string };

/** Map a `ChatScopeSpec` to its `/api/...` base URL. */
export function chatScopeBase(scope: ChatScopeSpec): string {
  switch (scope.kind) {
    case "global":
      return "/api/global-chat";
    case "project":
      return `/api/projects/${enc(scope.projectSlug)}/chat`;
    case "effort":
      return `/api/projects/${enc(scope.projectSlug)}/effort/${enc(scope.effortSlug)}/chat`;
  }
}
