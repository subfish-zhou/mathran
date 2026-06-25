/**
 * Zod schemas for the layered `.mathran/` config model (C 方案).
 *
 * These types are shared across the three cascade layers
 * (PROJECT > WORKSPACE > USER):
 *
 *   - {@link MathranRootSignatureSchema} — the `.signature` file written when a
 *     `.mathran/` root is created. Used to verify a directory really is a
 *     mathran root before we touch it (防止覆盖到无关目录).
 *   - {@link MathranSettingsSchema} — `settings.json`, shared by every layer.
 *   - {@link SkillManifestSchema} — parsed from a `SKILL.md` frontmatter block.
 *   - {@link CommandManifestSchema} — a slash command (`commands/<name>.md`).
 *
 * All schemas are intentionally permissive about *extra* keys (forward
 * compatibility) but strict about the *types* of the keys they know.
 */

import { z } from "zod";

/** Current `settings.json` schema version. Bumped on breaking field changes. */
export const SETTINGS_SCHEMA_VERSION = 1;

// ──────────────────────────────────────────────────────────────────────
// .signature
// ──────────────────────────────────────────────────────────────────────

/**
 * The `.mathran/.signature` file. Written once at root-creation time and
 * re-read (and validated) on every startup. The `nonce` makes a signature
 * unforgeable-by-accident: a stray `{}` won't validate.
 */
export const MathranRootSignatureSchema = z
  .object({
    /** mathran version that created the root (from package.json). */
    version: z.string().min(1),
    /** ISO-8601 creation timestamp. */
    createdAt: z.string().min(1),
    /** Random nonce (hex) — distinguishes a real signature from a stub. */
    nonce: z.string().min(8),
  })
  .passthrough();

export type MathranRootSignature = z.infer<typeof MathranRootSignatureSchema>;

// ──────────────────────────────────────────────────────────────────────
// settings.json
// ──────────────────────────────────────────────────────────────────────

export const ModelPreferenceSchema = z
  .object({
    default: z.string().optional(),
    fallback: z.array(z.string()).optional(),
  })
  .passthrough();

export type ModelPreference = z.infer<typeof ModelPreferenceSchema>;

/** Canonical reasoning-effort levels (#6). */
export const ReasoningEffortLevelSchema = z.enum(["low", "medium", "high", "max"]);

/**
 * `settings.json#chat` — chat-session defaults. Currently carries the
 * reasoning-effort budget defaults (#6):
 *   - `defaultEffort`  workspace/project default effort level.
 *   - `modelEffort`    per-model override, keyed by routing model string.
 */
export const ChatSettingsSchema = z
  .object({
    defaultEffort: ReasoningEffortLevelSchema.optional(),
    modelEffort: z.record(z.string(), ReasoningEffortLevelSchema).optional(),
  })
  .passthrough();

export type ChatSettings = z.infer<typeof ChatSettingsSchema>;

// ──────────────────────────────────────────────────────────────────────
// approval (Approval Policy 矩阵)
// ──────────────────────────────────────────────────────────────────────

/** An inline approval rule inside `settings.json` (lowest precedence). */
export const ApprovalRuleSchema = z
  .object({
    tool: z.string().min(1),
    prefix: z.string().optional(),
    pathGlob: z.string().optional(),
    action: z.enum(["allow", "deny"]),
    scope: z.enum(["session", "persistent"]).optional(),
  })
  .passthrough();

export type ApprovalRuleConfig = z.infer<typeof ApprovalRuleSchema>;

/**
 * `settings.json#approval` — the approval-policy config block. All fields are
 * optional; a missing block (or a missing `policy`) falls back to the default
 * `on-request` policy at load time (see {@link DEFAULT_APPROVAL_POLICY}).
 */
export const ApprovalSettingsSchema = z
  .object({
    /** never | on-request | untrusted | on-failure. Default on-request. */
    policy: z.enum(["never", "on-request", "untrusted", "on-failure"]).optional(),
    /** Learning mode on/off. Default true. */
    learning: z.boolean().optional(),
    /** Consecutive-decision threshold before proposing a rule. Default 5. */
    proposeAfter: z.number().int().positive().optional(),
    /** Inline rules (lower precedence than approval-rules.json files). */
    rules: z.array(ApprovalRuleSchema).optional(),
    /** Denylist entries `"<tool>:<pattern>"` — highest-priority veto. */
    denylist: z.array(z.string()).optional(),
  })
  .passthrough();

export type ApprovalSettings = z.infer<typeof ApprovalSettingsSchema>;

/**
 * `settings.json` — workspace + project (+ user) shared shape.
 *
 * Whitelist note: the USER layer may only contribute `ui.theme`, `editor`
 * and `modelPreference` (see `layered-settings.ts`). `skills.disabled` and
 * `hooks.allowed` are deliberately *not* user-overridable.
 */
export const MathranSettingsSchema = z
  .object({
    /** Schema version of this file (defaults to current on write). */
    schemaVersion: z.number().int().optional(),
    ui: z
      .object({
        theme: z.enum(["light", "dark", "system"]).optional(),
      })
      .passthrough()
      .optional(),
    editor: z.string().optional(),
    modelPreference: ModelPreferenceSchema.optional(),
    /** Chat-session defaults — reasoning-effort budget (#6). */
    chat: ChatSettingsSchema.optional(),
    skills: z
      .object({
        disabled: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    hooks: z
      .object({
        /** Whitelist of hook names/types — when present, only these run. */
        allowed: z.array(z.string()).optional(),
        /** Master switch for the whole hooks subsystem (default true). */
        enabled: z.boolean().optional(),
        /** Per-hook timeout in ms (default 30000). */
        timeoutMs: z.number().int().positive().optional(),
        /** Run post-* / on-* hooks fire-and-forget (default false). */
        async: z.boolean().optional(),
        /** Operations whose filePath/command start with these skip hooks. */
        bypassPrefix: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    agent: z
      .object({
        maxIterations: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    /** Approval Policy 矩阵 — see {@link ApprovalSettingsSchema}. */
    approval: ApprovalSettingsSchema.optional(),
    /**
     * Goal-mode (long-running autonomous loop) settings.
     *
     * `markDoneReview` — Layer 2 content-review hook that gates `mark_done`
     * (DESIGN-REFERENCE.md §8). Default `mode: "off"` for backward compat;
     * `"deterministic"` is the recommended low-cost setting (scans the
     * goal's `.plan.md` for unchecked items, no LLM call).
     */
    goal: z
      .object({
        markDoneReview: z
          .object({
            mode: z
              .enum(["off", "deterministic", "llm", "both"])
              .optional(),
            reviewerModel: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    /**
     * Permission Profiles (#2) — default profile name applied when no
     * `--profile` flag is given (dev | ci | review | custom). The CLI `--profile`
     * flag overrides this.
     */
    profile: z.string().optional(),
  })
  .passthrough();

export type MathranSettings = z.infer<typeof MathranSettingsSchema>;

// ──────────────────────────────────────────────────────────────────────
// skills / commands
// ──────────────────────────────────────────────────────────────────────

/**
 * A skill trigger: either a simple keyword substring, or an object combining
 * a list of keywords and/or a regex. Absent trigger ⇒ the skill is "always"
 * active (injected at session start, like the pre-extension behaviour).
 */
export const SkillTriggerSchema = z.union([
  z.string(),
  z
    .object({
      keywords: z.array(z.string()).optional(),
      regex: z.string().optional(),
    })
    .passthrough(),
]);

export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;

/**
 * `SKILL.md` frontmatter (Codex-style). `name` is required; everything else
 * is optional and extra keys are preserved.
 *
 * Skills/Plugins 二层 extends the base frontmatter with:
 *   - `trigger`        — keyword / regex match deciding WHEN the skill injects.
 *   - `promptTemplate` — text injected into the system prompt on activation
 *                        (supports the `{{userMessage}}` placeholder). When
 *                        absent the skill body is injected instead.
 *   - `allowedTools`   — tools auto-approved while the skill is active. Each
 *                        entry is a tool name (`"bash"`) or `tool:prefix`
 *                        (`"bash:lake"`).
 *   - `argHints`       — free-form hints describing user-supplied args.
 *   - `version` / `author` / `tags` — metadata.
 *
 * All new fields are optional, so pre-existing SKILL.md files keep loading.
 */
export const SkillManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    trigger: SkillTriggerSchema.optional(),
    promptTemplate: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    argHints: z.record(z.string(), z.string()).optional(),
    version: z.string().optional(),
    author: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

/**
 * A slash command parsed from `commands/<name>.md`. The `body` is the markdown
 * body (sans frontmatter) and carries the actual prompt/template.
 */
export const CommandManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    body: z.string(),
  })
  .passthrough();

export type CommandManifest = z.infer<typeof CommandManifestSchema>;
