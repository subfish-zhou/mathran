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

/**
 * Hard defaults for the dual-model pair (DESIGN-REFERENCE §6.7). These are
 * aspirational — they assume the user has `openai` and `anthropic` providers
 * configured. When neither is present, `resolveModelPair` falls back to an
 * empty string instead, which the ModelRouter then resolves via its own
 * `defaultModel` setting (e.g. `copilot` for copilot-only users).
 */
export const DEFAULT_WRITER_MODEL = "openai/gpt-5.5";
export const DEFAULT_REVIEWER_MODEL = "anthropic/opus-4.8";

/**
 * Sentinel "let the provider decide" model string. ModelRouter resolves "" by
 * routing to its own `defaultModel` or the first configured provider — which
 * is exactly what unconfigured users need.
 */
const PROVIDER_DEFAULT_MODEL = "";

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
 *
 * `contextDefault` (the user's currently-configured model from ctx.model) is
 * used as the FINAL fallback before the hard-coded provider-prefixed defaults.
 * This prevents wiring `"openai/gpt-5.5"` (the W4b-δ design default) into an
 * environment that only has the `copilot` provider configured — dogfood run 3
 * caught exactly this: with no MATHRAN_*_MODEL env vars and no persisted
 * settings, the agent emitted `ModelRouter: unknown provider "openai"` for
 * every wiki page and every review-loop call. Falling back to the user's
 * actual configured model keeps the run unblocked; the user can still opt
 * into a distinct dual-model setup via env or CLI flags.
 *
 * When `contextDefault` is undefined (no model configured at all), we fall
 * through to the historical hard defaults — those still work for users who
 * have an openai/anthropic-routed provider, and they're a better signal in
 * the run report than an empty string.
 */
export async function resolveModelPair(
  config: Pick<AiInitConfig, "writerModel" | "reviewerModel">,
  projectDir: string,
  contextDefault?: string,
): Promise<ResolvedModelPair> {
  const persisted = await loadModelPair(projectDir);
  // Fallback ladder: explicit context default (ctx.model) > "let provider decide" ("") .
  // The historical hard defaults (openai/gpt-5.5, anthropic/opus-4.8) are NEVER
  // auto-injected — they only kick in when the user has explicitly opted in
  // via MATHRAN_*_MODEL env vars, AiInitConfig, or persisted settings. This
  // change is the run-3 patch: previously, a user with only `copilot` configured
  // would have `openai/gpt-5.5` injected as the writer model, the ModelRouter
  // would throw `unknown provider "openai"`, and every wiki page would fail.
  const fallback = contextDefault || PROVIDER_DEFAULT_MODEL;
  const writerModel =
    config.writerModel ||
    process.env.MATHRAN_WRITER_MODEL ||
    persisted.writerModel ||
    fallback;
  const reviewerModel =
    config.reviewerModel ||
    process.env.MATHRAN_REVIEWER_MODEL ||
    persisted.reviewerModel ||
    fallback;
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
  // 2026-06-29 (fix from run-14-audit): NEVER persist empty-string writer or
  // reviewer model — an empty string is the "let provider decide" sentinel
  // and writing it back into settings.json defeats the very fallback ladder
  // that loadModelPair / resolveModelPair use to recover. Run 14's
  // settings.json had `writerModel: ""` / `reviewerModel: ""` persisted
  // from an earlier run that never got a concrete model, which made every
  // subsequent run report empty-string models even after the CLI flow
  // started passing a real default. Treat empty strings as "no change":
  // keep the prior persisted value (or leave the field absent entirely).
  const next = {
    ...existing,
    initProject: {
      ...prevInit,
      ...(pair.writerModel ? { writerModel: pair.writerModel } : {}),
      ...(pair.reviewerModel ? { reviewerModel: pair.reviewerModel } : {}),
    },
  };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf-8");
  } catch {
    /* persistence is best-effort */
  }
}

/**
 * The identical-model warning text (DESIGN-REFERENCE §6.7).
 *
 * When this fires, the orchestrator ALSO forwards `selfReviewMode: true` to
 * every review-loop call so the reviewer prompt switches into a
 * self-review-compensation framing (see review-loop/reviewer.ts). This is
 * NOT a substitute for true dual-model review — it merely prevents the
 * silent rubber-stamping observed in dogfood-run-d79c820c42b7 with a single
 * copilot model self-reviewing every effort.
 */
export const IDENTICAL_MODELS_WARNING =
  "[warn] writer and reviewer models are identical — self-review is structurally weaker than dual-model review.\n" +
  "        The reviewer prompt will be switched to self-review mode (extra-skeptical framing) as a partial mitigation.\n" +
  "        For best results, configure a SECOND provider/model via --writer-model / --reviewer-model CLI flags,\n" +
  "        MATHRAN_WRITER_MODEL / MATHRAN_REVIEWER_MODEL env vars, or settings.json initProject.{writerModel,reviewerModel}.";
