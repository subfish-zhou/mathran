/**
 * `resolveMathranRoot` + 防智障 (idiot-proof) root resolver for the layered
 * `.mathran/` config model.
 *
 * This module owns the rules for turning a user-supplied path into a safe,
 * validated `.mathran/` root:
 *
 *   1. `~` expansion + basename auto-append (`/proj` → `/proj/.mathran`).
 *   2. A ban-list of dangerous filesystem roots (`/`, `/etc`, `C:\`, …).
 *   3. Path-legality checks (absolute, no `node_modules/` / `.git/` segment).
 *   4. Parent-dir existence + writability (for `init`).
 *   5. Existing-dir guard: an existing target must already look like a mathran
 *      root (`.signature` or `settings.json`) — we never adopt a random dir.
 *   6. `.signature` creation + verification.
 *
 * It does NOT replace `resolveWorkspaceRoot` (old CLI commands keep working).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import {
  MathranRootSignatureSchema,
  SETTINGS_SCHEMA_VERSION,
  type MathranRootSignature,
} from "./schemas.js";

/** The basename of a mathran root directory. */
export const MATHRAN_DIR = ".mathran";

/** Files whose presence proves a directory is a mathran root. */
export const SIGNATURE_FILE = ".signature";
export const SETTINGS_FILE = "settings.json";

/**
 * Dangerous roots we refuse to turn into a mathran root (exact match on the
 * *project* directory, i.e. the dir that would contain `.mathran/`). Subdirs
 * of these (e.g. `/home/alice`, `/tmp/scratch`) are fine.
 */
const DANGEROUS_ROOTS: ReadonlySet<string> = new Set([
  "/",
  "/home",
  "/root",
  "/etc",
  "/usr",
  "/var",
  "/bin",
  "/sbin",
  "/tmp",
  // Windows partition / well-known roots.
  "C:\\",
  "C:\\Users",
  "D:\\",
  "E:\\",
]);

export interface ResolveMathranRootOpts {
  /** Override `$HOME` for `~` expansion (tests). */
  home?: string;
}

export interface ResolvedMathranRoot {
  /** Absolute path to the `.mathran/` directory. */
  rootPath: string;
  /** Absolute path to the directory that *contains* `.mathran/`. */
  projectDir: string;
}

/** Expand a leading `~` / `~/...` to the home directory. */
export function expandHome(input: string, home?: string): string {
  const h = home ?? os.homedir();
  if (input === "~") return h;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(h, input.slice(2));
  }
  return input;
}

/** Normalize a path for ban-list comparison (strip trailing separators). */
function normalizeForBan(p: string): string {
  // Keep a bare "/" or drive root intact; otherwise drop trailing slashes.
  if (p === "/" || /^[A-Za-z]:\\$/.test(p)) return p;
  return p.replace(/[/\\]+$/u, "");
}

/** True when `projectDir` is one of the banned filesystem roots. */
export function isDangerousRoot(projectDir: string): boolean {
  return DANGEROUS_ROOTS.has(normalizeForBan(projectDir));
}

/** True when a path contains a `node_modules` or `.git` path segment. */
export function hasForbiddenSegment(p: string): boolean {
  const segments = p.split(/[/\\]+/u).filter((s) => s.length > 0);
  return segments.includes("node_modules") || segments.includes(".git");
}

/**
 * Resolve a user-supplied path into a `.mathran/` root path + project dir,
 * applying `~` expansion, basename auto-append and all *pure* legality checks
 * (absolute-ness, ban-list, forbidden segments).
 *
 * Throws on any violation. Does NOT touch the filesystem — see
 * {@link initMathranRoot} / {@link validateMathranRoot} for the I/O steps.
 */
export function resolveMathranRoot(
  input: string,
  opts: ResolveMathranRootOpts = {},
): ResolvedMathranRoot {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("mathran root: path must be a non-empty string");
  }

  const expanded = expandHome(input.trim(), opts.home);

  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `mathran root: path must be absolute (got "${input}"). ` +
        `Use an absolute path or a "~/..."-prefixed one.`,
    );
  }

  const resolved = path.resolve(expanded);

  // basename auto-append: ".../.mathran" is kept as-is; anything else gets
  // ".mathran" appended.
  let rootPath: string;
  let projectDir: string;
  if (path.basename(resolved) === MATHRAN_DIR) {
    rootPath = resolved;
    projectDir = path.dirname(resolved);
  } else {
    projectDir = resolved;
    rootPath = path.join(resolved, MATHRAN_DIR);
  }

  if (isDangerousRoot(projectDir)) {
    throw new Error(
      `mathran root: refusing to create a root under "${projectDir}" — ` +
        `it is a protected system / partition root.`,
    );
  }

  if (hasForbiddenSegment(rootPath)) {
    throw new Error(
      `mathran root: path must not contain a "node_modules" or ".git" segment ` +
        `(got "${rootPath}").`,
    );
  }

  return { rootPath, projectDir };
}

/** Build a fresh signature object for a brand-new root. */
export function buildSignature(version: string): MathranRootSignature {
  return {
    version,
    createdAt: new Date().toISOString(),
    nonce: randomBytes(16).toString("hex"),
  };
}

/** Default `.gitignore` body for a freshly-minted root. */
export function defaultGitignore(): string {
  return [
    "# mathran root — ignore local overrides + runtime state",
    "*.local.*",
    "logs/",
    "uploads/",
    "tool-output/",
    "global-chat/",
    "goals/",
    "plans/",
    "subagents/",
    "",
  ].join("\n");
}

function defaultSettings(): string {
  return JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION }, null, 2) + "\n";
}

/** True when `dir` already looks like a mathran root. */
export function looksLikeMathranRoot(dir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dir, SIGNATURE_FILE)) ||
      fs.existsSync(path.join(dir, SETTINGS_FILE))
    );
  } catch {
    return false;
  }
}

export interface InitMathranRootResult extends ResolvedMathranRoot {
  /** True when the root directory was newly created by this call. */
  created: boolean;
  signature: MathranRootSignature;
}

export interface InitMathranRootOpts extends ResolveMathranRootOpts {
  /** mathran version stamped into the signature. */
  version: string;
}

/**
 * Create (or adopt) a `.mathran/` root. Performs the filesystem-side防智障
 * checks that {@link resolveMathranRoot} cannot:
 *
 *   - parent dir must exist + be writable;
 *   - an existing target must already look like a mathran root;
 *   - a new target gets `.signature`, `.gitignore` and an empty `settings.json`.
 */
export function initMathranRoot(
  input: string,
  opts: InitMathranRootOpts,
): InitMathranRootResult {
  const { rootPath, projectDir } = resolveMathranRoot(input, opts);

  // Parent (project dir) must exist and be writable.
  try {
    fs.accessSync(projectDir, fs.constants.W_OK);
  } catch {
    throw new Error(
      `mathran root: parent directory "${projectDir}" does not exist or is not ` +
        `writable. Create it first, then re-run.`,
    );
  }

  const exists = fs.existsSync(rootPath);
  if (exists) {
    const stat = fs.statSync(rootPath);
    if (!stat.isDirectory()) {
      throw new Error(`mathran root: "${rootPath}" exists but is not a directory.`);
    }
    if (!looksLikeMathranRoot(rootPath)) {
      throw new Error(
        `mathran root: "${rootPath}" already exists but is missing a ` +
          `.signature / settings.json — refusing to overwrite an unrelated directory.`,
      );
    }
    // Adopt existing root: re-read (and validate) its signature if present.
    const sig = readSignature(rootPath);
    return {
      rootPath,
      projectDir,
      created: false,
      signature: sig ?? buildSignature(opts.version),
    };
  }

  // Fresh root.
  fs.mkdirSync(rootPath, { recursive: true });
  const signature = buildSignature(opts.version);
  fs.writeFileSync(
    path.join(rootPath, SIGNATURE_FILE),
    JSON.stringify(signature, null, 2) + "\n",
    "utf-8",
  );
  fs.writeFileSync(path.join(rootPath, ".gitignore"), defaultGitignore(), "utf-8");
  fs.writeFileSync(path.join(rootPath, SETTINGS_FILE), defaultSettings(), "utf-8");
  // Layer skeleton.
  for (const sub of ["skills", "commands", "hooks"]) {
    fs.mkdirSync(path.join(rootPath, sub), { recursive: true });
  }

  return { rootPath, projectDir, created: true, signature };
}

/**
 * Read + validate the `.signature` of an existing root. Returns the parsed
 * signature, or `null` when the file is absent. Throws when the file exists
 * but is malformed (验签失败) so callers can refuse to continue.
 */
export function readSignature(rootPath: string): MathranRootSignature | null {
  const sigPath = path.join(rootPath, SIGNATURE_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(sigPath, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`mathran root: failed to read ${sigPath}: ${err?.message ?? err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(
      `mathran root: ${sigPath} is not valid JSON: ${err?.message ?? err}`,
    );
  }
  const result = MathranRootSignatureSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `mathran root: ${sigPath} has an invalid signature format — refusing to continue.`,
    );
  }
  return result.data;
}

export interface ValidateMathranRootResult extends ResolvedMathranRoot {
  signature: MathranRootSignature;
}

/**
 * Validate an existing root: the directory must exist, look like a mathran
 * root, and carry a well-formed `.signature`. Throws otherwise. Use this at
 * startup before trusting a root's contents.
 */
export function validateMathranRoot(
  input: string,
  opts: ResolveMathranRootOpts = {},
): ValidateMathranRootResult {
  const { rootPath, projectDir } = resolveMathranRoot(input, opts);
  if (!fs.existsSync(rootPath)) {
    throw new Error(`mathran root: "${rootPath}" does not exist.`);
  }
  if (!fs.statSync(rootPath).isDirectory()) {
    throw new Error(`mathran root: "${rootPath}" is not a directory.`);
  }
  if (!looksLikeMathranRoot(rootPath)) {
    throw new Error(
      `mathran root: "${rootPath}" is missing a .signature / settings.json.`,
    );
  }
  const sig = readSignature(rootPath);
  if (!sig) {
    throw new Error(`mathran root: "${rootPath}" is missing its .signature.`);
  }
  return { rootPath, projectDir, signature: sig };
}
