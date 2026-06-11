/**
 * ArtifactSink — Mathran's abstraction over "where do agent-produced docs
 * and notifications land".
 *
 * In Mathub, this implementation writes to wiki pages + posts activity
 * feed entries + fires user notifications.
 *
 * In a standalone Mathran deploy, the default LocalFsSink writes markdown
 * files into a configured directory and `git commit`s them; notifications
 * are appended to a log file (or no-op).
 *
 * Mathran's agent loop ONLY talks to ArtifactSink — it never imports the
 * host's wiki/notification/activity modules directly. This is the
 * single most important boundary in the v0.1 design.
 */

export interface PageInput {
  /** Human-readable title; the sink derives a slug if it needs one. */
  title: string;
  /** Markdown content. */
  body: string;
  /** Free-form tags (e.g. ["agent-generated", "mathran"]). */
  tags?: string[];
  /** Host-defined scope id (project/program/effort). */
  scopeId?: string;
  /** Author identity. */
  authorId: string;
}

export interface CommitInput {
  /** Page id returned from createPage. */
  pageId: string;
  /** New body content (full replacement). */
  body: string;
  /** Optional commit message. */
  message?: string;
  authorId: string;
}

export interface NotificationPayload {
  kind: string; // e.g. "run.completed", "lean.error"
  title: string;
  body?: string;
  /** Deep-link the user-facing UI can render. */
  url?: string;
}

export interface ActivityEntry {
  actorId: string;
  verb: string;     // e.g. "created", "proved", "failed"
  objectType: string; // e.g. "page", "effort", "run"
  objectId: string;
  scopeId?: string;
  meta?: Record<string, unknown>;
}

export interface ArtifactSink {
  describe(): Promise<{ name: string }>;

  createPage(input: PageInput): Promise<{ id: string; slug: string }>;
  updatePage(id: string, input: Partial<PageInput>): Promise<void>;
  commit(input: CommitInput): Promise<{ commitSha: string }>;

  notify(userId: string, payload: NotificationPayload): Promise<void>;
  postActivity(entry: ActivityEntry): Promise<void>;
}
