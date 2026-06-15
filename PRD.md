# Mathran PRD — 从 Mathub 提取出的本地数学家工作站

**版本**: v0.2-draft
**作者**: 芙莉莲（受子鱼之托起草）
**起草日期**: 2026-06-12（v0.1）｜**修订**: 2026-06-13（v0.2，按子鱼决策纠偏 + 补决策：去 prove 专用入口、CLI 改对话式、§3a 前端选型拍死）
**对应代码**: `~/mathran` (commit @ 2026-06-11), `~/Mathub` 基准 `3d20973`
**先行依据**:
- `~/.openclaw/workspace/_tasks/mathub-extract/dep-scan.md`（依赖扫描）
- `~/.openclaw/workspace/_tasks/mathub-decoupling-debt/`（6 spec 解耦冲刺，已全部 merge）
- `~/mathran/_tasks/v0.1-cut-list.md`（v0.1 砍除清单）
- `~/mathran/_tasks/sweep-{1,2,3}-*.md`（三轮砍除实施日志）

---

## ⚠️ v0.2 修订要点（子鱼 2026-06-13 拍板，先读这一节）

v0.1-draft 把 mathran 定位成"纯 CLI / 像 codex 一样 ARGV 进 artifact 出"。**这个定位是错的**，本次修订纠正三处根本偏差：

1. **人类主交互是浏览器 localhost 前端，不是 CLI。** 数学家大多不熟悉 CLI、甚至不编程。CLI 在 mathran 里**降级为"给其它 agent 调用的接口"**，人类用户走本地 Web UI。→ Web UI **从 Out-of-Scope 移进 In-Scope**（§2.1 / §3a）。

2. **project / program 管理用文件系统实现，不用数据库。** 我仍然要 Mathub 里 project/program 那样的管理体系，但本地安装不能背 Postgres/drizzle 那套重基础设施。改用**文件系统即数据库**（目录 = project，文件 = 元数据/wiki）。为此可舍弃部分功能，但 **`project init` 仍是核心，wiki 仍必须被创建**。→ §2.3 init-agent **保留**；§3b 文件管理体系。

3. **多 model provider 是一等需求。** Mathub 只跑在子鱼的 Azure OpenAI 上，没做多 provider。mathran 要像 OpenClaw / codex 一样支持各类 provider（OpenAI / Anthropic / Azure / Copilot / Ollama / OpenAI-compatible…）。→ 实现思路照搬 OpenClaw 或 codex 的 provider 层（§3c）。

4. **mathran 是独立 CLI/产品，不做 OpenClaw 插件。** 不能作为 OpenClaw plugin 的根本原因：mathran 的**文件管理体系和 UI 是自成一套独立体系的**，塞进 OpenClaw 会两边别扭。→ §9 决策 5，删除原 "mathran-as-openclaw-plugin" 未来通道。

§9 五个开放问题已全部拍板，见 §9。

---

## 0. TL;DR

**Mathran = Mathub 减去公共服务层、改用本地文件系统承载、带本地 Web 前端的单机数学家工作站。**

Mathub 是面向社区的开源数学协作平台（Forum + Wiki + Channels + Workspace + AI Agent + Lean 形式化），跑在服务端 Postgres + Next.js 上。Mathran 把其中 **prover 内核 + AI agent + Lean/Sage/LaTeX 沙箱 + project/wiki 工作区抽象** 这套"一个数学家自己解题用得着的东西"剥出来，重新打包成：

- **`npm i -g mathran` 装在自己笔记本上**，不需要 Postgres、不需要登录系统、不需要服务端运维；
- 人类用户通过 **`mathran serve` 起一个 localhost Web 前端** 操作（建 project、看 wiki、跟 AI 对话）；
- 其它 agent 通过 **CLI 对话接口（`mathran` / `mathran chat`）** 以自然语言驱动；
- 所有 project/program/wiki **以文件形式落在本地目录**，没有数据库；
- **BYO LLM**：支持多 provider，用户用自己的 API key。

> **一句话产品定位**: Mathub 的内核拆出来给你私人用 —— 浏览器 localhost 操作、文件系统当数据库、自带多 provider、BYO key、全本地。

---

## 1. 为什么要做 mathran

### 1.1 Mathub 的两副面孔

Mathub 长出来后实际上同时承担了两个角色：

| 角色 A：**社区平台** | 角色 B：**数学家私人工作站** |
|---|---|
| Forum 讨论 / Wiki 知识库 / Channels IM | AI Assistant 对话 + 个人 project/wiki（Lean/Sage/… 皆为工具）|
| 多租户 / 用户系统 / 权限 / 声望 | 单租户 / 本地 / 无登录 |
| 服务端 Next.js + Postgres + 多 worker | 本地进程 + **文件系统存储** + 轻量 localhost 前端 |
| 单一 Azure OpenAI 端点 | **多 provider，BYO key** |
| 开源给社区跑公共服务 | 装在数学家自己机器上 |

这两套**共用同一份 agent 内核（`src/lib/agent/*` + `src/server/agent-gateway/services/*`）**，但围绕它捆绑了非常多 Mathub-only 的胶水（Wiki sink、Notification、ActivityFeed、ForumStream…），且把存储硬绑死在 Postgres、把 LLM 硬绑死在单个 Azure 端点。

### 1.2 为什么不直接装一份 Mathub 就完了

子鱼明确表达：**数学家想要的是"我自己用的助手"，不是"一个社区平台 + 我恰好是唯一用户"。** 装一份 Mathub 来私用至少有四个反向负担：

1. **Postgres 依赖**：本地装 PG + 跑迁移 + drizzle-kit，对不编程的数学家门槛过高。mathran 改用**文件系统当存储**。
2. **重前端运维**：Mathub 要 build、要 nginx、要常驻服务。mathran 的前端是 `mathran serve` 一条命令起的本地轻量 Web UI，关掉就没了。
3. **Forum/Channels/声望系统** 完全用不到，但 type-check / build / 启动全要带着。
4. **登录鉴权**：本地单机没有"另一个用户"，但 Mathub 代码到处假设 `ctx.session.userId`，调用链经常拐到 NextAuth。
5. **单 provider**：Mathub 写死 Azure OpenAI，换个人想用自己的 Anthropic/Ollama key 没法接。

### 1.3 为什么不是把 mathran 做成 Mathub 的另一个分支

Fork 会立刻面临 **双仓库同步漂移** 问题。子鱼的真实诉求是 **代码物理上共享 prover 内核，只是把它切到一个 reusable package**，让 Mathub 主站和 mathran 都依赖它：

```
packages/prover-core/        ← 共享内核（新增，无 UI / 无存储后端假设）
  agent/                       ← 从 Mathub src/lib/agent 搬来
  agent-gateway/services/      ← 从 Mathub 同名目录搬来（仅 prover 部分）
  lib/{workspace,jobs,sandbox,observability,embedding,...}
  providers/                   ← Lean / LLM / Storage / ArtifactSink 接口（下面讲）

apps/mathub/                 ← Next.js + Forum + Wiki + Channels（现 Mathub 主站）
  实现 PostgresStorage + MathubWikiSink + 单 Azure provider

apps/mathran/                ← mathran 本体（即现 ~/mathran 仓库的最终归宿）
  实现 FsStorage（文件系统存储） + LocalFsSink（本地 wiki/page）
  自带 localhost Web 前端 + CLI + 多 provider 层
```

### 1.4 为什么不做成 OpenClaw 的插件（子鱼明确否决）

OpenClaw 是通用 agent runtime。但 **mathran 的文件管理体系和 UI 是自成一套独立体系的** —— project/program 的文件布局、wiki 的组织、本地 Web 前端的交互逻辑，都不是 OpenClaw plugin 框架能自然承载的。硬塞进去会让两边都别扭。所以 **mathran 是独立产品/独立 CLI**，不保留 "mathran-as-openclaw-plugin" 这条发行路线。（OpenClaw 当然仍可以把 `mathran` 当外部 CLI 工具来 `exec` 调用，但那是"用它"，不是"它是插件"。）

---

## 2. 产品边界

### 2.1 In Scope（mathran 提供）

**人类交互层（主）—— 本地 Web 前端**：

- **`mathran serve`** — 起一个 localhost Web 服务（默认 `http://127.0.0.1:7878`），浏览器打开即用。这是**数学家的主入口**。提供：
  - Project / Program 列表与管理视图（建/开/归档）
  - Wiki 浏览与编辑
  - AI Assistant 聊天面板（多模态：贴 PDF / 图片 / Lean 片段），对话中自动调度 Lean/Sage/Python/LaTeX 等工具
  - 任务进度与产物查看（proof / 文档 / 计算结果，按需产生）
  - Provider / key 配置界面
- 前端定位：**轻**。不追求 Mathub 那种全功能，是"够一个数学家自己用"的精简版。技术选型见 §3a。

**Agent 交互层（次）—— 对话式 CLI**：

- **`mathran`**（无子命令 / `mathran chat`）— **进入对话式 REPL**，这是 CLI 的主形态：用户/agent 用自然语言提需求，agent loop 自动调度 Lean / Sage / Python / LaTeX / 检索等工具，按需产出 proof、文档、计算结果。**与 Web 聊天面板共用同一套对话内核**，只是渲染在终端。主要供其它 agent / 脚本以对话方式调用。
- **`mathran -p "<prompt>"`**（或 stdin 管道）— 一次性对话（non-interactive），喂一段需求、跑完输出，供脚本/agent 编排（形如 `codex exec`）。**不是**针对 Lean 的专用入口，Lean 只是这段对话里可能用到的工具之一。
- **`mathran project init <name>`** — 建一个新 project（核心命令，见 §3b）：建目录骨架 + 初始化 wiki + 写 project 元数据文件。
- **`mathran doctor`** — 环境健康检查（elan/lake/lean、Python、SageMath、LaTeX、各 provider key）。
- **`mathran serve`** — 起本地 Web 前端（见上，既是人类入口，也是 CLI 命令）。

> **⚠️ 去掉 `mathran prove`（子鱼 2026-06-13）**：v0.2 早期草稿有个 `mathran prove <file.lean>` 单文件证明专用命令。**撤销** —— Lean 只是工具之一（和 Sage/Python/LaTeX 平级、可选），不该有独立入口。CLI 交互逻辑统一成**对话式**：要证一个 Lean 定理，就在对话里说"帮我证 xxx.lean 里的这个引理"，agent 自己决定调 Lean 工具。Web 端同理。

**文件系统工作区（替代 Mathub 的 DB）**：见 §3b。project = 目录，program/wiki/元数据 = 文件。

**多 provider 模型层**：见 §3c。OpenAI / Anthropic / Azure / Copilot / Ollama / OpenAI-compatible，运行时可切。

**保留的 agent 工具集**（来自 `_tasks/v0.1-cut-list.md`「留」清单）：

| 类别 | 工具 |
|---|---|
| 工作区 | `workspace-{read,write,list,delete}`, `scratchpad`, `memory`, `todos` |
| 任务管理 | `update-{goal,plan,step-status}`, `get-goal` |
| 子代理 | `manage-sub-agent`, `spawn-awaiter`, `list-subagents`, `get-subagent-status`（v0.1 即开，见 §2.3）|
| 引用 | `peek-ref`, `resolve-refs` |
| 检索 | `search-arxiv`, `search-web`, `read-pdf` |
| 沙箱 | `run-{latex,python,sage}`, `sandbox-common`, `install-package` |
| 元 | `load-skill-reference`, `types`, `registry` |

**保留的服务层**（来自 `mathub-extract/dep-scan.md`「进 prover-core」）：

- `efforts.ts` / `effort-doc-pages.ts` / `effort-relations.ts` / `effort-review.ts` / `effort-structure.ts` / `_common.ts`
- `lean.ts` / `lean-artifacts.ts` / `lean-builds.ts`
- `programs.ts` / `projects.ts` / `search.ts` / `threads.ts` / `blueprint.ts`

> 注意：`projects.ts` / `programs.ts` 这些服务在 Mathub 里是 DB-backed 的，进 prover-core 后其持久化必须改走 `Storage` 接口，由 mathran 注入 **FsStorage** 实现（§3b/§3c），Mathub 注入 PostgresStorage。

### 2.2 Out of Scope（明确不做）

| 不做 | 原因 |
|---|---|
| Forum / Channels / IM | 这些是社区公共服务，单机用不到 |
| 多用户 / NextAuth / 权限 / 声望 | 单机无概念 |
| Postgres / drizzle 迁移系统 | 改用**文件系统存储**（§3b）|
| Activity Feed / Notification 推送 | 单机不需要异步推送（前端内联展示即可）|
| Paper crawler / arxiv 全库 sync | 太重，按需在 `search-arxiv` 工具里临时拉 |
| Bot token / public bot API | 不对外暴露 API（localhost 前端仅本机访问）|
| 重型全功能 Web 平台（Mathub 那套） | mathran 前端是**精简本地版**，不是社区站 |

> **⚠️ 与 v0.1 的关键差异**：v0.1 把 "Web UI / Next.js 服务" 整个列进 Out-of-Scope。**v0.2 撤销这一条** —— 轻量 localhost Web 前端是 mathran 的人类主入口，必须做。只是它不是 Mathub 那种重型多租户平台。

### 2.3 灰色地带（v0.1/v0.2 阶段决策）

| 模块 | 决策 | 备注 |
|---|---|---|
| **init-agent（自动建项目）** | ✅ **保留**（子鱼 2026-06-13 拍板）| 与 `mathran project init` 直接对应，是文件管理体系的核心入口；负责建目录骨架 + 初始化 wiki + 写元数据 |
| Goal mode（goal/objective/budget） | **保留**（机制保留）；但**CLI 里默认关**（§9.1）| agent 思考的核心机制，需要时显式开 |
| chat-handler 多模态注入（PDF/图片） | **保留** | Web 聊天面板与 CLI 都需要附件输入 |
| spine/patrol（巡查 agent） | **砍** | 是社区"自动巡 Forum"用的，单机无意义 |
| `tools/list-backrefs.ts` | **保留** | 需要从 API route 下沉到 lib（见 dep-scan §Open Q4） |

> 决策口径（子鱼）："init-agent 要保留，其它按你默认。" 即上表中 init-agent 明确保留，其余维持芙莉莲 v0.1 的默认判断。

---

## 3a. 架构：本地 Web 前端（人类主入口）

mathran 的人类交互**不走 CLI**，走浏览器。`mathran serve` 起一个**只监听 127.0.0.1 的本地 Web 服务**。

**设计要求**：
- **零额外运维**：一条命令起，不要 nginx / 不要 systemd / 不要 build 步骤（对终端用户而言）。
- **轻**：精简 SPA 或 SSR，不复刻 Mathub 全功能。
- **本机隔离**：默认仅 `127.0.0.1` 可访问，无登录（单机单用户假设），不开放公网端口。
- **直接读文件系统**：前端展示的 project/wiki 数据来自 §3b 的文件目录，不经 DB。

**技术选型（✅ 子鱼要求先拍死，本节定案）**：

> **结论：采用「嵌入式 Hono + React/Vite SPA」方案（即原方案 A）。**

具体栈：

| 层 | 选型 | 理由 |
|---|---|---|
| HTTP 服务 | **Hono**（跑在 mathran 同一 Node 进程内）| 极轻、零配置、内置静态托管 + SSE；比 Express 新、比 Fastify 轻 |
| 前端 | **React + Vite 打包的静态 SPA**（build 产物随 npm 包发）| 终端用户装包时拿到的是预构产物，**本地不需 build 步骤** |
| 前端 ⇆ 内核 | **本地 HTTP + SSE**（REST 走请求，SSE 走 agent 流式 token / 工具进度）| 不引 tRPC/WebSocket，最简化；流式聊天用 SSE 够了 |
| 样式 | **Tailwind**（与 Mathub 一致，便于未来抓 Mathub 组件）| 可选；D2 实现时定 |

**为什么不复用 Mathub 的 Next.js 前端（方案 B 否决）**：Mathub 是 Next 16 + React 19 + **tRPC 11 + next-auth 5 + drizzle/Postgres**。整个拿过来会把服务端运行时 + 鉴权层 + DB 层全拖进来 —— 这恰好是子鱼要避免的重基础设施。裁剪 Next.js 的成本比重写一个精简 SPA 还高。mathran 仓现在零 web 依赖（只有 commander），从 Hono+Vite 起步包体最小。

**复用策略**：不复用 Mathub 的运行时，但**可以抓 Mathub 的 React 组件/样式**（wiki 渲染、聊天气泡、project 卡片都是纯展示组件，可搬）—— 这是保留 Tailwind 的原因。

**包体预算**：静态 SPA 产物压缩后预估 < 5 MB，在 AC10（npm 包 < 30 MB）内。

**前端 ⇆ 内核**：前端只是 prover-core 的一个消费者，通过本地 HTTP/RPC 调 prover-core 暴露的 TS API（与 CLI 平级，共享同一内核）。

```
          ┌─────────────────────────────────┐
浏览器 ──▶ │ mathran serve (127.0.0.1:7878)  │
          │   Hono + 静态 SPA  +  SSE       │
          └──────────────┬──────────────────┘
                         │  (TS API)
其它 agent ── 对话式 CLI ─▶ ├─▶ prover-core（agent 内核 + 4 Provider）
                         │
                         └─▶ 文件系统（§3b） + 多 provider（§3c）
```

---

## 3b. 架构：文件系统工作区（替代数据库）

Mathub 用 Postgres 存 project / program / effort / wiki page / 关系。**mathran 全部改用文件系统承载**，本地安装零数据库依赖。

**目录布局（提案，D2 定稿）**：

```
~/mathran-workspace/                  ← 根工作区（可配）
├── config.toml                       ← 全局配置（provider、默认 model…）
├── projects/
│   ├── <project-slug>/
│   │   ├── project.toml              ← project 元数据（名称、创建时间、program 列表…）
│   │   ├── wiki/                     ← 该 project 的 wiki（必建）
│   │   │   ├── index.md              ← wiki 首页（project init 时自动生成）
│   │   │   └── <page-slug>.md        ← 各 wiki page（front-matter 存元数据/关系）
│   │   ├── programs/
│   │   │   └── <program-slug>/
│   │   │       ├── program.toml
│   │   │       └── ...               ← effort / blueprint 等产物
│   │   ├── lean/                     ← Lean 源与 build 产物
│   │   └── out/                      ← 对话产物（proved.lean / pages / 日志）
│   └── ...
└── .mathran/
    ├── state/                        ← agent run state / scratchpad / memory（FsStorage）
    ├── skills/                       ← Skill 库（§9.3，全部打包进来）
    └── logs/<run-id>/
```

**核心命令 `mathran project init <name>` 必须做到**（init-agent 保留的落点）：
1. 建 `projects/<slug>/` 目录骨架；
2. 写 `project.toml` 元数据；
3. **初始化 wiki**：建 `wiki/` 目录 + 自动生成 `wiki/index.md`（子鱼明确："wiki 依旧需要被创建"）；
4. 可选：建第一个 program 骨架。

**Storage 抽象**：prover-core 里 `projects.ts` / `programs.ts` / wiki 相关服务原本走 SQL，提取后改调 `Storage` 接口；mathran 注入 **FsStorage**（读写上述目录 + front-matter 解析），Mathub 注入 PostgresStorage。关系（effort-relations / backrefs）在 fs 实现里用 front-matter 字段 + 索引文件表达，**为此可以舍弃一部分 Mathub 的高级关系查询能力**（子鱼："为此可以舍弃一部分功能"），但 project/wiki 基本管理必须完整。

**为什么不用 sqlite**（对 v0.1 的修订）：v0.1 提案用 sqlite 单文件。但子鱼要的是"像 Mathub 的 project/program 管理体系"且"不装重基础设施"，**纯文件 + 目录**对数学家更透明（可以直接拿文件管理器看、可以 git 版本化、可以手动编辑 wiki md），比 sqlite 黑盒更符合诉求。sqlite 仅在确有性能需要时作为 `.mathran/state/` 内部索引的可选实现，不作为 project/wiki 的主存储。

---

## 3c. 架构：多 Provider 模型层（照搬 OpenClaw / codex）

Mathub 写死单个 Azure OpenAI 端点。mathran 必须支持**多 provider、运行时可切、BYO key**（子鱼：照搬 openclaw 或 codex）。

**Provider 矩阵（目标）**：
- **OpenAI**（`OPENAI_API_KEY`）
- **Anthropic**（`ANTHROPIC_API_KEY`）
- **Azure OpenAI**（`AZURE_OPENAI_API_KEY` + endpoint + deployment）
- **GitHub Copilot**（复用 cached token，mathran 已在 06-11 跑通 GPT-5.5 / Claude via Copilot `/responses` + `/v1/messages`）
- **Ollama / vLLM / 任意 OpenAI-compatible**（`base_url` + 可选 key）

**实现思路**：抄 OpenClaw 的 provider/router 分层（或 codex 的 provider 抽象）：
- 配置在 `config.toml` 声明若干 provider + 默认 model；
- 一个 `ModelRouter` 按 `provider/model` 字符串路由到对应 adapter；
- 每个 adapter 实现统一的 `complete()` / `stream()`（即 §3d 的 `LLMProvider`）；
- key 解析优先级：CLI/前端配置 > 环境变量 > config.toml。

> mathran 仓库当前 `src/core/` 已有 LLMProvider 雏形（Azure / OpenAI / Anthropic built-in，README §59-62）+ 06-11 已跑通 Copilot（GPT-5.5 与 Claude）。v0.2 需把这套补全成完整 ModelRouter 并接进前端的 provider 配置界面。

---

## 3d. 架构契约：四个 Provider 接口

mathran 内核必须**对底层基础设施零假设**。所有"会变环境"的能力都通过 4 个 Provider 接口注入，使同一份 prover-core 既能在 mathran（本地/文件/多 provider）跑，也能在 Mathub（服务端/Postgres/单 Azure）跑：

```ts
// 1. Lean 工具链
interface LeanProvider {
  build(workspacePath: string): Promise<BuildResult>;
  check(file: string): Promise<CheckResult>;
  // mathran 默认实现：shell 出本地 elan/lake/lean
  // Mathub 平台实现：调度到远程 lean-prover-agent VM
}

// 2. LLM 推理（多 provider，见 §3c）
interface LLMProvider {
  complete(messages, opts): Promise<string>;
  stream(messages, opts): AsyncIterable<Chunk>;
  // mathran 默认实现：ModelRouter → OpenAI/Anthropic/Azure/Copilot/Ollama
  // Mathub 平台实现：单 Azure 端点（或其 LiteLLM 网关）
}

// 3. 状态持久化
interface Storage {
  // project/program/wiki + agent run state、scratchpad、memory、goal 历史
  // mathran 默认：FsStorage —— 文件系统目录 + front-matter（§3b），无 DB
  // Mathub 平台：PostgresStorage
}

// 4. 产物落地（关键！）
interface ArtifactSink {
  createPage(input: PageInput): Promise<{id: string; slug: string}>;
  updatePage(id, input): Promise<void>;
  commit(input: CommitInput): Promise<{commitSha: string}>;
  notify(userId, payload): Promise<void>;   // mathran: no-op 或前端内联提示
  postActivity(entry): Promise<void>;        // mathran: no-op 或写本地 feed 文件
  // mathran 默认：LocalFsSink —— wiki page 落 projects/<slug>/wiki/*.md + 可选 git commit
  // Mathub 平台：MathubWikiSink —— 写 wiki page + 发 notification + activity feed
}
```

**这是 mathran 提取的核心契约。** Mathub `src/lib/agent/*` 现在有 12 处直接 `import "@/lib/wiki-service"` / `"@/lib/notifications"`（dep-scan §A），这些必须**全部改成 `inject(ArtifactSink)`**；project/program/wiki 的 SQL 读写必须改成 `inject(Storage)`。这两步做完，同一份 agent 内核才能既在 Mathub 跑也在 mathran 跑。

> 4 个接口里，对 mathran 而言 **Storage（FsStorage）** 和 **LLMProvider（多 provider）** 是 v0.1 相比原计划新增的重头戏；**ArtifactSink（LocalFsSink）** 仍是把 wiki 写出来的关键。
---

## 4. 提取策略：5 个阶段

### Phase 0 — Decoupling Debt（✅ 已完成）

来自 `_tasks/mathub-decoupling-debt/`，6 个 spec 全 merge：

- spec01 workspace 改 polymorphic（去掉对 forum schema 的硬 FK）
- spec02 引入 `IPrincipal` 抽象（替代 `ctx.session.userId` 的 ~475 处使用，骨架已落，codemod 待跑）
- spec03 service-layer toIPrincipal adapter bridge
- spec04 chat-handler.ts 1442 行按章节切 7 文件
- spec05 route-manifest codegen
- spec06 test mock helper

**这一步把 Mathub 主站本身的反向耦合先压平**，剥离才有可能机械化。

### Phase 1 — prover-core 包提取（in Mathub repo, 10-13 天）

来自 `mathub-extract/dep-scan.md`，**新增 Storage 抽象任务**：

| 任务 | 工作量 | 内容 |
|---|---|---|
| A | 3-4 天 | 定义 `ArtifactSink` 接口；agent 8 处 wiki/notification import 全改为 sink 注入；Mathub 写 `MathubWikiSink` |
| A2 | +2-3 天 | 定义 `Storage` 接口；`projects.ts`/`programs.ts`/wiki 服务的 SQL 读写改为 `inject(Storage)`；Mathub 写 `PostgresStorage`（**v0.2 新增，为 fs 存储铺路**）|
| B | 2 天 | `src/lib/agent/` + 25 个 `lib/*` 子目录搬到 `packages/prover-core/` |
| C | 3-4 天 | `agent-gateway/services/` 15 个 prover 文件搬入；14 个 Mathub-only 文件留原位 |
| D | 2-3 天 | drizzle schema 拆 `prover-core-schema` + `mathub-schema`（Mathub 侧仍用 PG；mathran 侧不用 drizzle，走 FsStorage）|

Phase 1 退出条件：Mathub 主站 1449 测试全过，prover-core 单独 build 通过，Storage/ArtifactSink 双实现可切换。

### Phase 2 — mathran v0.1 完成（in mathran repo, 2-3 周）

当前 `~/mathran` 已完成（见 sweep 1-3 + tsc-pass 9 轮日志）：

- ✅ A. Skeleton from Mathub
- ✅ B. Provider 接口骨架
- ✅ C. CLI scaffolding（原始脚手架含 `prove` / `doctor` / `--version` / `--help`；**`prove` 已按子鱼 2026-06-13 决策移除**，改对话式 `mathran` / `mathran -p`）
- ✅ D. Type system passes（tsc clean）
- ⏳ **D2. 真 Provider 实现 + 文件工作区 + 多 provider + 本地前端**（关键阻塞，下面展开）
- ⏳ E. npm publish

**D2 待做清单**（v0.2 扩展，这才是 mathran 本身的实质工作）：

1. **LeanProvider 真实现** — `LocalLeanProvider`：spawn `lake build` + 解析输出
2. **LLMProvider 多 provider 真实现** — `ModelRouter` + OpenAI / Anthropic / Azure / Copilot / Ollama adapter（§3c）
3. **Storage 真实现** — **`FsStorage`**：project/program/wiki 落文件系统目录 + front-matter（§3b），**不是 sqlite**
4. **ArtifactSink 真实现** — `LocalFsSink`：wiki page 落 `projects/<slug>/wiki/<slug>.md`，commit 走本地 git
5. **`mathran project init` 真实现** — 建目录 + 写 `project.toml` + **初始化 wiki**（init-agent 落点）
6. **`mathran serve` 本地 Web 前端** — 嵌入式 HTTP server + 静态 SPA（§3a），project/wiki/chat/provider 配置 四块 UI
7. **删 stub**：sweep 1-3 后残留的 `_stubs/` 全部用真实现替换

### Phase 3 — Monorepo 合并（2 周）

Mathub 仓改成 npm/pnpm workspaces：

```
mathub-mono/
├── packages/
│   └── prover-core/      ← Phase 1 产物
├── apps/
│   ├── mathub/           ← 原 Mathub Next.js（PostgresStorage + MathubWikiSink）
│   └── mathran/          ← 把 ~/mathran 内容合并进来（FsStorage + LocalFsSink + 前端 + 多 provider）
└── package.json
```

mathran 独立仓库归档/删除。版本协调：prover-core 走独立 semver，mathub 与 mathran 各自 pin 一个版本。

### Phase 4 — 发布与对外（持续）

- npm publish `@mathub/prover-core` + `mathran`
- mathran README 加完整 quickstart（含 `mathran serve` 截图）
- 提供 3 个示例场景（对话式证一个 Lean 引理、project-level 多步推理 + wiki 沉淀、纯 math chat via Web UI）
- 文档迁移到 `docs.mathub.org/mathran`

---

## 5. 关键设计原则

### 5.1 BYO 一切 + 多 provider

mathran **不携带**任何 API key、不预设单一 LLM 端点、不绑定 Lean 版本。用户：

- 在 `config.toml` 或前端配置任意 provider：OpenAI / Anthropic / Azure / Copilot / Ollama / OpenAI-compatible（§3c）
- 自己装 elan/lake/lean，`mathran doctor` 检查 PATH

这保证 mathran 不掌握用户数据，也不替用户付任何费用（§9.4 无付费层）。

### 5.2 文件系统 / 本地优先

| 资源 | 位置 |
|---|---|
| Project / Program / Wiki | `~/mathran-workspace/projects/<slug>/`（**文件目录，非 DB**）|
| agent 运行状态 | `~/mathran-workspace/.mathran/state/`（FsStorage）|
| Skill 库 | `~/mathran-workspace/.mathran/skills/`（全部打包，§9.3）|
| 日志 | `~/mathran-workspace/.mathran/logs/<run-id>/` |
| 配置 | `~/mathran-workspace/config.toml` |

**没有任何东西写到云端。所有 project/wiki 都是数学家能直接用文件管理器打开、用 git 版本化的纯文件。**

### 5.3 内核 / UI / CLI 三分离

prover-core **只暴露 TS API**。本地 Web 前端（`mathran serve`）和 CLI 是它平级的两个消费者。未来有人想写 VS Code 插件或别的前端，应当依赖 prover-core，而非 fork mathran。

### 5.4 人类走前端，agent 走 CLI

- **人类数学家**：浏览器 → `mathran serve` localhost 前端（主路径）。
- **其它 agent / 脚本**：`mathran`/`mathran -p "…"` 对话式调用 + `mathran project init …`（CLI 作为程序化接口）。

CLI 不是给不会编程的数学家用的；它是 agent 互操作层，且交互逻辑是**对话式**的（没有 `prove` 这种面向单一工具的专用入口）。

### 5.5 与 Mathub 主站功能对等承诺

凡是 Mathub `/assistant` 聊天 + project/wiki 里能用的 prover 能力（含调度 Lean/Sage/… 工具），mathran 都必须能用（前端聊天面板或 CLI 对话均可）。**反过来不成立**（mathran 不做 forum/channels/声望 等社区能力）。文件存储相比 DB 会**舍弃部分高级关系查询**，这是子鱼接受的取舍。

---

## 6. 验收标准

### 6.1 mathran v0.1.0 GA 验收

| 编号 | 验收项 | 通过方式 |
|---|---|---|
| AC1 | `npm i -g mathran` 在干净 Ubuntu/macOS 装得上，**无需任何数据库** | CI matrix 测试 |
| AC2 | `mathran doctor` 准确报告 elan/lake/lean/python/sage/latex 与**各 provider** key 状态 | 单元测试 + 手测 |
| AC3 | `mathran serve` 起本地前端，浏览器可建 project、看 wiki、在聊天面板发起任务、配 provider | E2E（Playwright）+ 录屏 |
| AC4 | `mathran project init <name>` 建出目录骨架 + `project.toml` + **wiki/index.md** | 单元测试 |
| AC5 | 对话式 CLI（`mathran -p "证明 xxx.lean 中的引理"`）能调度 Lean 工具完成至少一个 LRC mini lemma，产物落 project 目录 | E2E 录屏 |
| AC6 | 至少 3 个 provider（如 OpenAI + Anthropic + Copilot）实测可跑通一个完整对话证明 | 集成测试 |
| AC7 | 失败案例（缺 key、缺 lean、文件不存在、provider 不可达）友好报错 | 单元测试覆盖 |
| AC8 | 断网状态下本地 lean check / 文件读写仍正常（只 LLM 调用失败） | 手测 |
| AC9 | 所有产物落到 `~/mathran-workspace/` 之内，无文件写出工作区之外 | strace 验证 |
| AC10 | npm 包 < 30 MB（不含 node_modules；含前端静态产物）| `npm publish --dry-run` |
| AC11 | 文档 README 5 分钟读完即可上手（含 serve 截图）| 用户测试 |

### 6.2 提取质量验收

| 编号 | 验收项 | 通过方式 |
|---|---|---|
| EX1 | Mathub 主站 1449 测试在 Phase 1 完成后仍全过 | CI |
| EX2 | `apps/mathub` 不再 import `packages/prover-core` 之外的 prover 代码 | madge 反向依赖图 |
| EX3 | `packages/prover-core` 0 处 import `next` / `next-auth` / `@/components/*` / `@/app/*` | grep + tsc strict |
| EX4 | `FsStorage`/`PostgresStorage` 与 `LocalFsSink`/`MathubWikiSink` 各自通过同一份接口契约测试套件 | vitest 契约测试 |
| EX5 | mathran 对话与 Mathub `/assistant` 同样输入得到等价结构产物 | 配对回归测试 |

---

## 7. 路线图

```
2026-06-10  Phase 0 完成（decoupling debt 6 spec 清零）              ✅
2026-06-11  ~/mathran 仓库初始化，A-D 阶段完成（CLI 骨架 + tsc 绿）  ✅
2026-06-12  本 PRD v0.1 起草                                         ✅
2026-06-13  PRD v0.2 修订（前端/文件存储/多 provider 纠偏）          👈 你在这里
─────────────────────────────────────────────────────────────────────
2026-06-16  Phase 1.A/A2 完成（ArtifactSink + Storage 接口 + 双实现）
2026-06-21  Phase 1.B/C 完成（agent + services 搬入 prover-core）
2026-06-25  Phase 1.D 完成（schema 拆分）→ Mathub 主站全绿
2026-07-02  Phase 2.D2-1~5 完成（mathran Provider 真实现 + FsStorage + 多 provider + project init/wiki）
2026-07-08  Phase 2.D2-6 完成（mathran serve 本地前端）
2026-07-12  Phase 2 完成 → mathran v0.1.0 npm publish
2026-07-22  Phase 3 完成（monorepo 合并）→ mathran 独立仓归档
2026-07-31  Phase 4 第一波文档与示例完成 → 正式对外宣传
```

总周期 ~7 周（从 Phase 1 开始算 ~5.5 周，比 v0.1 多约 1 周，主要是新增本地前端 + 文件存储工作量）。

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Mathub 主站测试在 Phase 1 期间间歇性挂掉 | 中 | 高 | 每个 spec 独立 commit，CI 红了立刻 revert，绝不批量推 |
| ArtifactSink/Storage 接口设计漏抽象，后期回炉 | 中 | 中 | Phase 1.A/A2 完成后强制做契约测试 EX4，提前发现 |
| **文件系统存储丢失 Mathub 的关系查询能力** | 高 | 中 | 接受取舍（子鱼已认可）；用 front-matter + 索引文件覆盖最常用关系，复杂查询不做 |
| **本地前端拖慢工期 / 选型反复** | 中 | 中 | v0.1 前端只做精简五块；倾向嵌入式 SPA（§3a 方案 A），不引 Next.js 运行时 |
| 多 provider adapter 各家协议差异大 | 中 | 中 | 直接照搬 OpenClaw/codex 已验证的 provider 层，不自己从零设计 |
| 用户装 mathran 时 native 依赖编译失败 | 中 | 中 | 文件存储已去掉 sqlite 硬依赖；其余 native 依赖提供预编译 / 纯 JS fallback |
| LLM 调用费用对个人用户太高 | 高 | 中 | 文档明确预算预估；多 provider 已内置，优先支持 local LLM（Ollama / vLLM）|
| Lean 版本漂移 | 高 | 低 | BYO 工具链，mathran 不固定版本；doctor 显示当前版本 |
| 抽包后 type-only import 形成循环依赖 | 低 | 中 | madge -c 在 CI 强制检查 |

---

## 9. 开放问题 → 已决策（子鱼 2026-06-13 拍板）

| # | 问题 | **决策** | 落地 |
|---|---|---|---|
| 1 | Goal mode 是否默认开？ | **CLI 里默认关** | `config.toml` `goal.enabled=false`；需要时 `--goal` 或前端开关打开。§2.3 |
| 2 | 子代理（subagent）支持到什么程度？ | **保持 Mathub-AI 原有设计，v0.1 就开** | 不阉割 `manage-sub-agent` 等工具，沿用 Mathub agent 的 subagent 行为。§2.1 工具表 |
| 3 | Skill 系统怎么分发？ | **全部打进 mathran 包** | ~30 个 skill 全部随包安装到 `.mathran/skills/`，不做按需 npm 拉取。§5.2 |
| 4 | 付费层？ | **没有付费层** | mathran 是每个数学家自己搭的本地服务，各自用自己的 API provider；不提供托管/代理端点。§5.1 |
| 5 | 与 OpenClaw 的关系？ | **独立 CLI，不保留 mathran-as-openclaw-plugin** | mathran 文件管理体系 + UI 自成一套，不塞进 OpenClaw plugin 框架。§1.4 |

**全部 5 项已闭环，无遗留开放问题。** 后续若有新的产品决策，另起 §9 条目。

---

## 10. 附录

### 10.1 名词

- **prover-core**：本 PRD 提议的 npm 包名，承载 Mathub 与 mathran 共享的 agent / prover 内核
- **ArtifactSink**：产物落地接口，4 个 Provider 中最关键的一个
- **Storage / FsStorage**：状态与 project/wiki 持久化接口；mathran 用文件系统实现（FsStorage），Mathub 用 Postgres
- **ModelRouter**：多 provider 路由层，按 `provider/model` 分发到各 LLM adapter（照搬 OpenClaw/codex）
- **`mathran serve`**：起本地 localhost Web 前端的命令，人类数学家的主入口
- **IPrincipal**：调用主体抽象（替代 `ctx.session.userId`），Mathub 内是登录用户，mathran 内是固定 `localhost`
- **Decoupling Debt**：Mathub 主站内为剥离做准备的 6 个 spec（已清）

### 10.2 引用清单

| 文档 | 路径 | 作用 |
|---|---|---|
| Decoupling Sprint | `~/.openclaw/workspace/_tasks/mathub-decoupling-debt/README.md` | Phase 0 落地证据 |
| 依赖扫描 | `~/.openclaw/workspace/_tasks/mathub-extract/dep-scan.md` | Phase 1 工作量依据 |
| v0.1 砍除清单 | `~/mathran/_tasks/v0.1-cut-list.md` | Phase 2 In/Out scope 依据 |
| Sweep 实施日志 | `~/mathran/_tasks/sweep-{1,2,3}-*.md` | Phase 2 已完成证据 |
| mathran README | `~/mathran/README.md` | 当前对外文案 |
| Mathub WorkspacePRD | `~/Mathub/docs/prd/WorkspacePRD.md` | 借用其 workspace/project 抽象设计 |
| OpenClaw provider 层 | OpenClaw 源码 `provider/router` | §3c 多 provider 实现参照 |

### 10.3 与 Mathub 现有 PRD 的关系

Mathub 已有 11 份 PRD（`~/Mathub/docs/prd/*.md`），全是**功能模块 PRD**（Forum/Wiki/User/Workspace/AI/...）。本 PRD 是**产品提取战略 PRD**，定位不同，不冲突。

Mathran 不需要自己的 Forum/Channels/User PRD（这些功能不做）。但 mathran 的 **project/wiki 文件模型** 与 **本地前端** 后续可各起一份子 PRD，参照 Mathub `WorkspacePRD.md` + `AIAssistantPRD.md` 的子集。

### 10.4 变更日志

- **2026-06-12 v0.1-draft** 芙莉莲首版起草，待子鱼 review
- **2026-06-13 v0.2-draft** 按子鱼决策纠偏：
  - 撤销"纯 CLI/codex 形态"定位 → **本地 Web 前端（`mathran serve`）为人类主入口，CLI 降为 agent 接口**（§0/§1/§2.1/§3a/§5.4）
  - 存储从 sqlite → **文件系统（FsStorage）**，project/program/wiki 全落文件目录，`project init` + wiki 创建为核心（§2.2/§2.3/§3b）
  - 新增**多 provider 模型层**（照搬 OpenClaw/codex）（§3c/§3d）
  - **§9 五项开放问题全部拍板**（goal CLI 默认关 / subagent v0.1 开 / skill 全打包 / 无付费层 / 独立 CLI 不做 OpenClaw 插件）
  - Phase 1 新增 A2（Storage 抽象）；Phase 2 D2 扩展到 7 项；路线图 +1 周
- **2026-06-13 v0.2-draft（补决策）** 子鱼追加两项：
  - **去掉 `mathran prove` 专用入口** → Lean 只是工具之一（与 Sage/Python/LaTeX 平级可选），CLI 交互统一为**对话式**（`mathran` REPL / `mathran -p "…"`），与 Web 聊天面板共享同一对话内核（§2.1/§5.4/§6 AC5）
  - **§3a 前端选型拍死**：嵌入式 **Hono + React/Vite 静态 SPA + 本地 HTTP/SSE**；不复用 Mathub Next.js 运行时（太重），但可抓其 React 组件/Tailwind 样式（§3a）
