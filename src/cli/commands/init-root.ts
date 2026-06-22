/**
 * `mathran root` — manage the layered `.mathran/` config root.
 *
 * Subcommands (wired in src/cli/index.ts):
 *
 *   mathran root init <path>      Create (or adopt) a `.mathran/` root with防智障 checks
 *   mathran root show             Print the merged layered settings (USER < WORKSPACE < PROJECT)
 *   mathran root validate <path>  Re-read + 验签 an existing root's `.signature`
 *   mathran root migrate          Opt-in: copy config.toml's defaultModel into settings.json
 *
 * These wrap the pure/IO helpers in `src/core/config/*`. All handlers return a
 * process exit code and print human-readable output; `--json` emits machine
 * output where applicable.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

import {
  initMathranRoot,
  validateMathranRoot,
  MATHRAN_DIR,
  SETTINGS_FILE,
} from "../../core/config/mathran-root.js";
import { loadLayeredSettings } from "../../core/config/layered-settings.js";
import { SETTINGS_SCHEMA_VERSION } from "../../core/config/schemas.js";

/** Read mathran's version from package.json (best-effort). */
export function readMathranVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/cli/commands -> repo root is three levels up.
    const pkgPath = path.resolve(here, "..", "..", "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Resolve the workspace root: --workspace > $MATHRAN_WORKSPACE > ~/mathran-workspace. */
function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return path.resolve(explicit);
  const env = process.env.MATHRAN_WORKSPACE;
  if (env && env.length > 0) return path.resolve(env);
  return path.join(os.homedir(), "mathran-workspace");
}

export interface RootInitOptions {
  /** Override $HOME for ~ expansion (tests). */
  home?: string;
  json?: boolean;
}

/** `mathran root init <path>`. */
export function runRootInit(input: string, opts: RootInitOptions = {}): number {
  try {
    const res = initMathranRoot(input, {
      version: readMathranVersion(),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    if (res.created) {
      console.log(`mathran: created root ${res.rootPath}`);
      console.log("  + .signature, .gitignore, settings.json");
      console.log("  + skills/ commands/ hooks/");
    } else {
      console.log(`mathran: adopted existing root ${res.rootPath}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`mathran root init: ${err?.message ?? err}`);
    return 1;
  }
}

export interface RootValidateOptions {
  home?: string;
  json?: boolean;
}

/** `mathran root validate <path>`. */
export function runRootValidate(input: string, opts: RootValidateOptions = {}): number {
  try {
    const res = validateMathranRoot(input, {
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(`mathran: valid root ${res.rootPath}`);
    console.log(`  version:   ${res.signature.version}`);
    console.log(`  createdAt: ${res.signature.createdAt}`);
    return 0;
  } catch (err: any) {
    console.error(`mathran root validate: ${err?.message ?? err}`);
    return 1;
  }
}

export interface RootShowOptions {
  workspace?: string;
  projectSlug?: string;
  home?: string;
  json?: boolean;
}

/** `mathran root show` — print the merged layered settings. */
export function runRootShow(opts: RootShowOptions = {}): number {
  try {
    const workspace = resolveWorkspaceRoot(opts.workspace);
    const result = loadLayeredSettings({
      workspace,
      ...(opts.projectSlug ? { projectSlug: opts.projectSlug } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.log(`mathran: effective settings (PROJECT > WORKSPACE > USER)`);
    console.log(`  workspace: ${workspace}`);
    for (const layer of result.layers) {
      const tag = layer.path ? layer.path : "(absent)";
      console.log(`  [${layer.layer}] ${tag}`);
    }
    console.log("");
    console.log(JSON.stringify(result.settings, null, 2));
    if (result.warnings.length > 0) {
      console.log("");
      for (const w of result.warnings) console.warn(`warning: ${w}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`mathran root show: ${err?.message ?? err}`);
    return 1;
  }
}

export interface RootMigrateOptions {
  workspace?: string;
  home?: string;
  /** Print what would change without writing. */
  dryRun?: boolean;
}

/**
 * `mathran root migrate` — opt-in copy of `config.toml`'s `defaultModel` into
 * `<workspace>/.mathran/settings.json` as `modelPreference.default`. Existing
 * settings fields are preserved; we never delete `config.toml`.
 */
export async function runRootMigrate(opts: RootMigrateOptions = {}): Promise<number> {
  try {
    const workspace = resolveWorkspaceRoot(opts.workspace);
    const tomlPath = path.join(workspace, "config.toml");
    let defaultModel: string | undefined;
    try {
      const raw = await fsp.readFile(tomlPath, "utf-8");
      const parsed: any = parseToml(raw);
      if (typeof parsed?.defaultModel === "string") defaultModel = parsed.defaultModel;
    } catch {
      console.error(`mathran root migrate: no readable config.toml at ${tomlPath}`);
      return 1;
    }
    if (!defaultModel) {
      console.log("mathran root migrate: nothing to migrate (config.toml has no defaultModel).");
      return 0;
    }

    const settingsPath = path.join(workspace, MATHRAN_DIR, SETTINGS_FILE);
    let settings: Record<string, any> = { schemaVersion: SETTINGS_SCHEMA_VERSION };
    try {
      settings = JSON.parse(await fsp.readFile(settingsPath, "utf-8"));
    } catch {
      // start fresh
    }
    settings.modelPreference = {
      ...(settings.modelPreference ?? {}),
      default: defaultModel,
    };

    if (opts.dryRun) {
      console.log(`mathran root migrate (dry-run): would set modelPreference.default = ${defaultModel}`);
      console.log(`  target: ${settingsPath}`);
      return 0;
    }

    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    console.log(`mathran root migrate: set modelPreference.default = ${defaultModel}`);
    console.log(`  ${settingsPath}`);
    return 0;
  } catch (err: any) {
    console.error(`mathran root migrate: ${err?.message ?? err}`);
    return 1;
  }
}
