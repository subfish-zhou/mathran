/**
 * Skill block renderer + "How to use a skill" progressive-disclosure prompt.
 *
 * Ported (verbatim translation) from codex `core-skills/src/render.rs`. The
 * "How to use a skill" section is the core contribution of this commit — it
 * tells the main agent that it MUST open SKILL.md itself, never delegating
 * the read to a sub-agent.
 *
 * Ported: 2026-06-10 (commit 6a/6 of mathub-ai-codex-upgrade).
 */

import {
  computeSkillCharBudget,
  truncateSkillsToBudget,
  SKILL_TRUNCATION_WARNING_EN,
  SKILL_TRUNCATION_WARNING_ZH,
  type SkillMetaForBudget,
} from "./budget";

export type SkillRenderLocale = "en" | "zh";

export interface SkillRenderInput {
  skills: SkillMetaForBudget[];
  contextWindowTokens: number;
  locale?: SkillRenderLocale;
}

export interface SkillRenderOutput {
  /** Final markdown block ready to splice into the system prompt. */
  prompt: string;
  /** True iff descriptions were truncated. */
  truncated: boolean;
  /** Char count of the rendered list portion (excludes how-to section). */
  listChars: number;
  /** Number of skills kept after truncation. */
  keptCount: number;
}

const HOW_TO_USE_EN = `### How to use a skill

- Discovery: The list above is the skills available in this session.
- Trigger rules: If the user names a skill OR the task clearly matches a skill's description, you MUST use that skill for that turn.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, the main agent MUST open and read its SKILL.md completely before taking task actions. Do not delegate reading SKILL.md to a sub-agent — sub-agents may execute the task only after the main agent has read the instructions.
  2) When SKILL.md references relative paths (e.g., scripts/foo.py), resolve them relative to the skill directory first.
  3) Apply the skill's procedure as written. Do not paraphrase, summarize, skip steps, or invent shortcuts — if a step is unclear, prefer asking the user over guessing.
- Safety and fallback: If a skill can't be applied cleanly, state the issue, pick the next-best approach, and continue.`;

const HOW_TO_USE_ZH = `### 如何使用 skill

- 发现：上面列出的就是本 session 可用的 skill。
- 触发规则：当用户提到某个 skill 名字、或者任务明显匹配某个 skill 的描述时，**必须**在该 turn 使用对应 skill。
- 缺失/受阻：如果用户提到的 skill 不在列表里，或对应路径无法读取，简短说明并继续使用最佳替代方案。
- 如何使用 skill（渐进披露）：
  1) 决定使用某个 skill 后，**main agent 必须**先打开并完整阅读它的 SKILL.md，再开始任务行动。**不要把读 SKILL.md 委派给 sub-agent**——sub-agent 只有在 main agent 已读完指令之后才能执行任务。
  2) 当 SKILL.md 引用相对路径（例如 scripts/foo.py）时，先把它解析为相对 skill 目录的路径。
  3) 按照 skill 写的程序原样执行。不要意译、不要省略步骤、不要发明捷径——某一步不清楚时，宁可询问用户也不要猜测。
- 安全与回退：如果某个 skill 无法干净地应用，说明问题、选择次优方案、继续工作。`;

const HEADER_EN = `### Skills

A skill is a set of local instructions to follow that is stored in a SKILL.md file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions.`;

const HEADER_ZH = `### Skills

skill 是存储在 SKILL.md 文件中的一组本地指令。下面是可用 skill 列表。每一项包含名称、描述、文件路径，你可以打开源文件以获取完整指令。`;

/**
 * Render the full skills block (header + list + how-to-use + optional warning).
 *
 * The block is self-contained — splice it into the system prompt wherever the
 * old skill section sat. Returns metadata so callers can log/debug.
 */
export function renderSkillsBlock(input: SkillRenderInput): SkillRenderOutput {
  const locale: SkillRenderLocale = input.locale ?? "en";
  const budget = computeSkillCharBudget(input.contextWindowTokens);
  const { kept, truncated, finalChars } = truncateSkillsToBudget(
    input.skills,
    budget,
  );

  const header = locale === "zh" ? HEADER_ZH : HEADER_EN;
  const howTo = locale === "zh" ? HOW_TO_USE_ZH : HOW_TO_USE_EN;
  const warning =
    locale === "zh" ? SKILL_TRUNCATION_WARNING_ZH : SKILL_TRUNCATION_WARNING_EN;

  const lines: string[] = [];
  for (const s of kept) {
    if (s.descriptionDropped) {
      lines.push(`- **${s.name}** (path: ${s.path})`);
    } else {
      // Single-line description for compactness; collapse internal newlines.
      const desc = s.description.replace(/\s*\n\s*/g, " ").trim();
      lines.push(`- **${s.name}** — ${desc} (path: ${s.path})`);
    }
  }

  if (kept.length === 0) {
    lines.push(
      locale === "zh"
        ? "_（当前没有可用 skill。）_"
        : "_(No skills currently available.)_",
    );
  }

  const parts: string[] = [header, "", lines.join("\n")];
  if (truncated) {
    parts.push("", `> ${warning}`);
  }
  parts.push("", howTo);

  return {
    prompt: parts.join("\n"),
    truncated,
    listChars: finalChars,
    keptCount: kept.length,
  };
}
