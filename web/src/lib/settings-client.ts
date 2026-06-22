// Pure helpers + types for the layered-settings UI (`SettingsPanel.tsx`).
//
// Everything testable about the settings page lives here so the component stays
// a thin rendering shell and the logic (diffing, USER whitelist, denylist
// parsing, approval-rule edits) is unit-tested without jsdom.

export type SettingsLayerName = "user" | "workspace" | "project";

/** Loose settings shape — mirrors `MathranSettingsSchema` (all optional). */
export interface MathranSettings {
  schemaVersion?: number;
  ui?: { theme?: "light" | "dark" | "system"; [k: string]: unknown };
  editor?: string;
  modelPreference?: { default?: string; fallback?: string[]; [k: string]: unknown };
  skills?: { disabled?: string[]; [k: string]: unknown };
  hooks?: { allowed?: string[]; [k: string]: unknown };
  agent?: { maxIterations?: number; timeoutMs?: number; [k: string]: unknown };
  approval?: ApprovalSettings;
  [k: string]: unknown;
}

export interface ApprovalRule {
  tool: string;
  prefix?: string;
  pathGlob?: string;
  action: "allow" | "deny";
  scope?: "session" | "persistent";
  [k: string]: unknown;
}

export interface ApprovalSettings {
  policy?: "never" | "on-request" | "untrusted" | "on-failure";
  learning?: boolean;
  proposeAfter?: number;
  rules?: ApprovalRule[];
  denylist?: string[];
  [k: string]: unknown;
}

export interface EffectiveSettingsResponse {
  effective: MathranSettings;
  layers: {
    user: MathranSettings;
    workspace: MathranSettings;
    project?: MathranSettings;
  };
  sources: Record<string, SettingsLayerName>;
  paths: { user: string; workspace: string; project?: string };
  warnings: string[];
}

export interface LayerSettingsResponse {
  layer: SettingsLayerName;
  settings: MathranSettings;
  path: string;
}

export const APPROVAL_POLICIES = [
  "never",
  "on-request",
  "untrusted",
  "on-failure",
] as const;

export const THEMES = ["light", "dark", "system"] as const;

/** The settings sections the USER layer is allowed to edit. */
export const USER_EDITABLE_SECTIONS: ReadonlyArray<string> = [
  "ui",
  "editor",
  "modelPreference",
];

/**
 * Whether a given section is editable for a layer. The USER layer is
 * whitelisted to `ui` / `editor` / `modelPreference`; WORKSPACE and PROJECT may
 * edit every section.
 */
export function isSectionEditable(
  layer: SettingsLayerName,
  section: string,
): boolean {
  if (layer === "user") return USER_EDITABLE_SECTIONS.includes(section);
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compute the minimal patch (changed/added fields only) between the loaded
 * baseline and the edited draft. Nested plain objects are diffed recursively so
 * a PUT carries only the keys the user actually changed — never the whole
 * schema (which would clobber hand-edited passthrough fields).
 */
export function diffSettings(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(draft)) {
    const bv = base[key];
    const dv = draft[key];
    if (isPlainObject(bv) && isPlainObject(dv)) {
      const sub = diffSettings(bv, dv);
      if (Object.keys(sub).length > 0) patch[key] = sub;
    } else if (!deepEqual(bv, dv)) {
      patch[key] = dv;
    }
  }
  return patch;
}

/** True when the draft differs from the baseline (there is something to save). */
export function hasUnsavedChanges(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
): boolean {
  return Object.keys(diffSettings(base, draft)).length > 0;
}

/** Parse a newline-separated denylist textarea into a trimmed string[]. */
export function parseDenylist(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Render a denylist array back into newline-separated textarea text. */
export function serializeDenylist(entries: string[] | undefined): string {
  return (entries ?? []).join("\n");
}

/** Append an approval rule (immutably). */
export function addApprovalRule(
  rules: ApprovalRule[] | undefined,
  rule: ApprovalRule,
): ApprovalRule[] {
  return [...(rules ?? []), rule];
}

/** Remove the approval rule at `index` (immutably). */
export function removeApprovalRule(
  rules: ApprovalRule[] | undefined,
  index: number,
): ApprovalRule[] {
  const next = [...(rules ?? [])];
  next.splice(index, 1);
  return next;
}

/** Human label for a field's source layer, e.g. "(from workspace)". */
export function sourceLabel(
  sources: Record<string, SettingsLayerName>,
  fieldPath: string,
): string | null {
  const src = sources[fieldPath];
  return src ? `from ${src}` : null;
}
