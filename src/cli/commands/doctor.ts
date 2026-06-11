/**
 * `mathran doctor` — environment health check.
 */

import { execSync } from "node:child_process";

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

export async function runDoctor(): Promise<number> {
  console.log("mathran doctor — environment health check");
  console.log("");

  const sections: Array<{ heading: string; checks: Check[] }> = [
    {
      heading: "LLM providers (need at least one)",
      checks: [
        checkEnvVar("AZURE_OPENAI_API_KEY"),
        checkEnvVar("AZURE_OPENAI_ENDPOINT"),
        checkEnvVar("OPENAI_API_KEY"),
        checkEnvVar("ANTHROPIC_API_KEY"),
      ],
    },
    {
      heading: "Routing config (optional)",
      checks: [
        checkEnvVar("LLM_PRIMARY_MODEL"),
        checkEnvVar("LLM_FALLBACK_MODEL"),
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

  // LLM section pass = at least one provider key set
  const llmChecks = sections[0].checks;
  const llmReady = llmChecks.some((c) => c.pass);
  if (!llmReady) {
    console.error("✗ No LLM provider configured. Set at least one of:");
    console.error("    AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT");
    console.error("    OPENAI_API_KEY");
    console.error("    ANTHROPIC_API_KEY");
    return 1;
  }

  return allPass ? 0 : 1;
}
