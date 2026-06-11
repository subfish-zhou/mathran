/**
 * `mathran prove` — agent-driven proof of a single .lean file.
 *
 * v0.1-alpha implementation: a minimal "fix-the-lean-file" loop.
 *
 *   load source
 *   ─→ ask LLM to attempt a proof (system prompt: lean-4 prover)
 *   ─→ extract lean code block from response
 *   ─→ write to candidate file
 *   ─→ LeanProvider.check(candidate)
 *   ─→ success?  yes → write artifact + return 0
 *               no  → format errors, append to chat history, loop
 *
 * This deliberately bypasses the full Mathub-era runAgentLoop (which depends
 * on ambient stubs and would throw at runtime). The full agent loop with
 * tool calls / scratchpad / spawn-awaiter lights up in a later milestone
 * once the Storage interface is fully wired through.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import OpenAI from "openai";
import {
  LocalLeanProvider,
  InMemoryStorage,
  LocalFsArtifactSink,
} from "../../providers/index.js";

export interface RunProveOptions {
  leanFile: string;
  outputDir: string;
  model: string;
  maxIterations: number;
}

interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT = `You are a Lean 4 theorem prover assistant.

You will be given a Lean 4 source file. Your job is to PROVE every theorem,
lemma, or definition that ends with \`sorry\` or has an incomplete proof.

Rules:
- Output a single complete Lean 4 source file in a fenced \`\`\`lean ... \`\`\` block.
- Preserve all existing imports, definitions, and theorem statements EXACTLY.
- Replace every \`sorry\` with a real tactic-mode proof (\`by tac1; tac2; ...\`)
  or term-mode proof.
- Prefer short, idiomatic tactics: \`rfl\`, \`simp\`, \`omega\`, \`decide\`,
  \`linarith\`, \`exact?\`, \`norm_num\`, \`ring\`, induction, \`constructor\`.
- Do NOT add new theorems unless they are obvious lemmas needed for the proof.
- If the lean checker reports errors, READ them carefully and adjust.

After your code block you may add a short prose explanation, but the lean code
block is what matters.
`;

function buildLLMClient(model: string): { client: OpenAI; modelId: string } {
  // Routing convention matches existing src/lib/agent/llm-router.ts:
  //   "azure/<id>"     → Azure OpenAI deployment
  //   "openai/<id>"    → OpenAI proper
  //   "anthropic/<id>" → Anthropic (TODO; not yet wired in v0.1)
  //   bare             → fallback OPENAI_API_KEY
  if (model.startsWith("azure/")) {
    const modelId = model.slice("azure/".length);
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2025-03-01-preview";
    if (!endpoint || !apiKey) {
      throw new Error(
        "azure/* model requires AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY",
      );
    }
    const client = new OpenAI({
      apiKey,
      baseURL: `${endpoint.replace(/\/+$/, "")}/openai/deployments/${modelId}`,
      defaultQuery: { "api-version": apiVersion },
      defaultHeaders: { "api-key": apiKey },
    });
    return { client, modelId };
  }

  if (model.startsWith("anthropic/")) {
    throw new Error(
      "anthropic/* not yet wired in v0.1-alpha; use azure/* or openai/* for now",
    );
  }

  const modelId = model.startsWith("openai/") ? model.slice("openai/".length) : model;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("openai/* model requires OPENAI_API_KEY");
  }
  return { client: new OpenAI({ apiKey }), modelId };
}

function extractLeanBlock(text: string, fallback: string): { code: string; found: boolean } {
  const fence = /```(?:lean|lean4)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fence) return { code: fence[1].trim() + "\n", found: true };
  // Fallback: if the message has no fence but starts with import/theorem/def,
  // accept the whole message as code.
  if (/^\s*(import|theorem|lemma|def|example)\b/m.test(text)) {
    return { code: text.trim() + "\n", found: true };
  }
  return { code: fallback, found: false };
}

function formatErrors(messages: Array<{ severity: string; message: string; line?: number; column?: number }>): string {
  return messages
    .map((m) => {
      const loc = m.line !== undefined ? `:${m.line}${m.column !== undefined ? `:${m.column}` : ""}` : "";
      return `[${m.severity}${loc}] ${m.message}`;
    })
    .join("\n");
}

export async function runProve(opts: RunProveOptions): Promise<number> {
  const startedAt = Date.now();
  console.log(`mathran prove — v0.1-alpha (minimal loop)`);
  console.log(`  lean file:       ${opts.leanFile}`);
  console.log(`  output dir:      ${opts.outputDir}`);
  console.log(`  model:           ${opts.model}`);
  console.log(`  max iterations:  ${opts.maxIterations}`);
  console.log("");

  // ─── Bootstrap providers ─────────────────────────────────────────────────
  const lean = new LocalLeanProvider();
  const storage = new InMemoryStorage();
  const sink = new LocalFsArtifactSink(opts.outputDir);

  await fs.mkdir(opts.outputDir, { recursive: true });

  const leanInfo = await lean.describe();
  console.log(`[lean] ${leanInfo.name} ${leanInfo.version ?? ""}`);
  console.log(`[storage] ${(await storage.describe()).backend}`);
  console.log(`[sink] ${(await sink.describe()).name}`);
  console.log("");

  // ─── LLM client ──────────────────────────────────────────────────────────
  let llm: ReturnType<typeof buildLLMClient>;
  try {
    llm = buildLLMClient(opts.model);
  } catch (err: any) {
    console.error(`[mathran prove] ${err.message}`);
    return 3;
  }

  // ─── Load source ─────────────────────────────────────────────────────────
  const source = await fs.readFile(opts.leanFile, "utf-8");
  if (source.trim().length === 0) {
    console.error("mathran prove: source file is empty");
    return 2;
  }

  // ─── Initial baseline check ──────────────────────────────────────────────
  console.log("[check] running lean on baseline...");
  const baselineCheck = await lean.check({ filePath: opts.leanFile });
  if (baselineCheck.ok) {
    console.log(`[check] baseline ALREADY PROVED (no work needed) in ${baselineCheck.durationMs}ms`);
    return 0;
  }
  console.log(
    `[check] baseline has ${baselineCheck.messages.filter((m) => m.severity === "error").length} error(s) in ${baselineCheck.durationMs}ms`,
  );
  console.log("");

  // ─── Persistent state ────────────────────────────────────────────────────
  const candidateFile = path.join(opts.outputDir, "candidate.lean");
  const chat: ChatMsg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Here is the Lean 4 file. Please complete the proof.\n\nFilename: ${path.basename(opts.leanFile)}\n\n\`\`\`lean\n${source}\n\`\`\``,
    },
  ];

  const run = await storage.appendRun({
    scopeId: opts.leanFile,
    startedAt: new Date(startedAt).toISOString(),
    status: "running",
    payload: { model: opts.model, source },
  });

  let lastCandidate = source;
  let lastErrors = "";

  // ─── The fix-it loop ─────────────────────────────────────────────────────
  for (let iter = 1; iter <= opts.maxIterations; iter++) {
    console.log(`── iteration ${iter}/${opts.maxIterations} ──`);

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await llm.client.chat.completions.create({
        model: llm.modelId,
        messages: chat as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature: 0.2,
      });
    } catch (err: any) {
      console.error(`[llm] error: ${err?.message ?? err}`);
      await storage.updateRun(run.id, { status: "failed", payload: { error: String(err) } });
      return 4;
    }

    const reply = response.choices?.[0]?.message?.content ?? "";
    const tokensIn = response.usage?.prompt_tokens ?? 0;
    const tokensOut = response.usage?.completion_tokens ?? 0;
    console.log(`[llm] reply ${reply.length} chars (${tokensIn} in, ${tokensOut} out)`);

    chat.push({ role: "assistant", content: reply });

    const extracted = extractLeanBlock(reply, lastCandidate);
    if (!extracted.found) {
      console.warn("[llm] no lean code block found in reply — asking again");
      chat.push({
        role: "user",
        content:
          'Your reply did not contain a lean code block. Please reply with a single complete `lean fence containing the full source file.',
      });
      continue;
    }

    lastCandidate = extracted.code;
    await fs.writeFile(candidateFile, lastCandidate, "utf-8");

    console.log("[check] running lean...");
    const check = await lean.check({ filePath: candidateFile });
    console.log(
      `[check] ${check.ok ? "OK" : `${check.messages.filter((m) => m.severity === "error").length} error(s)`} in ${check.durationMs}ms`,
    );

    if (check.ok) {
      const finalPath = path.join(opts.outputDir, "proved.lean");
      await fs.writeFile(finalPath, lastCandidate, "utf-8");

      const totalMs = Date.now() - startedAt;
      const summary = [
        `# Proof of ${path.basename(opts.leanFile)}`,
        ``,
        `- model: \`${opts.model}\``,
        `- iterations: ${iter}/${opts.maxIterations}`,
        `- wall-clock: ${(totalMs / 1000).toFixed(1)}s`,
        `- lean: ${leanInfo.version ?? "unknown"}`,
        ``,
        `## Final proof`,
        ``,
        "```lean",
        lastCandidate.trimEnd(),
        "```",
      ].join("\n");

      await sink.createPage({
        title: `Proof: ${path.basename(opts.leanFile)}`,
        body: summary,
        authorId: "mathran",
        tags: ["mathran", "proof"],
        scopeId: opts.leanFile,
      });

      await storage.updateRun(run.id, {
        status: "completed",
        payload: { iterations: iter, totalMs, finalProof: lastCandidate },
      });

      console.log("");
      console.log(`✓ PROVED in ${iter} iteration(s), ${(totalMs / 1000).toFixed(1)}s`);
      console.log(`  artifacts: ${opts.outputDir}/`);
      return 0;
    }

    lastErrors = formatErrors(check.messages);
    chat.push({
      role: "user",
      content: `The Lean checker rejected your proof. Errors:\n\n\`\`\`\n${lastErrors}\n\`\`\`\n\nPlease fix and reply with the full corrected source in a single \`\`\`lean fence.`,
    });
  }

  // ─── Out of iterations ───────────────────────────────────────────────────
  const totalMs = Date.now() - startedAt;
  await storage.updateRun(run.id, {
    status: "failed",
    payload: { iterations: opts.maxIterations, totalMs, lastCandidate, lastErrors },
  });
  await sink.createPage({
    title: `FAILED: ${path.basename(opts.leanFile)}`,
    body: [
      `# Failed to prove ${path.basename(opts.leanFile)}`,
      ``,
      `- model: \`${opts.model}\``,
      `- iterations: ${opts.maxIterations} (exhausted)`,
      `- wall-clock: ${(totalMs / 1000).toFixed(1)}s`,
      ``,
      `## Last candidate`,
      "```lean",
      lastCandidate.trimEnd(),
      "```",
      ``,
      `## Last errors`,
      "```",
      lastErrors,
      "```",
    ].join("\n"),
    authorId: "mathran",
    tags: ["mathran", "proof-failed"],
    scopeId: opts.leanFile,
  });

  console.log("");
  console.error(
    `✗ FAILED to prove after ${opts.maxIterations} iteration(s), ${(totalMs / 1000).toFixed(1)}s`,
  );
  console.error(`  see: ${opts.outputDir}/pages/`);
  return 1;
}
