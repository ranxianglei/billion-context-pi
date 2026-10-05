[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
<strong>Billion-Context</strong> — <a href="https://pi.dev">Pi</a> 的上下文压缩插件
<br />
由模型决定<em>何时</em>压缩、压缩<em>什么</em> — 而非硬性截断。
</p>

---

## 社区

QQ群:
1056132097(已满)
1108730198(未满)

---

## 📄 论文 / 预印本

- **[模型驱动的分层增量压缩:面向长寿命编码 Agent 的免训练多代上下文管理](./paper/模型驱动的分层增量压缩-免训练多代上下文管理.md)**(中文版,v0.2)

> 📝 **论文本身与代码一同以 MIT 许可开源(位于 `paper/` 目录),是代码库的一部分 —— 这是一份活文档,任何人都可以编辑,欢迎提 PR 改进。**

生产规模纵向研究:四个半月、三宿主、174,327 次模型调用、187.6 亿累计输入 token(三宿主合计约 247 亿),204,800-token 窗口零违规,马拉松会话 8,584–12,049 次调用。

---

<p align="center">
<a href="https://www.npmjs.com/package/billion-context-pi"><img src="https://img.shields.io/npm/v/billion-context-pi.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/billion-context-pi/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/billion-context-pi.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/billion-context-pi"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fbillion--context--pi-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>pi install npm:billion-context-pi</code>
</p>

---

> **宿主支持:** 本插件面向 **Pi**。它**不支持 OMP(oh-my-pi)** —— 在 OMP 宿主上会拒绝运行。OMP 用户请直接改用 [billion-context](https://github.com/ranxianglei/billion-context)(启动命令 bili omp);其他客户端的完整对照见[该选哪个?](#该选哪个)。OMP 详细说明:[docs/omp.zh-CN.md](./docs/omp.zh-CN.md)。

## 为什么选择 billion-context

当对话变长,模型的上下文会耗尽。多数工具采用硬截断 —— 静默丢弃早期消息。**billion-context** 把 `compress` 工具交给模型:由 LLM 决定**何时**压缩、压缩**什么**,将内容压缩成高保真摘要,在回收上下文空间的同时保留关键细节(文件路径、决策、错误字符串)。

与 Pi 内置的自动压缩(把所有内容替换成单个摘要)不同,billion-context:

- **保留结构** — 压缩的范围变成带标签的块,可后续解压
- **多级压缩** — 摘要可被进一步蒸馏(T1 → T2 → T3),随会话增长保持有界
- **可搜索** — `search_context` 无需解压即可搜索已压缩块内的信息
- **有选择性** — 受保护的工具、用户消息、近期工作集永不被压缩

这使得:

1. **一个会话即可支撑海量工作。** 根据三级压缩架构的模拟测试(见 [opencode-acp](https://github.com/ranxianglei/opencode-acp)),单会话累计可处理约 100 亿至 600 亿 token —— 同时对遥远的关键信息(路径、决策、签名)保持长久记忆。用户可以在**同一个会话里连续工作几个月**,而无需因为上下文膨胀而开新会话丢上下文。
2. **上下文长期保持精简。** 实际运行中上下文通常稳定在 15 万 token 以下(opencode-acp 实测维持在 20 万以下),相比传统压缩方案动辄撑到 100 万上下文,**单会话累计可节省近 5 倍的 token 费用**。

## 该选哪个?

按客户端选:

| 客户端 | 用这个 |
|---|---|
| **pi** | [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)(进程内扩展) |
| **opencode** | [`opencode-acp`](https://github.com/ranxianglei/opencode-acp)(进程内扩展) |
| **omp** | [`billion-context`](https://github.com/ranxianglei/billion-context),`bili omp`(内置插件) |
| **其余所有** | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili <client>`(启动器,优先)或 `/bili/` 前缀 |

> 为什么 OMP 不能用本进程内扩展、以及强行使用的后果:见下文[宿主支持](#宿主支持)与 [docs/omp.zh-CN.md](./docs/omp.zh-CN.md)。

## 安装

```bash
pi install npm:billion-context-pi
```

完成。扩展在下次 Pi 启动时自动加载。无需配置 —— 它会自动读取模型的上下文窗口。

> **想使用子代理?** `acp_delegate` 工具已拆分至独立的 [**billion-context-pi-subagents**](https://github.com/ranxianglei/billion-context-pi-subagents)([#612](https://github.com/ranxianglei/billion-context-pi/issues/612))——需要委派时一并安装:`pi install npm:billion-context-pi-subagents`。它读取同样的 `acp.json` 文件(所有 `delegate.*` 键已迁往该包)。若你同时保留 `pi-subagents`,该包会在会话启动时检测,并对**项目级**安装自动停用其 delegate;pi-subagents 的子代理可通过本包下方的 `/acp-subagents` 命令获得 ACP 压缩。

## 工作原理

billion-context 拦截 Pi 的 `context` 事件(每次 LLM 调用前触发),运行一个 8 阶段管线:

```
assign refs → sync blocks → prune → filter → hide calls → recommend → nudge → emergency truncate
```

每条消息获得一个不可见的 `<acp>` 引用标签(`m00001`、`m00002`、...),对模型可见但用户不可见。模型用这些引用来指定压缩范围。

Pi 内置的自动压缩会被取消 —— billion-context 是唯一的上下文管理者。

## 插件兼容性与排序

billion-context 通过拦截 Pi 的 `context` 事件接管上下文管理。**Pi 没有插件优先级机制** —— 当多个扩展为同一个事件注册 handler 时,它们按固定顺序(加载顺序)执行,没有 `priority`/`weight` 字段,用户也无法控制顺序。`context` 事件尤其是一个*管线*:每个 handler 都接收上一个 handler 的输出,没有短路,**最后一个** handler 对发给模型的内容拥有最终决定权。

这带来两个实际影响:

1. **只保留一个上下文压缩插件。** 如果同时运行两个压缩插件(例如 billion-context-pi 和另一个),它们都会改写消息列表、互相覆盖 —— 已压缩的范围可能被重新展开或破坏。Pi 的内置自动压缩已由 billion-context-pi 自动取消,但任何*第三方*压缩/compaction 扩展都应卸载。

2. **即使只有一个压缩插件,在少数情况下仍可能出现干扰。** Pi 下的加载顺序由文件系统发现顺序(`fs.readdirSync` 遍历 `.pi/extensions/` → 全局 → 包)决定,并不完全确定。如果另一个(非压缩类)扩展也 hook 了 `context` 事件、且恰好加载在 billion-context-pi *之后*,它可能修改压缩后的输出。billion-context-pi 从会话日志重建工作集(而非链式输入),这让它对*排在它之前*的 handler 鲁棒 —— 但无法防御*排在它之后*的 handler。这是 Pi 扩展模型的固有限制;若你观察到上下文行为异常,请检查是否有其他已安装扩展拦截了 `context` 事件。

## 宿主支持

billion-context-pi 面向 **Pi** 编码代理(`@earendil-works/pi-coding-agent`)构建,并在会话开始时检测宿主——完整的「客户端 → 包」对照表见[该选哪个?](#该选哪个):

- **Pi** — 完全支持。
- **OMP(`can1357/oh-my-pi`)** — **不支持。** OMP 的进程内会话 API 与 Pi 不同,扩展注入的压缩引用可能与会话的真实引用漂移失步,导致 `compress` 调用失败,报错 `does not exist in this session`(issue [#234](https://github.com/ranxianglei/billion-context-pi/issues/234))。在 OMP 上,扩展现在会**拒绝服务**:打印警告、禁用 ACP 工具,并保持宿主自身的上下文处理不受影响。

  **请改用 [billion-context](https://github.com/ranxianglei/billion-context)** — 它把同样的压缩流水线运行在服务端代理里,因此引用不会漂移:

  ```bash
  npm install -g billion-context
  bili omp   # 让 OMP 通过代理运行
  ```

  完整说明:[docs/omp.zh-CN.md](./docs/omp.zh-CN.md)。

- **与 [billion-context](https://github.com/ranxianglei/billion-context) 线代理共存** —— 两者同时作用于同一会话会对每个请求双重压缩(token 浪费、嵌套摘要、两套 ref 坐标系)。这会被自动防止:launcher 路径(`bili pi` 等)导出 `BILLION_CONTEXT_PROXY`;模型 `baseUrl` 经代理路由(`…/bili/https://upstream…`)时在会话开始即被检测到 —— 两种情况下 billion-context-pi 都会带警告让位,由代理独占压缩。一个例外:透明模式(流量经 `HTTPS_PROXY` 到达代理、URL 无 `/bili/` 前缀)无法从 URL 识别 —— 此时请在启动 pi 前导出 `BILLION_CONTEXT_PROXY=1`。

- **反向冲突 —— `billion-context` 薄插件抢占 `/acp`。** 如果 [`billion-context`](https://github.com/ranxianglei/billion-context) 内置的 pi 插件也被安装了(`~/.pi/agent/settings.json` 的 `"packages"` 里存在指向某个 `billion-context` 安装目录的条目,例如来自 `bili plugin install pi`),它会注册自己的 `/acp` 命令,而 Pi 没有重复命令防护 —— 哪个生效取决于加载顺序。典型症状:在普通 `pi` 启动下输入 `/acp` 显示 ``bili: no proxy detected (run via `bili <client>` or set a /bili/ baseURL)`` —— 这行字符串由薄插件发出,**不是** billion-context-pi 发出的,而且 pi 并不需要运行 `bili`。修复:该冲突只在你用普通 `pi` 启动时才有实际影响 —— 移除薄插件(`bili plugin remove pi`,或从该设置文件中删除除 `npm:billion-context-pi` 之外的条目),让 `/acp` 由 billion-context-pi 接管;若改用 `bili pi` 启动则无需移除任何东西:launcher 会导出 `BILLION_CONTEXT_PROXY`,billion-context-pi 整体让位(见上一条),两个插件可以并存。注意:`bili plugin install pi` 会静默删除该文件中已有的 `npm:billion-context-pi` 条目且不提示([billion-context#788](https://github.com/ranxianglei/billion-context/issues/788))。

## 模型工具

| 工具 | 作用 |
|------|------|
| `compress` | 用详细摘要替换连续的消息范围 |
| `decompress` | 恢复之前压缩的块内容 |
| `search_context` | 按关键词搜索已压缩块摘要(及可见消息) |
| `acp_status` | 显示上下文用量、已压缩块、可压缩范围 |
| `acp_rule` | 记录一条简短、原则性的提醒,穿越压缩保留(可选:`"rules": true`) |

`acp_rule` 是可选的——默认关闭,在 `acp.json` 中设置 `"rules": true` 启用。

### 子代理(独立包)

干净上下文委派(`acp_delegate` / `acp_delegate_wait` / `acp_delegate_cancel`、fleet inspector、TUI 状态 widget)已从本包拆分至 [**billion-context-pi-subagents**](https://github.com/ranxianglei/billion-context-pi-subagents)([#612](https://github.com/ranxianglei/billion-context-pi/issues/612))。需要委派时一并安装:

```bash
pi install npm:billion-context-pi-subagents
```

它读取同样的 `acp.json` 文件——所有 `delegate.*`、`displayUsage`、`delegatePrompt` 键已迁往该包,因此现有键会被新包原样读取、被本包忽略。角色、执行模型(async/sync、通知、看门狗)、配置键与环境变量覆盖均在其 README 中记录。

## `/acp` 命令

为用户提供丰富的状态显示:

```
╭─────────────────────────────────────────────╮
│           ACP Context Analysis              │
╰─────────────────────────────────────────────╯
 billion-context-pi@0.1.14

Context: 12% (120K / 1.0M)
Growth: +15K since last nudge

Token Breakdown:
  System     ░░░░░░░░░░░░░░░░░░░░   2%  2.1K
  Tool       ████████████░░░░░░░░  58%  69.6K
  Summaries  ████░░░░░░░░░░░░░░░░  20%  24.0K
  Code       ██░░░░░░░░░░░░░░░░░░  10%  12.0K
  Text       █░░░░░░░░░░░░░░░░░░░   5%  6.0K

Blocks: 3 active (3.7K summary, 15.2K original compressed)
  b1 (T1)  3.7K→599  age=5m  "API exploration"
  b2 (T1)  8.2K→2.1K  age=2m  "Debug session"
  b3 (T2)  3.3K→1.0K  age=1m  "Architecture review"
```

## `/acp-subagents` 命令

**可选、一次性设置——仅当你同时使用 [pi-subagents](https://github.com/nicobailon/pi-subagents) 时需要。**

如果你保留了 pi-subagents(无论是否同时安装 [billion-context-pi-subagents](https://github.com/ranxianglei/billion-context-pi-subagents)),并希望它的内置子代理在长任务中也能使用 ACP 上下文工具(`compress`/`decompress`/`search_context`/`acp_status`),运行:

```
/acp-subagents
```

它会从已安装的 pi-subagents 包中发现 agent 名单与工具基线,并向 `~/.pi/agent/settings.json` 的 `subagents.agentOverrides` 追加这四个 ACP 工具(安全写入:备份 + 校验)。不会自动写入——该命令是唯一的写入路径。升级 pi-subagents 后重新运行即可。git 安装或 fork 请显式传入包目录:`/acp-subagents <installDir>`。

## 配置

billion-context-pi 开箱即用,无需任何配置——它会自动读取模型的上下文窗口并应用合理的默认值。

行为通过可选的 `acp.json` 配置文件(`~/.pi/acp.json` 为全局默认,`<项目>/.pi/acp.json` 为项目级覆盖)以及若干环境变量来调优。完整参考——每个 key、类型、默认值与优先级顺序——请查阅 **[CONFIGURATION.zh-CN.md](./CONFIGURATION.zh-CN.md)** ([English](./CONFIGURATION.md))。

### 日志

billion-context-pi 会向 `~/.pi/acp.log`(可用 `ACP_LOG_FILE` 覆盖)写入结构化的**始终开启**日志,覆盖模型工作的整个会话,便于排查问题:

- **始终写入**(即使 `debug: false`):`error`、`warn`、`info` 级别——会话启动、每个上下文轮次(token 用量/nudge 决策)、压缩/解压,以及**所有错误与警告**(配置/状态/工具失败、护栏上限、更新失败)。错误行包含 message 与 stack trace。(安装 [billion-context-pi-subagents](https://github.com/ranxianglei/billion-context-pi-subagents) 后它也写入同一文件。)
- **仅当 `debug: true` 时写入**:详细的 `debug` 级别诊断(完整字段转储、逐轮内部数据)。

- **Nudge 审计轨迹** — 无论何时注入上下文限制 nudge,一条紧凑的单行记录(如 `[ACP nudge] EMERGENCY 95% · T1 · top range m00120–m00168`)会作为*仅供显示*的会话条目写入——它跨进程重启存活,在 TUI 回滚历史和会话文件中可见,且永远不会发给模型。

每行格式:`<ISO 时间戳> [<级别>] [<范围>] key=value key=value`。多行字段值(如 `nudge-injected` 中的完整 nudge 正文)会被转义(`\n` → 字面量 `\\n`),保证每条日志恰好占**一行物理行**,便于 `grep`。文件达到 10 MB 时轮转为 `~/.pi/acp.log.old`。

```bash
tail -f ~/.pi/acp.log                 # 实时观察会话
grep '\[error\]' ~/.pi/acp.log        # 汇总所有记录的失败
```

### 压缩策略

模型接收(在其系统提示中)关于**何时**压缩、**逐字保留什么**(路径、签名、错误、决策、用户意图)、**丢弃什么**(冗长日志、重复内容、已消费的探索)的详细指导。这段指导每轮都注入,确保它始终在模型的注意力范围内。

### 哪些内容会被保护

billion-context 保护四类内容不被压缩:

1. **永久保护的工具** — `compress` 调用被硬保护(它们是承载关键元数据的;压缩它们会破坏 decompress 和"摘要是历史"的契约)。
2. **软近期区** — 最后 N 条消息(默认 5)和最后约 5K token 被软保护,让模型保留工作集。来自 `decompress`、`search_context`、`read`、`bash` 的工具结果被**排除**出此区:它们体量大、消费后就该能压缩,所以不该占用保护预算。
3. **最后一条用户消息** — 始终保护(用户意图必须存活)。
4. **用户配置的工具保护** — `acp.json` 中的 `protectedTools` / `protectedLatestTools` 硬排除匹配的工具 call+result(全历史 vs 仅最近一次;见 [CONFIGURATION.zh-CN.md](./CONFIGURATION.zh-CN.md))。

## 会话存储与迁移

billion-context-pi 把每个会话的压缩状态持久化在会话转录文件旁边的一个**旁挂(sidecar)文件**里。每个会话在 Pi 的会话目录(`~/.pi/agent/sessions/`)下都有两个文件:

| 文件 | 内容 |
|------|------|
| `<id>.jsonl` | 会话转录(消息、工具调用) |
| `<id>.jsonl.acp.json` | ACP 压缩状态(压缩块、消息引用、nudge 与统计) |

`.acp.json` 旁挂文件承载了你的压缩块。没有它,会话就会以完整原始历史运行,直到 ACP 再次压缩。

### 旁挂文件契约(下游工具)

直接读取 `<sessionFile>.acp.json` 的工具(跨会话检索、记忆层等)依赖以下契约:

- 文件顶层携带 `schemaVersion` 与 `producer`。**缺失 `schemaVersion` 即视为 v1**(契约引入前的旧文件)。遇到未知的*更高*版本意味着字段可能已变化——跳过该文件、记一次日志、绝不改写它。
- `blocks[]` 条目符合导出的 `BcpBlockV1` 类型(kernel `CompressionBlock` 原样存储);未知的额外字段是增量式的,读取方必须忽略。
- 文件始终以**原子方式**替换(临时文件 + rename),并发读取方看到的要么是前一个完整文件、要么是后一个完整文件,绝不会读到半截写入。

TypeScript 中通过 `import type { BcpBlockV1 } from "billion-context-pi/contract"` 导入契约;离线校验用的 JSON Schema 以 `billion-context-pi/contract/schema` 子路径发布。无需任何运行时依赖——文件本身仍是唯一事实来源。

### 迁移会话(跨机器拷贝 / 备份恢复)

Pi 内置的导出/导入只搬运**转录**,不搬 ACP 状态。会丢失两样东西:

1. **`.acp.json` 旁挂文件不会被携带。** 因此导入后的会话*没有任何*压缩块:每次 LLM 调用都会重发完整原始历史,直到 nudge 重新压缩 —— 一次性全量重缓存成本 + 上下文膨胀回原始大小。超长会话可能在重新压缩生效前逼近甚至超出模型窗口(本插件激活时 Pi 的原生 compaction 被禁用,ACP 是唯一的上下文管理者)。
2. **导出会丢弃 `parentSession` 头。** clone/fork 子会话依赖这个头字段来继承父会话的压缩状态;一旦导出,这条链接就断了 —— 即使目标机器上父会话的文件仍然存在。

**要带着完整压缩状态迁移会话,请把两个文件一起拷贝**(它们共享同一基础名):

```bash
# 成对拷贝
cp <id>.jsonl <id>.jsonl.acp.json  <目标目录>/
# ... 或整体备份 / 恢复整个目录
cp -r ~/.pi/agent/sessions  <备份>/pi-sessions
```

在目标机器上把它们放回彼此相邻的位置。对 clone/fork 子会话,还要带上父会话的那一对,以便 `parentSession` 能解析。

> 根治方案 —— 让宿主在 import/export 时一并携带旁挂文件并保留 `parentSession` —— 属于上游 pi-coding-agent,已在 issue [#299](https://github.com/ranxianglei/billion-context-pi/issues/299) 跟踪。落地前请手动成对拷贝。

## 基于 acp-kernel

压缩引擎是 [`acp-kernel`](https://github.com/ranxianglei/acp-kernel) — 平台无关、MIT 许可的库,有 208 个测试。它被内联打包进 `dist/index.js`,因此零运行时依赖。

## 许可证

MIT.
