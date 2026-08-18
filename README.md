<p align="center">
  <img src="docs/banner.png?v=3" alt="MEMFLOW 记忆流模式 — DeepSeek Harness 记忆框架插件" width="100%">
</p>

# dsh-memflow

> **MEMFLOW 记忆流模式** —— DeepSeek Harness 的记忆框架插件。
>
> **会话会结束，记忆不会**：感知先行、边做边记、无缝续接。
> **分布式记忆架构**：每个项目都有自己的记忆，子任务自定义记忆上下文，项目 skill 自迭代。
> **一个插件让你的所有工作流实现类 Hermes 效果。**

[English](#english) · [协议全文](MEMFLOW.md) · [License](LICENSE)

---

## 模式描述

MEMFLOW 是 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的记忆框架插件，核心理念一句话：

> 任何 AI 会话的关键状态都不应只停留在对话里——会话结束即永久丢失。

因此每个工作目录（项目）都拥有自己的 `memory/` 持久记忆：会话开始时**机械加载**当前目录的记忆快照、工作中**边做边记**——该记就记：任务完成、状态变化、关键决策、踩坑经验**触发即写**，没有固定的收尾落盘流程。任何新会话只要打开同一目录，就能完整恢复现状。所有项目的记忆各自独立、互不干扰——这就是分布式记忆架构。

<p align="center">
  <img src="docs/flow.png?v=3" alt="MEMFLOW 模式循环：新会话 → 感知 → 工作 → 会话结束 → 新会话" width="92%">
</p>

**一个协议、三个载具**：

| 载具 | 作用 |
|------|------|
| `{{memflow_protocol}}` 协议变量 | 每次 prompt 组装时**实时读取** `MEMFLOW.md` 全文注入 persona——协议一改即刻生效，无副本漂移 |
| `delegate` 工具 | 以 **prepared dossier**（项目记忆 + 必读文件机械内联）启动 MEMFLOW 协议驱动的 worker 子 agent；支持前台 / 后台 one-shot / continuable 三模式 |
| `memflow` 预设自动供给 | 安装即自动创建可选的「记忆流模式」preset（复制 standard、persona 挂协议变量、禁用内置子 agent 工具防递归）；不改变部署原有默认预设 |

**安装即激活**：`dsh plugin --profile <name> add dsh-memflow` 一条命令，bundle 自动注册、preset 自动创建，无需手工改 patch。新会话仍使用部署已有默认模式；需要记忆流时在新建会话时选择「记忆流模式」。

## 快速开始

```sh
# 安装（bundle 自动注册，首次需重启 dsh 进程加载）
dsh plugin --profile web add github:crwsr124/dsh-memflow
dsh plugin --profile headless add github:crwsr124/dsh-memflow

# 新建会话 → 按需选择「记忆流模式」预设
# 或 headless 直接跑：
dsh --profile headless "你的任务"
```

任何目录下启动的会话都会：

1. **感知先行**：每个会话仅在开始前注入一次当前目录 `memory/` 的固定记忆快照（`history/brick_index/notes/status/tasks` 优先，其余 `.md` 补齐，单文件 8KB / 总量 64KB 上限，截断带路径提示）；会话中修改记忆不会触发再次注入，需要时由 agent 按路径主动读取；headless 部署的会话同时随首条消息获得**协议全文**（web 侧协议经 persona 注入）；
2. **边做边记**：关键决策、状态变化、踩坑经验**触发即写**（该记就记，没有固定落盘流程）；
3. **委派传承**：用 `delegate` 工具委派子 agent 时，`project_dir` 的记忆与 `context_files` 必读文件机械内联进 dossier，子 agent 自包含开工。

## 配置

插件行（row）config（在 profile `cordis.patch.yml` 按 id 覆盖）：

| 键 | 默认 | 说明 |
|----|------|------|
| `protocolFile` | 包内 `MEMFLOW.md` | 协议文件路径，实时读取；部署可指向自有协议副本 |
| `setDefault` | `false` | 安装时创建 `memflow` preset，但不改变已有默认；仅显式设为 `true` 时才经 settings 服务将它设为默认 |
| `memoryBootstrap` | `true` | 会话首条消息注入记忆快照（depth-0 会话） |
| `rosterlessProtocol` | `true` | headless（无 preset 服务）会话随快照消息附带协议全文；若已把 `{{memflow_protocol}}` 接入 headless persona 则设 `false` 防双注入 |
| `memoryPriority` | `['history','brick_index','notes','status','tasks']` | 记忆文件优先序 |
| `memoryPerFileBytes` | `8192` | 单文件内联上限 |
| `memoryTotalBytes` | `65536` | 快照总上限 |
| `maxInlineBytes` | `32768` | delegate dossier 单文件内联上限 |
| `denyTools` | `['subagent','subagent_fork','delegate']` | 子 agent 工具 deny 名单（防递归） |
| `enableRunInBackground` | `true` | delegate 后台模式开关 |
| `backgroundMode` | one-shot | `continuable` = 可续接子 agent（`send_message` 追活） |
| `provider` | `spawn` | 子 agent provider |
| `toolName` | `delegate` | 工具注册名 |
| `maxDepth` | `1` | 委派递归深度上限（或 `'provider-managed'`） |
| `suppressRoots` | `[]` | 抑制目录：这些项目根（按 `.git` 向上发现）不注入协议、不注入记忆快照 |

## 目录结构

```
<工作目录>/
├── MEMFLOW.md          # 协议（可选放置，便于人类与工具发现）
└── memory/             # 持久记忆（框架强制维护）
    ├── tasks.md        # 任务清单与状态
    ├── status.md       # 项目现状快照
    ├── history.md      # 工作记录
    ├── notes.md        # 实操笔记与陷阱
    ├── brick_index.md  # 可复用技能索引
    └── bricks/         # 可复用技能文档
```

## 实现说明

- **零 `@deepseek-ai` 依赖**（有意为之）：profile 插件若携带与组合 row 重名的依赖（`dsh-tools`/`dsh-subagent` 等），会遮蔽 host row 的模块解析导致 Symbol 分裂、首次工具调用即崩。本插件全部走注入服务（`ctx.tools` / `ctx.subagents` / `ctx.get('jobs')` / `ctx.systemPrompt`），工具定义手写。
- **感知是框架保证，不是模型自觉**：记忆快照由 `agent/pre-step` 瀑布机械注入（与 agent-instructions 同通道）；协议经两条通道之一进入上下文——web/预设会话走 persona 变量 `{{memflow_protocol}}`，headless 会话随快照消息附带全文。装上即用，任何目录都有完整记忆能力。
- 社区项目，与 DeepSeek 官方无隶属关系。

## English

**MEMFLOW** — the memory framework plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness).

**Distributed memory architecture: every project carries its own memory, one plugin for Hermes-like memory across all your workflows.**

No session state should live only in the conversation — it dies with the session. With MEMFLOW, every working directory (project) owns a persistent `memory/`, mechanically loaded at session start, recorded the moment it matters while working — no fixed commit step. Any new session opening the same directory restores full context.

One protocol, three carriers:

- `{{memflow_protocol}}` — a live prompt variable that re-reads `MEMFLOW.md` on every assembly;
- `delegate` — a tool that spawns protocol-driven worker subagents with prepared context dossiers (project memory + required files inlined; foreground / background one-shot / continuable modes);
- the `memflow` preset — auto-provisioned on install (copied from `standard`, persona wired to the protocol variable) without changing the existing default; set `setDefault: true` only when that default is explicitly desired.

Install:

```sh
dsh plugin --profile <name> add github:crwsr124/dsh-memflow
```

A community project, not affiliated with DeepSeek.
