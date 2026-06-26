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

// ─── LAYER 3 — inferred preferences ──────────────────────────────────
//
// Distilled by an aux-model pass over LAYER 1 (own / cited papers,
// projects) + LAYER 2 (reactions). Every entry MUST cite at least two
// evidence items so the user can trace the inference back to its
// source — without this rule the LLM hallucinates plausible-sounding
// taste claims that aren't actually grounded.
//
// 2026-06-26 (user-distillation Phase 3).

/**
 * One unit of evidence — points back at either a reaction
 * (`paperId#reaction`) or a conversation bubble (`conv:<id>#<idx>`).
 * The store doesn't enforce a schema on the string — it's user-visible
 * provenance, not a query target.
 */
export const InferenceEvidenceSchema = z.object({
  /** e.g. "arxiv-2401.0001#like" or "conv:abc123#42" */
  ref: z.string().min(1),
  /** Human-readable shorthand the SPA renders on hover. */
  label: z.string().optional(),
});
export type InferenceEvidence = z.infer<typeof InferenceEvidenceSchema>;

/**
 * What kind of preference is being expressed. Used by the SPA to
 * group entries on the Inferred tab; not enforced semantically.
 */
export const InferenceKindSchema = z.enum([
  "interest",
  "method-preference",
  "style",
  "aversion",
  "research-direction",
]);
export type InferenceKind = z.infer<typeof InferenceKindSchema>;

const ISO_DATE = z.string().datetime();

/**
 * A persisted inferred preference. Lives in inferred.jsonl ONLY after
 * the user approves it via the SPA (or a future ask_user flow). Models
 * can read these via user_profile_read(slice="inferred-active").
 *
 * Stored entries always have `id`, `inferredAt`, `expiresAt` — the
 * store fills them on write. Callers passing partial inputs should
 * use `InferredEntryInput` (a separate type with those fields
 * optional).
 */
export const InferredEntrySchema = z.object({
  /** Stable id assigned at write time (uuid v4). */
  id: z.string().min(1),
  kind: InferenceKindSchema,
  /** One-sentence statement of the preference, in the user's voice. */
  content: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
  /** REQUIRED — at least two evidence items, see file header. */
  evidence: z.array(InferenceEvidenceSchema).min(2),
  /** When the inference was produced. */
  inferredAt: ISO_DATE,
  /** When the entry stops being injected (90d default). */
  expiresAt: ISO_DATE,
  /** Optional user-attached note (when they approved with an edit). */
  userNote: z.string().optional(),
});
export type InferredEntry = z.infer<typeof InferredEntrySchema>;
/** Loose input shape — store fills id / inferredAt / expiresAt when omitted. */
export type InferredEntryInput = Omit<InferredEntry, "id" | "inferredAt" | "expiresAt"> & {
  id?: string;
  inferredAt?: string;
  expiresAt?: string;
};

/**
 * Something the user explicitly rejected. Future inference passes
 * exclude topics matching these so the same wrong claim doesn't
 * get re-proposed every run.
 *
 * Stored entries always have `disagreedAt`; callers passing partial
 * inputs use `DisagreedEntryInput`.
 */
export const DisagreedEntrySchema = z.object({
  /** The rejected claim, verbatim. */
  content: z.string().min(1),
  disagreedAt: ISO_DATE,
  /** Inference run / candidate that produced the rejected claim. */
  sourceCandidateId: z.string().optional(),
  /** Optional user comment on why this was wrong. */
  userNote: z.string().optional(),
});
export type DisagreedEntry = z.infer<typeof DisagreedEntrySchema>;
export type DisagreedEntryInput = Omit<DisagreedEntry, "disagreedAt"> & {
  disagreedAt?: string;
};

/**
 * A candidate emitted by the inference pipeline, awaiting user
 * approval. Identical to InferredEntry minus the "this got approved"
 * fields. Lives in `pending-inferences.jsonl` until the user
 * approves (-> moves to inferred.jsonl) or rejects (-> removes from
 * pending + appends to disagreed.jsonl).
 *
 * Stored entries always have `id`/`proposedAt`; partial inputs use
 * `InferenceCandidateInput`.
 */
export const InferenceCandidateSchema = z.object({
  id: z.string().min(1),
  kind: InferenceKindSchema,
  content: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(InferenceEvidenceSchema).min(2),
  /** Which inference run produced this candidate. */
  runId: z.string().min(1),
  proposedAt: ISO_DATE,
});
export type InferenceCandidate = z.infer<typeof InferenceCandidateSchema>;
export type InferenceCandidateInput = Omit<InferenceCandidate, "id" | "proposedAt"> & {
  id?: string;
  proposedAt?: string;
};

/** Metadata for one inference pipeline run. */
export const InferenceRunMetaSchema = z.object({
  runId: z.string().min(1),
  startedAt: ISO_DATE,
  finishedAt: ISO_DATE.optional(),
  status: z.enum(["running", "ok", "failed"]),
  /** Number of candidates emitted (only meaningful for ok). */
  candidateCount: z.number().int().nonnegative().optional(),
  /** Failure reason (only meaningful for failed). */
  error: z.string().optional(),
  /** Model id used for this run, for cost auditing. */
  model: z.string().optional(),
});
export type InferenceRunMeta = z.infer<typeof InferenceRunMetaSchema>;
