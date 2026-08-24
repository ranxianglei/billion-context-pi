# 配置参考

[English](./CONFIGURATION.md) | [中文](./CONFIGURATION.zh-CN.md)

**billion-context-pi** 开箱即用，无需任何配置——它会自动读取模型的上下文窗口并应用合理的默认值。本文档是可选 JSON 配置文件（`acp.json`）和环境变量的完整参考，用于调整行为。

配置是分层的：环境变量优先级最高，其次是项目配置文件，再次是全局配置文件，最后是内置默认值。

---

## 配置文件位置

配置从名为 `acp.json` 的 JSON 文件中读取。全局文件对所有项目生效；项目文件以**逐字段**方式覆盖全局文件（在项目文件中未设置的键仍然回退到全局值）。

| 范围 | 路径 | 生效范围 |
|------|------|----------|
| **全局** | `~/.pi/acp.json` | 本机所有项目 |
| **项目** | `<项目>/.pi/acp.json` | 仅当前项目（逐字段覆盖全局） |

> **优先级：** 环境变量 &gt; 项目文件 &gt; 全局文件 &gt; 内置默认值。

文件在会话启动时加载。缺失文件、格式错误的 JSON、未知键都会被静默忽略——扩展绝不会因为配置问题而无法启动。只有文档中列出的键会被读取，其余一律丢弃。

---

## 快速开始

创建 `~/.pi/acp.json`（或 `<项目>/.pi/acp.json`），放入你想修改的键即可。以下每个字段都是可选的——省略某个键则保持其默认值。

```json
{
  "debug": false,
  "autoUpdate": true,
  "modelContextLimit": 200000,
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000,

  "throttleRetry": {
    "enabled": true,
    "maxRetries": 10
  },

  "delegate": {
    "enabled": true,
    "displayUsage": "separate"
  },

  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000
  },

  "absorb": {
    "minToolTokens": 1000,
    "contextThresholdPct": 0,
    "excludeTools": ["read"]
  }
}
```

仅开启调试日志的最小配置：

```json
{
  "debug": true
}
```

覆盖内核压缩提示词规则的高级配置（需要风险确认）。只设置你想改的字段，其余继承内核默认值：

```json
{
  "prompts": {
    "compressPhilosophy": "我的压缩理念……",
    "howToCompressRules": "我的 tier-1 规则……",
    "tier2DistillRules": "我的 tier-2 蒸馏规则……",
    "tier3CondenseRules": "我的 tier-3 浓缩规则……"
  },
  "acknowledgePromptsRisk": true
}
```

---

## 参数总览

### 状态说明

| 状态 | 含义 |
|------|------|
| 🟢 **ACTIVE** | 完全支持、已文档化、推荐使用。 |

以下所有键当前均为 **ACTIVE**。

### 总览

**顶层键**

| 键 | 类型 | 默认值 | 状态 | 说明 |
|----|------|--------|------|------|
| `debug` | boolean | `false` | 🟢 ACTIVE | 开启日志中的详细调试事件。 |
| `autoUpdate` | boolean | `true` | 🟢 ACTIVE | 启动时检查 npm 并自动安装更新。 |
| `modelContextLimit` | number | *(自动)* | 🟢 ACTIVE | 覆盖上下文窗口大小（token 数）。 |
| `toolBashDefaultTimeout` | number | `60` | 🟢 ACTIVE | 模型省略 `timeout` 时注入 bash 工具的默认超时秒数。 |
| `toolOutputMaxBytes` | number | `200000` | 🟢 ACTIVE | 工具返回文本的硬性字节上限。 |
| `throttleRetry` | boolean \| object | `true` | 🟢 ACTIVE | 自动重试 provider 侧 token 限流错误（递进退避）。 |

**delegate 键**

| 键 | 类型 | 默认值 | 状态 | 说明 |
|----|------|--------|------|------|
| `delegate.enabled` | boolean | `true` | 🟢 ACTIVE | 启用 `acp_delegate` 工具及其系统提示部分。 |
| `delegate.displayUsage` | string | `"separate"` | 🟢 ACTIVE | 控制 delegate 子代理的 token 用量如何报回主会话。 |

**provider 限流重试键**

| 键 | 类型 | 默认值 | 状态 | 说明 |
|----|------|--------|------|------|
| `throttleRetry.enabled` | boolean | `true` | 🟢 ACTIVE | 启用 provider token 限流错误的自动重试。 |
| `throttleRetry.maxRetries` | number | `10` | 🟢 ACTIVE | 单个错误 episode 内 ACP 驱动重试的总预算。 |
| `throttleRetry.baseDelayMs` | number | `60000` | 🟢 ACTIVE | 首次递进 kick 前的等待毫秒数。 |
| `throttleRetry.maxDelayMs` | number | `300000` | 🟢 ACTIVE | 递进 kick 延迟上限。 |
| `throttleRetry.backoffMode` | string | `"exponential"` | 🟢 ACTIVE | 延迟递进方式：`"exponential"`（每次 kick ×2）或 `"fixed"`。 |

**compress 键**

| 键 | 类型 | 默认值 | 状态 | 说明 |
|----|------|--------|------|------|
| `compress.maxContextLimit` | number \| string | `"75%"` | 🟢 ACTIVE | 触发强制压缩 nudge 的上下文阈值。 |
| `compress.emergencyThresholdPercent` | number \| string | `"95%"` | 🟢 ACTIVE | 触发紧急截断的上下文阈值。 |
| `compress.nudgeGrowthTokens` | number | `50000` | 🟢 ACTIVE | 软压缩 nudge 的 token 增长步长。 |

**Absorb 键**

| 键 | 类型 | 默认值 | 状态 | 说明 |
|-----|------|--------|------|------|
| `absorb` | boolean \| object | `false` | 🟢 ACTIVE | `true` 以默认参数开启工具结果即时吸收;传对象可细调。 |
| `absorb.toolName` | string | `"absorb"` | 🟢 ACTIVE | 暴露给模型的 absorb 工具名。 |
| `absorb.minToolTokens` | number | `1000` | 🟢 ACTIVE | 低于该估算规模的工具结果不触发吸收提示。 |
| `absorb.contextThresholdPct` | number \| string | `0` | 🟢 ACTIVE | 仅当上下文占用达到该比例(`0.3` / `"30%"`)时提示;`0` 表示只看大小。 |
| `absorb.excludeTools` | string[] | `[]` | 🟢 ACTIVE | 永不参与吸收的工具名列表。 |

**prompts 键**

| 键 | 类型 | 默认值 | 状态 | 说明 |
|----|------|--------|------|------|
| `prompts` | object | *(内核默认)* | 🟢 ACTIVE | 覆盖 acp-kernel 的 4 条承重压缩提示词规则。每个设置的字段逐字替换默认值。 |
| `acknowledgePromptsRisk` | boolean | `false` | 🟢 ACTIVE | 必须为 `true`，`prompts` 覆盖才会生效；否则覆盖被丢弃、使用默认值。 |

**环境变量**

| 变量 | 效果 |
|------|------|
| `ACP_AUTO_UPDATE` | 设为 `0` / `false` 禁用自动更新（覆盖 `autoUpdate`）。 |
| `ACP_MODEL_CONTEXT_LIMIT` | 覆盖上下文窗口大小（优先级最高）。 |
| `ACP_DEBUG` | 设为 `1` / `true` 开启调试日志。 |
| `ACP_LOG_FILE` | 覆盖日志文件路径（默认 `~/.pi/acp.log`）。 |

> **只有文档中列出的键才会从 `acp.json` 读取。** 其他调优参数（`preserveRecentMessages`、`protectedTools`）是代码级别的，不开放给用户。三个压缩阈值构成三级递进：基于增长的软 nudge → 越过 `compress.maxContextLimit` 后的强制 nudge → 越过 `compress.emergencyThresholdPercent` 后的紧急截断。

---

## 通用

### `debug`

- **类型：** `boolean`
- **默认值：** `false`
- **状态：** 🟢 ACTIVE
- **说明：** 在日志文件（默认 `~/.pi/acp.log`）中开启详细的**调试级**事件。无论此设置如何，常驻日志（会话/轮次/压缩/delegate 生命周期事件，所有错误和警告）始终写入；`debug` 只添加额外的诊断信息，如完整字段转储和逐轮内部数据。也可通过环境变量 `ACP_DEBUG=1`（或 `ACP_DEBUG=true`）开启。

### `autoUpdate`

- **类型：** `boolean`
- **默认值：** `true`
- **状态：** 🟢 ACTIVE
- **说明：** Pi 启动时检查 npm 是否有更新版本的 `billion-context-pi` 并自动安装。设为 `false` 可避免启动时的所有网络请求。也可通过 `ACP_AUTO_UPDATE` 环境变量（`ACP_AUTO_UPDATE=0` 或 `ACP_AUTO_UPDATE=false`）禁用，该变量优先于此配置。

### `modelContextLimit`

- **类型：** `number`
- **默认值：** *(自动)* —— 每轮实时读取模型的 `contextWindow`
- **状态：** 🟢 ACTIVE
- **说明：** 覆盖上下文窗口大小（token 数）。默认每轮从活跃模型的 `ctx.model.contextWindow` 读取，切换模型时自动保持正确。在模型元数据可能不可用的测试或无头/非交互会话中，可设置显式值。环境变量 `ACP_MODEL_CONTEXT_LIMIT` 优先于此值。

### `toolBashDefaultTimeout`

- **类型：** `number`
- **默认值：** `60`
- **状态：** 🟢 ACTIVE
- **说明：** 当模型省略 `timeout` 参数时注入 `bash` 工具的超时秒数。Pi **没有**内置默认超时，因此若缺少此保护，模型忘记设置超时的命令可能会挂起数千秒。超时后模型被引导以更大的 `timeout` 重新运行。设为 `0` 可禁用此保护，恢复 Pi 的无限制行为。

### `toolOutputMaxBytes`

- **类型：** `number`
- **默认值：** `200000`
- **状态：** 🟢 ACTIVE
- **说明：** 通过 `tool_result` 钩子对工具返回文本施加的硬性字节上限（约 200KB，约 5000 行）。它拦截 Pi 自身上限无法覆盖的失控输出（例如 Pi 不做限制的工具）。触发上限时，超长文本会被头部截断，并附带提示告知模型如何查看完整输出。设小一些（如 `8192`）可收紧上下文预算，设为 `0` 则完全禁用。

---

## Absorb(工具即时压缩)

`absorb` 子对象开启**工具结果即时压缩**——面向小上下文场景(例如 1w–2w 窗口):此时常规的"到阈值再催促压缩"来不及,模型没有干活的空间。工具调用是上下文的最大消耗者;即时吸收让模型在每次大工具输出之后立刻把这笔开销还回去。

工作方式:

1. 当工具结果足够大(估算 ≥ `absorb.minToolTokens`)且未被排除/保护时,内核在其后追加一条强制的 `[ACP absorb]` 指令:要求模型立即调用 `absorb` 工具,带上该结果的 ref 和蒸馏摘要。
2. 吸收完成后,原来的工具调用+工具结果对在**后续轮次中被隐藏**;携带摘要的 `absorb` 调用成为持久记录。
3. `absorb` 调用本身是普通工具调用——之后仍可被常规压缩系统折叠进 block,两个机制彼此正交。

支持简写(同 `delegate`):`absorb: true` 以默认值开启;传对象可细调。

### `absorb.minToolTokens`

- **类型:** `number`
- **默认值:** `1000`
- **状态:** 🟢 ACTIVE
- **说明:** 估算低于该 token 数的工具结果不触发吸收提示。保持足够高,只让真正的大输出走蒸馏步骤。

### `absorb.contextThresholdPct`

- **类型:** `number | string`
- **默认值:** `0`
- **状态:** 🟢 ACTIVE
- **说明:** 仅当上下文占用达到窗口的该比例时(`0.3` 或 `"30%"`)才追加吸收提示。默认 `0` 表示只看大小——每个达标结果都立即吸收,这正是小上下文场景想要的。

### `absorb.excludeTools`

- **类型:** `string[]`
- **默认值:** `[]`
- **状态:** 🟢 ACTIVE
- **说明:** 永不参与吸收的工具名。ACP 自身工具的结果(`compress`、`decompress`、`search_context`、`acp_status` 等)与受保护工具始终自动排除。

---

## Delegate

`delegate` 子对象控制 `acp_delegate` 子代理工具族（`acp_delegate`、`acp_delegate_wait`、`acp_delegate_cancel`）及其 token 用量的报告方式。

> **向后兼容：** 为方便使用，`delegate` 同时接受对象和布尔简写：
> - `delegate: true` 等同于 `delegate: { enabled: true }`。
> - 遗留的顶层平铺 `displayUsage` 键仍被接受，作为 `delegate.displayUsage` 的别名。推荐使用嵌套形式 `delegate.displayUsage`。

### `delegate.enabled`

- **类型：** `boolean`
- **默认值：** `true`
- **状态：** 🟢 ACTIVE
- **说明：** 启用 `acp_delegate` 工具（`acp_delegate`、`acp_delegate_wait`、`acp_delegate_cancel`）及其对应的系统提示部分。设为 `false` 可完全跳过注册——例如你使用了其他子代理扩展，或者在无头环境下运行时异步结果注入没有意义。

### `delegate.displayUsage`

- **类型：** 字符串枚举 `"merged" | "separate"`
- **默认值：** `"separate"`
- **状态：** 🟢 ACTIVE
- **说明：** 控制 delegate 子代理的 token 用量如何报回主会话。`"separate"`（默认）将 delegate token 记入独立累加器——主会话总量保持干净，delegate 用量在 `acp_status` 中单独显示一块（不计入主总量）。`"merged"` 将 delegate token 用量并入工具返回的 `usage` 字段，算作主会话总量的一部分。仅在 `delegate.enabled` 为 `true` 时有意义。

---

## Provider 限流重试

`throttleRetry` 键控制对 **provider 侧 token 限流错误** 的自动重试——例如 AWS Bedrock 的每分钟 token 吞吐量配额，其标准报错文案是 `"Too many tokens, please wait before trying again."`。当 relay 把这个错误 JSON 塞进流式 content 并带上非标准 `finish_reason` 时，Pi 侧表现为 `Provider finish_reason: error_finish` 并立即失败：Pi 内置重试不认识这个特征，而且它绝不能被当成上下文超长处理。

工作方式：

1. turn 以被识别的限流错误结束时，ACP 改写错误信息，让 Pi 的 **原生重试** 重跑同一个 turn（不重复用户消息、错误不进 LLM 上下文、原生 TUI 重试指示器）。Pi 原生预算小且快（3 次、2s 起步）。
2. 如果一次 run 仍然以限流错误结束且 ACP 预算允许，ACP 等待 **递进延迟**（默认：60s、120s、240s……上限 5 分钟），然后发送一条带标记的用户消息（以 `[ACP:provider-throttle]` 开头）恢复被中断的步骤。
3. 模型会被提示从中断处继续（系统提示说明）。等待期间用户发送新输入会 **取消** 挂起的重试。预算用尽后，错误原样呈现给你。

> **不重试**（刻意留给 Pi 自身行为或直接失败）：真正的上下文超长错误（`prompt is too long` 等）、配额/计费耗尽（`quota exceeded`、`billing` 等）、以及通用 429。

> **严格节奏（可选）：** 默认 ACP 先让 Pi 原生快速重试跑，再自行递进等待。如果你只想用 ACP 的递进 kick（例如 tokens/分钟配额很紧），另外在 `~/.pi/settings.json` 里设 `"retry": { "enabled": false }` 关掉 Pi 自身重试。

### `throttleRetry`

- **类型：** `boolean | object`
- **默认值：** `true`（等价于全默认的 object 形式）
- **状态：** 🟢 ACTIVE
- **说明：** 启用/禁用 provider token 限流错误的自动重试，并调整其预算。`throttleRetry: false` 完全关闭该功能（恢复原始 fail-fast 行为）。object 形式（任意子集）：

```json
{
  "throttleRetry": {
    "enabled": true,
    "maxRetries": 10,
    "baseDelayMs": 60000,
    "maxDelayMs": 300000,
    "backoffMode": "exponential"
  }
}
```

### `throttleRetry.enabled`

- **类型：** `boolean`
- **默认值：** `true`
- **状态：** 🟢 ACTIVE
- **说明：** 开关。`false`（或顶层 `throttleRetry: false`）恢复原始 fail-fast 行为。

### `throttleRetry.maxRetries`

- **类型：** `number`（整数 ≥ 1）
- **默认值：** `10`
- **状态：** 🟢 ACTIVE
- **说明：** 单个错误 episode（一次以同一限流错误结束的 run + 它触发的递进 kick）内 ACP 驱动重试的总预算。任何一次成功的非错误响应——或新的用户消息——都会开启新 episode。用尽后错误原样呈现。

### `throttleRetry.baseDelayMs`

- **类型：** `number`（毫秒）
- **默认值：** `60000`
- **状态：** 🟢 ACTIVE
- **说明：** 首次递进 kick 前的等待毫秒数——按 Bedrock 分钟级滚动配额窗口设计。`maxDelayMs` 会被强制至少等于该值。

### `throttleRetry.maxDelayMs`

- **类型：** `number`（毫秒）
- **默认值：** `300000`
- **状态：** 🟢 ACTIVE
- **说明：** `"exponential"` 模式下递进 kick 的延迟上限（默认参数下为 60s → 120s → 240s → 300s → 300s……）。`"fixed"` 模式下忽略，始终使用 `baseDelayMs`。

### `throttleRetry.backoffMode`

- **类型：** 字符串枚举 `"exponential" | "fixed"`
- **默认值：** `"exponential"`
- **状态：** 🟢 ACTIVE
- **说明：** 递进 kick 之间的延迟递进方式：`"exponential"` 每次 kick 延迟翻倍（上限 `maxDelayMs`）；`"fixed"` 每次 kick 固定 `baseDelayMs`。

---

## 压缩调优

`compress` 子对象包含三个阈值，构成上下文管理的**三级递进**。它们控制模型*何时*被 nudge 压缩，以及大输出*何时*被强制截断以维持会话存活。阈值越低，扩展压缩得越早、越激进。

流程如下：

1. **基于增长的软 nudge**（0–75%）——由 `compress.nudgeGrowthTokens` 控制。
2. **强制 nudge**（75–95%）——当用量越过 `compress.maxContextLimit` 时，无论增长门控如何都会触发 nudge。此阶段无损。
3. **紧急截断**（95%+）——当用量越过 `compress.emergencyThresholdPercent` 时，截断大型工具输出以防止上下文溢出。此阶段有损。

### `compress.maxContextLimit`

- **类型：** `number | string`
- **默认值：** `0.75`（或 `"75%"`）
- **状态：** 🟢 ACTIVE
- **说明：** 触发**强制压缩** nudge 的上下文用量阈值。用量达到此水平后，每轮都会触发 nudge，绕过通常限制频率的增长门控和节奏检查。接受比例值（`0.75`）或百分比字符串（`"75%"`）。值越低，扩展压缩得越早、越激进。映射到内核设置 `nudge.maxContextLimitPct`。

### `compress.emergencyThresholdPercent`

- **类型：** `number | string`
- **默认值：** `0.95`（或 `"95%"`）
- **状态：** 🟢 ACTIVE
- **说明：** 触发**紧急截断**的上下文用量阈值——在上下文即将满时截断大型工具输出以维持会话存活。接受比例值（`0.95`）或百分比字符串（`"95%"`）。此值**必须大于等于** `compress.maxContextLimit`，否则递进顺序会被破坏。映射到内核设置 `nudge.emergencyThresholdPct` 和 `truncate.threshold`。

### `compress.nudgeGrowthTokens`

- **类型：** `number`
- **默认值：** `50000`
- **状态：** 🟢 ACTIVE
- **说明：** 控制**软**压缩 nudge 频率的 token 增长阈值。每当积累约这么多新可压缩内容时，触发一次软 nudge。值越低模型被 nudge 压缩的频率越高；值越低频率越低。此设置只控制*基于增长的* nudge——用量越过 `compress.maxContextLimit` 后，强制 nudge 接管，不受此设置影响。映射到内核设置 `nudge.growthFloor` 和 `nudge.growthCap`。

### `compress.providers` —— 按 provider / 按 model 覆盖

- **类型：** object —— provider 名 → `{ ...<compress 字段>, models: { modelId → <compress 字段> } }` 的映射
- **默认值：** *(未设置——全局 `compress.*` 对所有模型生效)*
- **状态：** 🟢 ACTIVE
- **说明：** 为某个特定的 Pi **provider** 和/或某个特定的 **model** 收窄全局阈值,每轮根据当前模型实时解析。三级**逐字段、深层优先**级联:`model > provider > global`。深层中未设置的字段**不会**清除浅层的值——只有你显式设置的字段才会覆盖。未知的 provider/model 回退到全局阈值。

provider 的 key 是 **Pi provider 名**(如 `"anthropic"`、`"openai"`、`"zhipu"`)——即 `models.json` 和 `pi --provider` 使用的同一个名字。model 的 key 是 **model id**(`ctx.model.id`)。适配器工作在 Pi 的模型层,看不到 upstream URL,因此按**名字**匹配 provider,而不是像 billion-context 代理那样按 URL 前缀匹配。

```json
{
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000,
    "providers": {
      "anthropic": {
        "maxContextLimit": "80%",
        "models": {
          "claude-sonnet-4-5": { "maxContextLimit": "70%", "nudgeGrowthTokens": 30000 }
        }
      }
    }
  }
}
```

在 `anthropic` / `claude-sonnet-4-5` 下,生效阈值变为 `maxContextLimit=70%`、`nudgeGrowthTokens=30000`、`emergencyThresholdPercent=95%`(继承自全局)。

---

## 提示词自定义

`prompts` 对象覆盖 acp-kernel 的**承重**压缩提示词规则——即模型收到的关于*如何*写摘要的逐字指令（保留完整文件路径、函数签名、决策与理由；丢弃冗长日志等）。这四个字段被嵌入系统提示词和压缩 nudge 文本：

| 字段 | 控制内容 |
|------|----------|
| `compressPhilosophy` | 要避免的两种失败模式（过度/不足压缩），以及何时压缩的唯一判据。 |
| `howToCompressRules` | Tier-1 规则：哪些内容需逐字保留、哪些需丢弃，以及摘要优先级顺序。 |
| `tier2DistillRules` | Tier-2 蒸馏规则（仅决策/结果）。 |
| `tier3CondenseRules` | Tier-3 超级浓缩规则（仅核心事实）。 |

> ⚠️ **质量风险。** 这些规则是为检索质量调优的。用更宽松的文本替换它们会悄无声息地降低摘要质量——丢失路径、签名和决策会导致后续重建变差。`acknowledgePromptsRisk` 门禁的存在，是为了让这成为一个明确、深思熟虑的选择。

### `prompts`

- **类型：** `object`（部分覆盖——省略字段则保持其默认值）
- **默认值：** *(内核默认)* —— acp-kernel 内置的逐字规则
- **状态：** 🟢 ACTIVE
- **说明：** 覆盖四个压缩提示词字段中的一个或多个。你设置的每个字段**逐字**替换内核默认值；省略的字段原样继承。非字符串值会被静默丢弃（只有明确的字符串覆盖才生效）。需要 `acknowledgePromptsRisk: true`——否则所有覆盖被丢弃并使用默认值，同时记录一条警告。示例：

  ```json
  {
    "prompts": {
      "compressPhilosophy": "激进压缩；优先保留信号而非完整性。",
      "howToCompressRules": "逐字保留文件路径+签名。丢弃冗长日志。",
      "tier2DistillRules": "仅决策与结果；丢弃过程和路径。",
      "tier3CondenseRules": "每个块一行：仅核心事实。"
    },
    "acknowledgePromptsRisk": true
  }
  ```

### `acknowledgePromptsRisk`

- **类型：** `boolean`
- **默认值：** `false`
- **状态：** 🟢 ACTIVE
- **说明：** `prompts` 覆盖的安全门禁。设为 `true` 以确认替换内核调优的压缩规则可能降低摘要质量，并使你的 `prompts` 覆盖生效。为 `false`（或省略）时，所有 `prompts` 覆盖被忽略，使用内核默认值。如果 `resolvePrompts` 拒绝了你的覆盖（例如某个仍通过类型检查的畸形值），扩展会回退到默认值并记录 `prompts-resolve-failed` 警告，而不是启动失败。

---

## 环境变量

环境变量优先于 JSON 配置文件。适用于一次性覆盖、CI 运行，以及不想编辑配置文件的无头会话。

### `ACP_AUTO_UPDATE`

- **类型：** 字符串标志
- **默认值：** *(未设置——自动更新遵循 `autoUpdate` 配置)*
- **状态：** 🟢 ACTIVE
- **说明：** 设为 `0` 或 `false` 可**禁用**自动更新（等效于 `"autoUpdate": false`）。不设置则遵循配置。这是在不修改 `acp.json` 的情况下禁用启动网络请求的推荐方式，适用于受限环境。

### `ACP_MODEL_CONTEXT_LIMIT`

- **类型：** 整数（token 数）
- **默认值：** *(未设置——窗口大小遵循 `modelContextLimit`，再回退到实时模型上下文窗口)*
- **状态：** 🟢 ACTIVE
- **说明：** 覆盖上下文窗口大小（token 数）。**优先级最高**——覆盖 `modelContextLimit` 配置值。适用于在模型元数据不可用或不可靠的测试框架和无头运行中强制指定窗口大小。

### `ACP_DEBUG`

- **类型：** 字符串标志
- **默认值：** *(未设置——调试日志遵循 `debug` 配置)*
- **状态：** 🟢 ACTIVE
- **说明：** 设为 `1` 或 `true` 开启调试级日志。等效于配置中设 `"debug": true`，但无需编辑文件。常驻的生命周期/错误/警告事件无论此设置如何都会写入。

### `ACP_LOG_FILE`

- **类型：** 字符串（文件路径）
- **默认值：** `~/.pi/acp.log`
- **状态：** 🟢 ACTIVE
- **说明：** 覆盖日志文件路径。默认情况下，结构化日志写入 `~/.pi/acp.log`（文件在 10MB 时轮转为 `~/.pi/acp.log.old`）。指向不同位置可为每个项目或每次运行保留独立日志。
