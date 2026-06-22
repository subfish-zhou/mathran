/**
 * `mathran config` — inspect and edit Mathran's `config.toml` from the CLI.
 *
 * Avoids the need to hand-edit TOML for everyday changes (default model,
 * provider keys / models / endpoints). The same merge semantics as
 * `PUT /api/providers` apply: only fields you pass are written, blanks
 * never wipe existing values.
 *
 * Sub-commands wired in `src/cli/index.ts`:
 *
 *   mathran config path                          Print the resolved config.toml path
 *   mathran config list [--json]                 Print a redacted summary of all providers
 *   mathran config get <key> [--json]            Read a single value (see KEY syntax)
 *   mathran config set <key> <value>             Set a single value
 *   mathran config unset <key>                   Remove a key (provider entry or top-level)
 *
 * KEY syntax:
 *   defaultModel                                 Top-level default model id
 *   providers.<name>.<field>                     Per-provider field
 *
 * Supported provider fields: kind, apiKey, baseUrl, endpoint, deployment,
 * apiVersion, defaultModel. \`kind\` must be one of: openai, anthropic, azure,
 * copilot, ollama (matches src/core/config.ts).
 *
 * Secrets: \`mathran config get providers.<n>.apiKey\` returns "[redacted]"
 * (or "" if unset). \`mathran config list\` also redacts. Inspect raw secrets
 * by opening config.toml directly.
 */

import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { DEFAULT_CONFIG_PATH } from "../../core/config.js";
import { loadLayeredSettings } from "../../core/config/layered-settings.js";

const VALID_KINDS = new Set(["openai", "anthropic", "azure", "copilot", "ollama"]);
const PROVIDER_FIELDS = new Set([
  "kind",
  "apiKey",
  "baseUrl",
  "endpoint",
  "deployment",
  "apiVersion",
  "defaultModel",
]);
const SECRET_FIELDS = new Set(["apiKey"]);

interface ConfigCliOptions {
  workspace?: string;
}

function resolveConfigPath(opts: ConfigCliOptions): string {
  // Prefer --workspace, then $MATHRAN_WORKSPACE, then the default home location.
  const ws = opts.workspace ?? process.env.MATHRAN_WORKSPACE;
  if (ws) return path.resolve(ws, "config.toml");
  return DEFAULT_CONFIG_PATH;
}

async function readConfigDoc(cfgPath: string): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(cfgPath, "utf-8");
    const doc = parseToml(raw);
    if (!doc || typeof doc !== "object") return {};
    return doc as Record<string, any>;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function writeConfigDoc(cfgPath: string, doc: Record<string, any>): Promise<void> {
  await fs.mkdir(path.dirname(cfgPath), { recursive: true });
  await fs.writeFile(cfgPath, stringifyToml(doc) + "\n", "utf-8");
}

/**
 * Path-like dotted key into a TOML doc. Returns:
 *   { kind: "top", field: "defaultModel" }
 *   { kind: "provider", name: "openai", field: "apiKey" }
 *
 * Throws on anything else.
 */
function parseKey(key: string): { kind: "top"; field: string } | { kind: "provider"; name: string; field: string } {
  if (key === "defaultModel") return { kind: "top", field: "defaultModel" };
  const parts = key.split(".");
  if (parts.length === 3 && parts[0] === "providers") {
    const [, name, field] = parts;
    if (!name) throw new Error(`config: missing provider name in key "${key}"`);
    if (!PROVIDER_FIELDS.has(field)) {
      throw new Error(
        `config: unknown provider field "${field}" (allowed: ${[...PROVIDER_FIELDS].join(", ")})`,
      );
    }
    return { kind: "provider", name, field };
  }
  throw new Error(
    `config: unsupported key "${key}". Use "defaultModel" or "providers.<name>.<field>".`,
  );
}

function redactProvider(p: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(p)) {
    out[k] = SECRET_FIELDS.has(k) ? "[redacted]" : v;
  }
  return out;
}

export async function runConfigPath(opts: ConfigCliOptions): Promise<number> {
  const cfgPath = resolveConfigPath(opts);
  process.stdout.write(cfgPath + "\n");
  return 0;
}

export async function runConfigList(opts: ConfigCliOptions & { json?: boolean }): Promise<number> {
  const cfgPath = resolveConfigPath(opts);
  const doc = await readConfigDoc(cfgPath);
  const providers = (doc.providers && typeof doc.providers === "object" ? doc.providers : {}) as Record<string, any>;
  const summary: Record<string, any> = {
    configPath: cfgPath,
    exists: fssync.existsSync(cfgPath),
    defaultModel: typeof doc.defaultModel === "string" ? doc.defaultModel : null,
    providers: {} as Record<string, any>,
  };
  for (const [name, raw] of Object.entries(providers)) {
    summary.providers[name] = redactProvider(raw && typeof raw === "object" ? raw : {});
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`config: ${cfgPath}${summary.exists ? "" : " (does not exist)"}\n`);
  process.stdout.write(`defaultModel: ${summary.defaultModel ?? "(unset)"}\n`);
  process.stdout.write(`providers:\n`);
  const keys = Object.keys(summary.providers);
  if (keys.length === 0) {
    process.stdout.write(`  (none)\n`);
  } else {
    for (const name of keys) {
      const p = summary.providers[name] as Record<string, any>;
      process.stdout.write(`  ${name} [${p.kind ?? "?"}]\n`);
      for (const [k, v] of Object.entries(p)) {
        if (k === "kind") continue;
        process.stdout.write(`    ${k} = ${v}\n`);
      }
    }
  }
  return 0;
}

export async function runConfigGet(
  key: string,
  opts: ConfigCliOptions & { json?: boolean },
): Promise<number> {
  const cfgPath = resolveConfigPath(opts);
  const doc = await readConfigDoc(cfgPath);
  let parsed;
  try {
    parsed = parseKey(key);
  } catch (err: any) {
    process.stderr.write(`mathran config: ${err.message}\n`);
    return 2;
  }
  let value: unknown;
  if (parsed.kind === "top") {
    value = (doc as any)[parsed.field];
  } else {
    const provider = (doc.providers && (doc.providers as any)[parsed.name]) ?? null;
    value = provider ? (SECRET_FIELDS.has(parsed.field) && provider[parsed.field] ? "[redacted]" : provider[parsed.field]) : undefined;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(value ?? null) + "\n");
    return 0;
  }
  if (value === undefined || value === null) {
    process.stderr.write(`(unset)\n`);
    return 1;
  }
  process.stdout.write(String(value) + "\n");
  return 0;
}

export async function runConfigSet(key: string, value: string, opts: ConfigCliOptions): Promise<number> {
  const cfgPath = resolveConfigPath(opts);
  const doc = await readConfigDoc(cfgPath);
  let parsed;
  try {
    parsed = parseKey(key);
  } catch (err: any) {
    process.stderr.write(`mathran config: ${err.message}\n`);
    return 2;
  }
  if (parsed.kind === "top") {
    (doc as any)[parsed.field] = value;
  } else {
    if (!doc.providers || typeof doc.providers !== "object") doc.providers = {};
    const providers = doc.providers as Record<string, any>;
    if (!providers[parsed.name] || typeof providers[parsed.name] !== "object") {
      providers[parsed.name] = {};
    }
    if (parsed.field === "kind" && !VALID_KINDS.has(value)) {
      process.stderr.write(
        `mathran config: invalid provider kind "${value}" (expected one of: ${[...VALID_KINDS].join(", ")})\n`,
      );
      return 2;
    }
    providers[parsed.name][parsed.field] = value;
  }
  await writeConfigDoc(cfgPath, doc);
  process.stdout.write(`set ${key}\n`);
  return 0;
}

export async function runConfigUnset(key: string, opts: ConfigCliOptions): Promise<number> {
  const cfgPath = resolveConfigPath(opts);
  const doc = await readConfigDoc(cfgPath);
  let parsed;
  try {
    parsed = parseKey(key);
  } catch (err: any) {
    process.stderr.write(`mathran config: ${err.message}\n`);
    return 2;
  }
  let removed = false;
  if (parsed.kind === "top") {
    if (Object.prototype.hasOwnProperty.call(doc, parsed.field)) {
      delete (doc as any)[parsed.field];
      removed = true;
    }
  } else {
    const providers = (doc.providers && typeof doc.providers === "object" ? doc.providers : {}) as Record<string, any>;
    const p = providers[parsed.name];
    if (p && Object.prototype.hasOwnProperty.call(p, parsed.field)) {
      delete p[parsed.field];
      // If the provider table is now empty, drop the table itself so the
      // user can re-add it cleanly.
      if (Object.keys(p).length === 0) {
        delete providers[parsed.name];
      }
      removed = true;
    }
  }
  if (!removed) {
    process.stderr.write(`mathran config: key "${key}" was not set\n`);
    return 1;
  }
  await writeConfigDoc(cfgPath, doc);
  process.stdout.write(`unset ${key}\n`);
  return 0;
}

/**
 * `mathran config settings` — print the merged layered `.mathran/settings.json`
 * (PROJECT > WORKSPACE > USER). This is the new layered model; the TOML-based
 * `config get/set/...` commands above stay for provider/defaultModel config.
 */
export async function runConfigSettings(
  opts: ConfigCliOptions & { project?: string; json?: boolean },
): Promise<number> {
  const workspace = opts.workspace ?? process.env.MATHRAN_WORKSPACE;
  const ws = workspace ? path.resolve(workspace) : path.dirname(DEFAULT_CONFIG_PATH);
  const result = loadLayeredSettings({
    workspace: ws,
    ...(opts.project ? { projectSlug: opts.project } : {}),
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`layered settings (PROJECT > WORKSPACE > USER), workspace: ${ws}\n`);
  for (const layer of result.layers) {
    process.stdout.write(`  [${layer.layer}] ${layer.path ?? "(absent)"}\n`);
  }
  process.stdout.write("\n" + JSON.stringify(result.settings, null, 2) + "\n");
  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
  return 0;
}
