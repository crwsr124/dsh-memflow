<p align="center">
  <img src="docs/banner.png?v=3" alt="MEMFLOW 记忆流模式 — DeepSeek Harness 记忆框架插件" width="100%">
</p>

# dsh-memflow

> **MEMFLOW 记忆流模式** —— DeepSeek Harness 的目录级上下文框架插件。
>
> **会话会结束，记忆不会**：感知先行、边做边记、无缝续接。
> **目录即身份**：`.dsh/context.yaml` 声明这个目录里「谁在工作」以及「开工前必须感知什么」。
> **记忆不是预设，是每个 agent loop 的基线要求。**

[English](#english) · [协议全文](MEMFLOW.md) · [License](LICENSE)

---

## 0.3.0 的前提变化

0.2.x 把记忆做成一个用户**主动挑选的 preset**：选了「记忆流模式」才有记忆。0.3.0 放弃了这个前提。

> 记忆与身份不是一种模式，而是**每个 agent loop 的基线要求**。

因此身份与感知的来源从「预设」下移到「目录」：每个工作目录用 `.dsh/context.yaml` 声明自己的 systemPrompt 与 preload，**任何**在该目录打开的会话都机械地获得这套上下文——web、headless、被调度的子 agent 一视同仁，不经过 preset 服务。

```yaml
# <工作目录>/.dsh/context.yaml
systemPrompt:            # 身份 / 协议 —— 作为 prompt section 注入
  - AGENT.md
  - ../shared/PROTOCOL.md
preload:                 # 感知 —— 作为会话首条 user message 注入
  - memory/status.md
  - memory/history.md
inherit: false           # 缺省；置 true 才向上合并祖先目录的声明（外层在前）
```

`systemPrompt` 文件在**每次 prompt 组装时重新读取**，改文件下一轮即生效；`preload` 文件拼成**一条固定的首条 user message**，每个会话只注入一次——感知先于第一个任务，且永不重投。

未声明的目录仍按 0.2.x 行为加载 `memory/` 目录（legacy fallback），存量项目无需改动。声明存在时以声明为准。

## 一个协议、两个载具

| 载具 | 作用 |
|------|------|
| `.dsh/context.yaml` 声明 | 目录级身份与感知；显式写 `inherit: true` 才沿父目录向上合并（外层先注入） |
| `DSH_CONTEXT_*` 环境变量 | **调度方的按次通道**：为某一次调度追加上下文、替换声明、或整体忽略声明 |

**这里没有 `{{memflow_protocol}}` 变量，也是有意为之。** 0.3.0 移除了「插件自带一份协议全文并注入每个 prompt」这条通道：协议属于工作目录，不属于插件。要什么身份，就在该目录的 `.dsh/context.yaml` 的 `systemPrompt` 里声明（`WORKFLOW.md` / `AGENT.md` / 你自己的协议文件）。包内 `MEMFLOW.md` 仅作参考实现与文档，不再进入任何 prompt——需要它就把它列进声明。

**这里没有 `delegate` 工具，是有意为之。** 被调度的子 agent 就是「在另一个目录里打开的一个会话」——调度方设定它的 cwd，它便从那个目录的声明里自己组装身份与感知，走的是与其它任何会话完全相同的代码路径。若再提供一条「把准备好的 dossier 递给子 agent」的通道，就等于用两套发散的机制说同一件事。

### 按次调度参数

目录声明的是**默认身份**，调度方还需要能收窄某一次运行。进程外（ACP）provider 无法下推 `persona` / `outputSchema` / `toolFilter`（subagent 服务在 `start` 之前就会拒绝），唯一能穿过进程边界的通道是子进程环境变量：

| 变量 | 作用 |
|------|------|
| `DSH_CONTEXT_IGNORE=1` | 忽略所有声明（纯 headless，连 legacy `memory/` 也不注入） |
| `DSH_CONTEXT_FILE=<abs>` | 用指定声明文件替代目录发现 |
| `DSH_CONTEXT_SYSTEM_PROMPT=<paths>` | 追加身份文件（换行或路径分隔符分隔） |
| `DSH_CONTEXT_PRELOAD=<paths>` | 追加感知文件 |
| `DSH_CONTEXT_PARAMS=<json\|text>` | 本次调度参数，原文注入，排序在所有身份 section **之后**（因此可收窄它们） |

用 `DSH_*` 前缀是有意为之：harness 的 `scrubbedParentEnv()` 会从环境继承中剥掉所有 `DSH_*` 名称，而显式 env 层在剥离**之后**合并——所以交给某个子 agent 的参数**不会泄漏到它自己的孙 agent**。按次调度真的只作用一次。

## 快速开始

```sh
# 安装（bundle 自动注册，首次需重启 dsh 进程加载）
dsh plugin --profile web add github:crwsr124/dsh-memflow
dsh plugin --profile headless add github:crwsr124/dsh-memflow

# 在项目里声明身份与感知
mkdir -p .dsh && cat > .dsh/context.yaml <<'YAML'
systemPrompt:
  - AGENT.md
preload:
  - memory/status.md
  - memory/history.md
YAML

# 任何会话在该目录打开即生效
dsh --profile headless "你的任务"
```

## 配置

插件行（row）config（在 profile `cordis.patch.yml` 按 id 覆盖）：

| 键 | 默认 | 说明 |
|----|------|------|
| `declarationFile` | `.dsh/context.yaml` | 声明文件相对路径 |
| `discover` | `nearest` | `nearest` = 从 cwd 向上找最近声明并按 `inherit` 续走；`cwd` = 只认 cwd 自己的声明 |
| `inherit`（声明内键） | `false` | 由声明文件自身控制是否继续向上合并；缺省不继承——一个目录的身份默认只由它自己说清楚，需要叠加祖先声明时显式写 `true` |
| `sectionOrderBase` | `10` | 身份 section 起始 order（在 `DEPLOYMENT_PERSONA` 0 之后、`PLAN_POLICY` 500 之前） |
| `maxSections` | `16` | 身份 section 槽位数上限（注册期固定，空槽渲染为空） |
| `systemPrompt` / `preload` | `[]` | row 级追加文件，等价于 `DSH_CONTEXT_*` 的静态形式 |
| `ignoreDeclaration` | `false` | 整个 profile 忽略声明（纯 headless profile 用） |
| `allowEnvOverride` | `true` | 是否接受 `DSH_CONTEXT_*` 环境通道 |
| `legacyMemoryFallback` | `true` | 无声明目录回退加载 `memory/`（0.2.x 行为） |
| `memoryBootstrap` | `true` | 注入首条感知消息 |
| `memoryPriority` | `['history','brick_index','notes','status','tasks']` | legacy fallback 的文件优先序 |
| `perFileBytes` | 不限 | 单文件 UTF-8 字节上限；仅显式设置时截断并标为受限快照 |
| `totalBytes` | 不限 | 快照总 UTF-8 字节上限；同上 |
| `skipDelegated` | `false` | 设 `true` 则不给 `delegationDepth > 0` 的进程内子 agent 注入感知；默认注入，因为子 agent 与其它会话一样只是「某个目录里的一个会话」（旧名 `includeDelegated: false` 等价） |
| `suppressRoots` | `[]` | 抑制目录：这些项目根（按 `.git` 向上发现）完全不注入 |

0.3.0 移除了 `protocolFile` 与 `rosterlessProtocol`（协议全文通道已废，见上文）；配置里残留这两个键无害，会被忽略。

`memoryPerFileBytes` / `memoryTotalBytes` 作为 `perFileBytes` / `totalBytes` 的旧名仍被接受。

## 目录结构

```
<工作目录>/
├── .dsh/
│   └── context.yaml     # 身份与感知声明（0.3.0 起的入口）
├── AGENT.md             # 该目录的 agent 身份 / 协议（由声明引用）
└── memory/              # 持久记忆
    ├── tasks.md         # 任务清单与状态
    ├── status.md        # 项目现状快照
    ├── history.md       # 工作记录
    ├── notes.md         # 实操笔记与陷阱
    ├── brick_index.md   # 可复用技能索引
    └── bricks/          # 可复用技能文档
```

## 实现说明

- **零 `@deepseek-ai` 依赖**（有意为之）：profile 插件若携带与组合 row 重名的依赖（`dsh-tools`/`dsh-subagent` 等），会遮蔽 host row 的模块解析导致 Symbol 分裂、首次工具调用即崩。本插件全部走注入服务（`ctx.tools` / `ctx.subagents` / `ctx.get('jobs')` / `ctx.systemPrompt`），工具定义与 YAML 子集解析器均手写。
- **stdout 属于协议**：ACP 部署下 stdout 是 JSON-RPC 帧通道，插件从不写 stdout，诊断只走 `ctx.logger`。
- **感知是框架保证，不是模型自觉**：感知消息由 `agent/pre-step` 瀑布机械注入（与 agent-instructions 同通道），去重依据是会话持久事件日志而非单轮 step。
- **声明解析出错不杀 loop**：YAML 子集解析器带行号报错，`loadDeclaration` 捕获后告警并退化为「无声明」，不影响会话启动。
- 社区项目，与 DeepSeek 官方无隶属关系。

## English

**MEMFLOW** — per-directory context composition for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness).

**0.3.0 changes the premise.** Memory and identity are no longer a *preset* a user picks; they are a **baseline requirement of every agent loop**. A directory declares who works there and what must be perceived before work starts, and any session opened in that directory gets that composition mechanically — web, headless, or dispatched subagent alike, with no roster involved.

```yaml
# <dir>/.dsh/context.yaml
systemPrompt: [AGENT.md]          # identity → ordered prompt sections, re-read per assembly
preload: [memory/status.md]       # perception → ONE fixed first user message, once per session
inherit: false                    # default: do not merge ancestors; set true to opt in
```

A dispatcher refines a single run through the child's environment — the only channel that survives a process boundary, since an out-of-process provider may not push `persona`:

```
DSH_CONTEXT_IGNORE=1              ignore declarations (pure headless)
DSH_CONTEXT_FILE=<abs>            use this declaration instead of discovery
DSH_CONTEXT_SYSTEM_PROMPT=<paths> extra identity files
DSH_CONTEXT_PRELOAD=<paths>       extra perception files
DSH_CONTEXT_PARAMS=<json|text>    this run's parameters, injected verbatim
```

`DSH_*` is the right namespace on purpose: the harness strips every `DSH_*` name from ambient inheritance and merges explicit env layers after the scrub, so a parameter handed to one child does not leak into that child's own grandchildren.

Directories without a declaration still load `memory/` mechanically (0.2.x behavior), so existing projects keep working untouched.

Install:

```sh
dsh plugin --profile <name> add github:crwsr124/dsh-memflow
```

A community project, not affiliated with DeepSeek.
