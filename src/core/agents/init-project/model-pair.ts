/**
 * Writer/reviewer model-pair resolution & persistence (Task 37,
 * DESIGN-REFERENCE §6.7).
 *
 * The init agent's writer-reviewer dual-model loop (Phase 7) uses two distinct
 * models: a *writer* (drafts efforts / wiki pages) and a *reviewer* (reads the
 * draft as a skeptical reader and asks for revisions). Per subfish:
 *   - default writer   = openai/gpt-5.5
 *   - default reviewer = anthropic/opus-4.8
 *
 * Resolution precedence (highest first):
 *   1. explicit value on `AiInitConfig` (CLI flag / HTTP body)
 *   2. environment override (`MATHRAN_WRITER_MODEL` / `MATHRAN_REVIEWER_MODEL`)
 *   3. the persisted pair in `<project>/.mathran/settings.json`
 *   4. the hard default
 *
 * The resolved pair is persisted back to `<project>/.mathran/settings.json`
 * (under the `initProject` key) so subsequent re-runs reuse the same pair
 * unless overridden.
 *
 * Failure-isolated: persistence/loading never throw — a corrupt or missing
 * settings file simply degrades to defaults.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AiInitConfig } from "./types.js";

export const DEFAULT_WRITER_MODEL = "openai/gpt-5.5";
export const DEFAULT_REVIEWER_MODEL = "anthropic/opus-4.8";

export interface ModelPair {
  writerModel: string;
  reviewerModel: string;
}

export interface ResolvedModelPair extends ModelPair {
  /** True when writer === reviewer (self-review; weaker than dual-model). */
  identical: boolean;
}

function settingsPath(projectDir: string): string {
  return path.join(projectDir, ".mathran", "settings.json");
}

/** Read the persisted writer/reviewer pair from a project's settings.json. */
export async function loadModelPair(projectDir: string): Promise<Partial<ModelPair>> {
  try {
    const raw = await fs.readFile(settingsPath(projectDir), "utf-8");
    const parsed = JSON.parse(raw) as { initProject?: Partial<ModelPair> };
    const ip = parsed.initProject;
    if (!ip || typeof ip !== "object") return {};
    const out: Partial<ModelPair> = {};
    if (typeof ip.writerModel === "string" && ip.writerModel.length > 0) out.writerModel = ip.writerModel;
    if (typeof ip.reviewerModel === "string" && ip.reviewerModel.length > 0) out.reviewerModel = ip.reviewerModel;
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve the effective writer/reviewer pair from config + env + persisted
 * settings. Pure aside from reading the project settings file.
 */
export async function resolveModelPair(
  config: Pick<AiInitConfig, "writerModel" | "reviewerModel">,
  projectDir: string,
): Promise<ResolvedModelPair> {
  const persisted = await loadModelPair(projectDir);
  const writerModel =
    config.writerModel ||
    process.env.MATHRAN_WRITER_MODEL ||
    persisted.writerModel ||
    DEFAULT_WRITER_MODEL;
  const reviewerModel =
    config.reviewerModel ||
    process.env.MATHRAN_REVIEWER_MODEL ||
    persisted.reviewerModel ||
    DEFAULT_REVIEWER_MODEL;
  return { writerModel, reviewerModel, identical: writerModel === reviewerModel };
}

/**
 * Persist the writer/reviewer pair under `initProject` in the project's
 * settings.json, preserving any other keys. Never throws.
 */
export async function persistModelPair(projectDir: string, pair: ModelPair): Promise<void> {
  const file = settingsPath(projectDir);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const prevInit =
    existing.initProject && typeof existing.initProject === "object"
      ? (existing.initProject as Record<string, unknown>)
      : {};
  const next = {
    ...existing,
    initProject: {
      ...prevInit,
      writerModel: pair.writerModel,
      reviewerModel: pair.reviewerModel,
    },
  };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf-8");
  } catch {
    /* persistence is best-effort */
  }
}

/** The identical-model warning text (DESIGN-REFERENCE §6.7). */
export const IDENTICAL_MODELS_WARNING =
  "[warn] writer and reviewer models are identical; self-review is weaker than dual-model review.";
