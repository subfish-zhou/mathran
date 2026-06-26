/**
 * User-distillation Phase 1 — schemas for the `~/.mathran/profile/`
 * layer. This is the LAYER 1 ("hard evidence, user-authored") trust
 * tier. All entries are written by the user via the SPA (or by the
 * model strictly after ask_user confirmation). Mathran's model tools
 * are read-only against this layer.
 *
 * 2026-06-26.
 *
 * Layout:
 *   ~/.mathran/profile/papers-own.jsonl
 *   ~/.mathran/profile/papers-cited.jsonl
 *   ~/.mathran/profile/projects.toml
 *   ~/.mathran/profile/reactions.jsonl    (Phase 2 placeholder)
 *
 * Schemas are intentionally permissive on `description`/`notes` fields
 * (no length cap) because users may want to dump several paragraphs of
 * context; if storage blows up we'll add a soft cap in a later phase.
 */

import { z } from "zod";

/**
 * One paper the user has authored or co-authored. At least one external
 * identifier (arxivId or doi) is required so the row can be deduped
 * against the paper-graph; without an id we can't link it to anything
 * mathran fetches automatically later.
 */
export const OwnPaperEntrySchema = z
  .object({
    /** arXiv id (e.g. "2401.12345"). Either this or `doi` is required. */
    arxivId: z.string().min(1).optional(),
    /** DOI (e.g. "10.1090/jams/123"). Either this or `arxivId` is required. */
    doi: z.string().min(1).optional(),
    title: z.string().min(1),
    year: z.number().int().min(1900).max(2200).optional(),
    /**
     * The user's role on this paper. `author` = sole or first author;
     * `coauthor` = anywhere in the author list; `advisor` = supervised
     * the student authors. Used by the model to phrase references
     * accurately ("your paper" vs "your student's paper").
     */
    role: z.enum(["author", "coauthor", "advisor"]),
    /** 1-based position in the author list; optional metadata. */
    authorOrder: z.number().int().positive().optional(),
    status: z.enum(["published", "preprint", "draft"]).default("preprint"),
    url: z.string().url().optional(),
    /** Free-form notes the user wants attached to this paper. */
    notes: z.string().optional(),
    /** ISO 8601 timestamp set on first write; preserved across edits. */
    addedAt: z.string().datetime().optional(),
  })
  .refine((v) => v.arxivId !== undefined || v.doi !== undefined, {
    message: "at least one of arxivId or doi is required",
    path: ["arxivId"],
  });

export type OwnPaperEntry = z.infer<typeof OwnPaperEntrySchema>;
export type OwnPaperEntryInput = z.input<typeof OwnPaperEntrySchema>;

/**
 * One paper the user explicitly tags as "I've cited / built on this".
 * Distinct from `papers-own`: the user did NOT author it, but it's
 * important enough to their work that mathran should know about it
 * when picking references / suggesting follow-up reading.
 */
export const CitedPaperEntrySchema = z.object({
  /** Either arxivId, doi, OR a paper-graph node id (whatever the user has). */
  paperId: z.string().min(1),
  /** Why this paper matters to the user — one sentence is plenty. */
  contextHint: z.string().optional(),
  addedAt: z.string().datetime().optional(),
});

export type CitedPaperEntry = z.infer<typeof CitedPaperEntrySchema>;

/**
 * One active research project / direction. Distinct from the
 * workspace-level `projects/<slug>/` directory: that's where the work
 * lives; this is the user's self-description of what they're working
 * on, in their own words. The two are linked by `slug` (must match an
 * existing workspace project) when one applies.
 */
export const ProjectProfileEntrySchema = z.object({
  /**
   * The workspace project slug (e.g. "goldbach-s-conjecture") when this
   * profile entry corresponds to an existing workspace project; or a
   * free slug when the project lives outside mathran.
   */
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i, "invalid slug"),
  title: z.string().min(1),
  status: z.enum(["active", "paused", "finished", "abandoned"]).default("active"),
  /**
   * Methods / techniques the user typically employs on this project
   * ("sieve method", "modular forms", "elliptic regularity").
   * Free-form strings — mathran does NOT canonicalise. The model is
   * the search index over these.
   */
  methods: z.array(z.string()).optional(),
  /** Collaborator names — informational only. No identity lookup. */
  collaborators: z.array(z.string()).optional(),
  /** Free-form description (the elevator pitch for the model). */
  description: z.string().optional(),
  /** ISO 8601 timestamps. */
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type ProjectProfileEntry = z.infer<typeof ProjectProfileEntrySchema>;
export type ProjectProfileEntryInput = z.input<typeof ProjectProfileEntrySchema>;

/**
 * Phase 2 placeholder. A single-click reaction on a paper / bubble.
 * Schema is shipped now so the jsonl file can be created empty and
 * Phase 2 doesn't have to add the schema as part of its own diff.
 */
export const ReactionEntrySchema = z.object({
  /** PaperGraph node id, or arxivId/doi when no node id exists yet. */
  paperId: z.string().min(1),
  reaction: z.enum(["like", "dislike", "save", "note"]),
  /** Conversation context — points back at the bubble that triggered this. */
  conversationId: z.string().optional(),
  bubbleIdx: z.number().int().nonnegative().optional(),
  /** Free-form body for `reaction: "note"`; optional otherwise. */
  body: z.string().optional(),
  timestamp: z.string().datetime(),
});

export type ReactionEntry = z.infer<typeof ReactionEntrySchema>;

/**
 * Aggregate shape returned by `GET /api/profile`. Lets the SPA fetch
 * everything in one request for the profile page header summary.
 */
export const ProfileSnapshotSchema = z.object({
  papersOwn: z.array(OwnPaperEntrySchema),
  papersCited: z.array(CitedPaperEntrySchema),
  projects: z.array(ProjectProfileEntrySchema),
  reactions: z.array(ReactionEntrySchema),
});

export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;
