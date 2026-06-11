/**
 * `mathran doctor` — environment health check.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function checkEnvVar(varName: string): Check {
  const val = process.env[varName];
  return {
    name: varName,
    pass: !!val && val.length > 0,
    detail: val ? `set (${val.length} chars)` : "not set",
  };
}

function checkCommand(cmd: string, args: string[] = ["--version"]): Check {
  try {
    const out = execSync(`${cmd} ${args.join(" ")}`, { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 })
      .toString()
      .trim()
      .split("\n")[0];
    return { name: cmd, pass: true, detail: out };
  } catch (err: any) {
    return { name: cmd, pass: false, detail: err?.message ?? "command failed" };
  }
}

function checkCopilotToken(): Check {
  const candidates = [
    path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"), "credentials", "github-copilot.token.json"),
  ];
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf-8"));
      const expiresAt = typeof j.expiresAt === "number" ? j.expiresAt : 0;
      const minutesLeft = Math.max(0, Math.floor((expiresAt - Date.now()) / 60000));
      const usable = j.integrationId === "vscode-chat" && expiresAt - Date.now() > 5 * 60_000;
      return {
        name: "copilot session token",
        pass: usable,
        detail: usable
          ? `${path.basename(p)} (${minutesLeft}m left, integration=${j.integrationId})`
          : `${path.basename(p)} stale or wrong integration (need fresh login)`,
      };
    } catch {
      continue;
    }
  }
  // Fallback: check OAuth config exists
  const oauth = path.join(os.homedir(), ".copilot", "config.json");
  try {
    fs.statSync(oauth);
    return {
      name: "copilot session token",
      pass: false,
      detail: `no cached session token; OAuth config present at ~/.copilot/config.json — first call will exchange one`,
    };
  } catch {
    return {
      name: "copilot session token",
      pass: false,
      detail: "no session token cache and no ~/.copilot/config.json; run `copilot` to log in",
    };
  }
}

export async function runDoctor(): Promise<number> {
  console.log("mathran doctor — environment health check");
  console.log("");

  const sections: Array<{ heading: string; checks: Check[] }> = [
    {
      heading: "LLM providers (need at least one)",
      checks: [
        checkCopilotToken(),
        checkEnvVar("AZURE_OPENAI_API_KEY"),
        checkEnvVar("AZURE_OPENAI_ENDPOINT"),
        checkEnvVar("OPENAI_API_KEY"),
        checkEnvVar("ANTHROPIC_API_KEY"),
        checkEnvVar("COPILOT_TOKEN"),
      ],
    },
    {
      heading: "Lean toolchain",
      checks: [
        checkCommand("elan"),
        checkCommand("lake"),
        checkCommand("lean"),
      ],
    },
    {
      heading: "Node runtime",
      checks: [
        checkCommand("node"),
        checkCommand("npm"),
      ],
    },
  ];

  let allPass = true;
  for (const sec of sections) {
    console.log(`── ${sec.heading}`);
    for (const c of sec.checks) {
      const sym = c.pass ? "✓" : "✗";
      console.log(`  ${sym}  ${c.name.padEnd(28)} ${c.detail}`);
      if (!c.pass) allPass = false;
    }
    console.log("");
  }

  // LLM section pass = at least one provider available
  const llmChecks = sections[0].checks;
  const llmReady = llmChecks.some((c) => c.pass);
  if (!llmReady) {
    console.error("✗ No LLM provider configured. Either:");
    console.error("    - Log into GitHub Copilot (use the `copilot` CLI), or");
    console.error("    - Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or");
    console.error("    - Set OPENAI_API_KEY");
    return 1;
  }

  return allPass ? 0 : 1;
}
