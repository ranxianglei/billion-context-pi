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

  "delegate": {
    "enabled": true,
    "displayUsage": "separate"
  },

  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000
  }
}
```

仅开启调试日志的最小配置：

```json
{
  "debug": true
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

**delegate 键**

| 键 | 类型 | 默认值 | 状态 | 说明 |
|----|------|--------|------|------|
| `delegate.enabled` | boolean | `true` | 🟢 ACTIVE | 启用 `acp_delegate` 工具及其系统提示部分。 |
| `delegate.displayUsage` | string | `"separate"` | 🟢 ACTIVE | 控制 delegate 子代理的 token 用量如何报回主会话。 |

**compress 键**

| 键 | 类型 | 默认值 | 状态 | 说明 |
|----|------|--------|------|------|
| `compress.maxContextLimit` | number \| string | `"75%"` | 🟢 ACTIVE | 触发强制压缩 nudge 的上下文阈值。 |
| `compress.emergencyThresholdPercent` | number \| string | `"95%"` | 🟢 ACTIVE | 触发紧急截断的上下文阈值。 |
| `compress.nudgeGrowthTokens` | number | `50000` | 🟢 ACTIVE | 软压缩 nudge 的 token 增长步长。 |

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
