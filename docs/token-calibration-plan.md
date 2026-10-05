# Token Calibration — 让 pending 计算对齐 provider 真实 token

> 分支：`feat/token-calibration`（worktree: `/Users/yintianan/GitHub/billion-context-pi-wt2`）
> 状态：**已实现 + 真实会话验证**（Phase 1/2 + §11 快照化，详见 §10/§11）
> 注（#612）：本文引用的 `src/delegate-tool.ts` 已随 delegate 子系统拆分至 [billion-context-pi-subagents](https://github.com/ranxianglei/billion-context-pi-subagents)，文中行号为拆分前快照。
> 实测环境：**DeepSeek V4-Flash**（1M 窗口）。其 tokenizer 中英文密度差异大
> （官方：1 英文字符 ≈ 0.3 token、1 中文字符 ≈ 0.6 token，中文密度为英文 2 倍；
> 实测 1 汉字 ≈ 1.2-1.3 token），chars/4 估算对中文内容严重低估 —— 本方案的
> 校准系数正是为此而设。

---

## 0. TL;DR（大白话，先看这个）

### 要解决的问题

系统"以为"的上下文大小，和实际花的 token 数对不上。
压缩提示靠 `chars/4` 估算 token（1 字符 = 0.25 token）——对英文大致行，但**中文
1 字符实际 ≈ 1 token，被低估 2-4 倍**。后果：上下文已占窗口 18%，系统却觉得
"才 4 万，没到 5 万阈值"**一直不提示压缩**。就像体重秤显示 60 公斤、实际 90 公斤。

### 为什么不能直接看 provider 的真实数字

1. provider 只给**总数**（"这轮 18 万 token"），不给分类——不知道里面哪些是旧
   工具输出（可压缩）、哪些是刚说的几句话（要保护）
2. 压缩提示必须在**发请求之前**决定（要写进请求里），而真实数字是请求**之后**
   才知道的
3. 压缩动作会让总数瞬间暴跌，拿它当"增长量"会误判

所以必须自己估算每个部分，再用真实总数**校准**估算误差。

### 修改方案（三个阶段）

- **Phase 1（内核，acp-kernel）**：把写死的 `chars/4` 换成可注入的 token 计数器，
  让"可压缩量"计算用上准确的中文感知算法
- **Phase 2（适配器，billion-context-pi）**：密度校准器——每轮用"真实增量 ÷ 估算
  增量"算当前会话的换算系数（density）乘到估算上。中文多的会话系数自动变高，
  英文少的变低，完全自适应
- **§11（标签快照化）**：修衍生 bug——校准期 density 每轮变 → 消息 `<acp>` 标签
  数字每轮重算 → 缓存前缀变 → 整条缓存反复失效（界面反复"缓存重建"）。方案：
  标签数字在消息**首次出现时定死存入 state**，之后永不重算

### 现状

已实现 + 真实会话验证通过（nudge 正常触发、density 收敛、缓存重建待 kernel 发布后修复）。
关联 PR：acp-kernel [#51](https://github.com/ranxianglei/acp-kernel/pull/51)、
billion-context-pi [#97](https://github.com/ranxianglei/billion-context-pi/pull/97)。

---

## 1. 问题

nudge 触发判断（`decideNudge` 的 `pendingByTier`）依赖可压缩范围的 token 数，
但内核里存在**三处口径分裂**，导致系统判断的"可压缩量"与用户看到的 footer（provider
真实 usage）严重不符：

| 位置 | 算法 | 问题 |
|---|---|---|
| `buildCompressibleRanges` → `estimateMessageTokens`（T1 pending 源头） | `Math.ceil(len/4)` 纯 chars/4 | **中文 1 字符 ≈ 1 token 被算成 0.25**，低估 2-4 倍 |
| `pendingByTier` 的 T2/T3（summary tokens） | 注入的 `countTokens`（CJK-aware ✓） | 与 T1 不一致 |
| `tokenCount`（usage/growth/emergency/footer） | provider 真实 usage（含 system+schema） | 与 pending 完全不同世界 |

**实测现象**（本会话，DeepSeek V4-Flash）：
- ACP 判定：`Nudge: idle — max compressible 40226 < threshold 50000`
- footer 显示：18.1%（provider total ≈ 181K）
- 触发 nudge 时（50K 阈值）：provider total 已达 122K（≈12%）

也就是说：系统认为"才 40K 可压缩，没到 50K"而保持静默，但真实上下文已经 18%、
远超模型甜点区间（Flash ≤128K）。**系统量小了，所以没报警。**

## 1.5 根因（为什么会出现口径分裂）

三条 token 口径在 acp-kernel 里由三个**独立实现**提供，从未被强制统一：

1. **T1 pending 走 `buildCompressibleRanges` → `estimateMessageTokens`（纯 chars/4）**——最简化实现，
   模块级函数，不接收任何注入；
2. **T2/T3 走注入的 `countTokens`（CJK-aware）**——`createCore(ports)` 的 countTokens 注入机制
   （→ ctx.countTokens）早已存在，且 `nudgeNode` 在用；
3. **tokenCount 走 provider 真实 usage**——adapter 层的选择（`src/index.ts:112-114`）。

**关键事实：注入机制早就有了（T2/T3 在用），但 T1 的路径（`buildCompressibleRanges` /
`computeProtectedRefs`）从未接入它，一直用写死的 chars/4。** 这是历史实现未统一的结果，
不是刻意设计——同一个会话里 T1 与 T2/T3 对同一条中文文本会给出不同 token 数。

## 2. 为什么不能直接用 provider 值算 pending

> 【问题由用户提出（2026-08）："为什么不能一开始就从 provider 拿，非要自己算系数？"】

provider 只给**总数**（如"本次请求 181K"），不提供分类：
- 哪些是旧工具输出（可压缩）
- 哪些是最近 5 条消息（保护区）
- 哪些已压缩进块（不计 pending）
- 哪些是 system prompt（永不压缩）

nudge 需要的是**"可压缩子集之和"**，这是分类求和，只有本地知道。
且 provider usage 是**上一轮**的结算值（pi 源码注释："After compaction, the last
assistant usage reflects pre-compaction context size"），压缩后瞬间会失真。
因此：本地估算 + provider 校准系数 = 正确解法。

## 3. 方案：双层校准

### 3.1 第一层（kernel）— `estimateMessageTokens` 改用注入的 countTokens

```js
// 现状（buildCompressibleRanges 内）：
tokens: estimateMessageTokens(msg)          // Math.ceil(len/4)，中文不处理

// 改为：使用注入的 countTokens（默认回落 CJK-aware 的 defaultCountTokens）
tokens: countTokens(msg.text ?? "")
```
- `buildCompressibleRanges` 增加 `countTokens` 参数，`recommendNode` 从 `ctx.countTokens` 传入
- 消除最大的低估源（中文）

### 3.2 第二层（adapter）— 注入"密度校准版" countTokens

新增 `src/density.ts`，维护实时密度系数 `density`：

```
每轮 context 事件：
  if (postCompressionSkip):                     // 压缩后第一轮跳过（D7/F1）
    postCompressionSkip = false
    anchorReal = realTotal; anchorEst = estTotal // 在干净的压缩后基准上重新锚定
    pendingDensity = null; confirmCount = 0      // 丢弃压缩前窗口的 pending 确认
    return
  Δreal = realTotal - anchorReal                // provider 累计真实增量（同窗口）
  Δest  = estTotal - anchorEst                  // 估算累计增量（同窗口）
  if (Δest >= 50):                              // 最小增量阈值，防微消息比值抖动
    instantDensity = clamp(Δreal / Δest, 0.5, 2.5)
    density = instantDensity                    // 全量比值，无 EMA 滞后
    anchorReal = realTotal; anchorEst = estTotal // 推进锚点
```

> 实现注（2026-08-16）：重新锚定放在**跳过轮**（压缩后第二轮）而非
> postCompression 轮本身——后者读到的 provider usage 可能还是压缩前的体积。
> 若不重锚，压缩前的锚点会阻断重采样直到 est 涨回压缩前水平（长死区），
> 跨界首个样本还可能被 clamp 成离群值（见 tests/density.test.ts 回归用例）。

然后 `createCore({ countTokens: (text) => defaultCountTokens(text) × density })`。

**为什么用累积锚点法而非 EMA**（评审 D1/D2）：EMA 的 α=0.15 在语言切换
（如中文 1.6 → 英文 0.8）后需 ~20 轮才收敛，期间持续高估 pending；且 Δreal/Δest
存在 off-by-one 时间错位（realUsage 是上一轮 provider 返回值，estimate 是本轮），
工具密集轮会产生虚假尖峰。累积锚点法取同一时间窗口的累计增量，天然对齐、
无滞后、无 α 参数。**推荐加固**（评审 C1）：连续 2 轮比值在 ±20% 内才采纳
（一个 pendingDensity + 确认计数器，成本极低），防单轮异常污染锚点；不影响
收敛速度（正常情况 2 轮确认 = 1 轮延迟）。

**为什么用相邻差值而非绝对比值**：provider 总量含 ~24K system+schema 固定开销，
直接除会污染系数；相邻两轮差值自动消掉固定开销，得到纯"消息真实 token / 估算 token"密度。
本会话实测密度 ≈ 1.6-1.8（中文为主）。

### 3.3 第三层 — 决策与显示层对齐（含 usage 校准）

`compress-tool.ts` 的 `beforeTokens` 与 status breakdown 已用 `defaultCountTokens`
（CJK-aware），统一改走注入的校准 countTokens，让**模型看到的数字、footer、nudge
判断全部同口径**。

**usage/emergency 仲裁同乘 density（实现注 2026-08-16，新增）**：四个 processTurn
调用点（context transform / compress / acp_status / /acp panel）的 `tokenCount` 一律
`rawSentTokens × density`（`calibrateTokens`）。原因：`decideNudge` 的
`usage = tokenCount / limit` 直接驱动 75% 强制 nudge 与 95% emergency truncate，
若用未校准的 CJK-aware 估算，CJK 会话（real/est ≈ 1.2-1.6）会在真实占用
已超窗后安全阀才动作。注意**估计器样本仍喂 RAW sentTokens**——样本若也乘
density，density 会追逐自己的校准值发散。回归测试：
tests/density-usage-fixes.test.ts。

## 4. 系数收敛（无预热期）

> 【洞察由用户提出（2026-08）："系数其实在第一轮甚至第二轮对话就能开始算了"】

关键洞察：**系数从第二轮就开始校准，不需要等压缩事件**。

| 轮次 | 锚点 | 系数 |
|---|---|---|
| 第 1 轮 | 无 provider usage（纯估算） | 初始 1 |
| 第 1 轮响应后 | 拿到第一个真实 usage 锚点 | — |
| 第 2 轮起 | Δreal/Δest 可算，每轮喂样本 | 每轮更新，快速收敛 |
| 压缩那一轮 | Δest 为负 | 跳过（唯一例外） |

到真正触发 nudge 时（可压缩积累到阈值，通常几十轮后），系数早已被几十个样本校准稳定。
规则：`if (Δest >= 50) 更新 else 跳过`（Δest 为负的压缩轮自然被跳过）。

## 5. 边界与风险

1. **压缩瞬间 Δest 为负** → `Δest >= 50` 门槛自然跳过；压缩后第一轮正增长可能含残余
   realUsage（provider 在压缩前返回），压缩后设置 flag 再跳过一轮（评审 D7）。
   **检测方式（实现注 2026-08-16）**：block 由 compress 工具在两次 context 事件**之间**
   创建（`processTurn` 从不创建 block），因此不能靠单次 processTurn 的输入/输出 state
   比较检测——实现为 runtime 按 session 记录上一轮 active block id 集
   （`noteActiveBlocks`），本轮加载 state 出现新 active block 即置 flag。
2. **会话开始无 realUsage** → density 初始 1，第二轮起自然收敛
3. **模型/窗口切换** → `session_start` 重置 density（runtime 已有 `clearNudgeTracking`）。
   **mid-session 模型切换**（如 A 模型 → B 模型）：不同 tokenizer 的 CJK 密度差异巨大
   （DeepSeek 1.2 vs GPT-4 0.7 vs Claude 0.5），且不同 provider 的 usage 统计口径不同
   （thinking/cache tokens 是否单列），切换后 density 应重新收敛（评审 D6）。
   **实现注（2026-08-16）**：实现为 per-model 隔离（切换模型即使用目标模型自己的
   条目，新模型从 1 开始收敛，不会跨模型污染）+ 仅 `session_start` 重置当前模型；
   未监听 mid-session 切换事件——A→B→A 回切会复用 A 的旧条目，约 2 个采样轮后
   被 C1 双轮确认机制重新校准，代价可接受，不做额外监听。
4. **per-model 存储** → density 不能是 runtime 全局单值，应为 `Map<modelId, number>`
   （同一个 provider 下有多个模型时各算各的）；并行 session 也要隔离，key 到
   `sessionId × modelId` 粒度（评审 D5）
5. **density clamp [0.5, 2.5]** → 上界从 4 收紧：没有自然语言能达到 4 token/char，
   即使 CJK+emoji 混合也不超过 2.5；下界 0.5 给纯英文留余量（评审 D3）
6. **最小 Δest 阈值 = 50** → 微消息（1-2 字符）的比值极不稳定（评审 D4）
7. **T2/T3 同乘 density（实现注 2026-08-16，替代原"不受影响"结论）** → 注入的
   countTokens 是 kernel 内部唯一计数器，T2/T3 的 summary pending 也随 density 放大。
   影响小（summary 短；CJK 摘要被放大更接近真实占用），且方向正确，**保持实现现状**；
   如需严格按原规格隔离 T2/T3，需 kernel 侧拆分计数器（未做）。
8. **密度不持久化（已知行为）** → density 存内存 Map，Pi 重启后回 1；冷启动
   第 1 轮低估 ~40%，2-3 轮后自动收敛（评审 B1）。不做持久化：收敛快、
   `*.acp.json` 格式改动需向后兼容、冷启动不差于现状（chars/4 本就是当前行为）
9. **provider 连续缺失 realUsage** → 锚点冻结，恢复后累积窗口自动拉长，分子分母
   同比例，比值仍正确。无需"超时重置"逻辑（评审 A1）
## 6. 验证方式

1. 单测：构造中英混合消息，断言 pending = countTokens 口径而非 chars/4
2. 密度模块单测：喂模拟 usage 序列，验证锚点法收敛 + clamp [0.5,2.5] + 最小 Δest 门槛 +
   负增量跳过 + 模型切换重置
3. 集成：本会话复现 —— 方案后 `acp_status` 的 max compressible ≈ 64K（≥50K，nudge 触发），
   与 footer 18% 口径自洽

## 7. 预期效果

| 指标 | 现在 | 方案后 |
|---|---|---|
| 可压缩 pending（同内容） | 40.2K（chars/4） | 40.2K × ~1.6 ≈ 64K |
| 50K 阈值触发点（footer 真实值） | ~122K（12%） | ~104K（10%） |
| 触发频率 | 偏晚 | 提前 ~20%，回到 Flash 甜点 |

## 8. 代码事实核实（研究结论，2026-08 已确认）

### 内核侧（node_modules/acp-kernel/dist/index.js）

1. **`estimateMessageTokens`（:805）= `Math.ceil((text?.length ?? 0) / 4)`** 纯 chars/4，3 处调用：
   - :828 `computeProtectedRefs`（保护区 token 累计）
   - :866/:877 `buildCompressibleRanges`（compressible + protected ranges 的 tokens）
2. **`buildCompressibleRanges(messages, state, config, protectedZoneRefs)`（:853）** — 不接收 countTokens，内部写死 estimateMessageTokens
3. **`recommendNode.run`（:1188）** 调用 computeProtectedRefs + buildCompressibleRanges，**均未传 ctx.countTokens**
4. **`decideNudge`（:1495）** 已接收 `countTokens` 参数（由 `nudgeNode.run` :1214-1221 从 `ctx.countTokens` 传入）
5. **`pendingByTier`（:1484）**：T1 pending = `compressible.reduce((s,r) => s + r.tokens, 0)`（chars/4 口径）；T2/T3 = `countTokens(b.summary)`（注入口径）→ **T1 与 T2/T3 口径不一致，确认问题**
6. **`createCore(ports)`（:962）**：`const countTokens = ports.countTokens ?? defaultCountTokens`，放入 ctx（:125-128），所有 node 可经 `ctx.countTokens` 访问
7. `defaultCountTokens` = CJK-aware：`cjkCount + Math.ceil((len - cjkCount)/4)`（中文 1 字 = 1 token）

### adapter 侧（src/）

1. **`src/runtime.ts` :34** — `createCore({ countTokens: defaultCountTokens })` ← 注入点，改为校准版
2. **`src/index.ts` `wireContextTransform`** — context 事件内已有 `realUsage = ctx.getContextUsage?.()` 和 `estimated = estimateTokens(coreMessages, coveredIds)`（:112-113），tokenCount 优先 realUsage（:114）。**density 更新接入点就在此处**
3. **`src/tokens.ts` `estimateTokens`** — 与 kernel `defaultCountTokens` 一致（CJK-aware），跳过 compress 工具调用 + covered 消息
4. **`src/compress-tool.ts` :57** — `beforeTokens = estimateTokens(...)` 已 CJK-aware

### 修正后的实施清单

**kernel 改动（acp-kernel，上游仓库）**：
- `buildCompressibleRanges` 加 `countTokens` 参数，内部 `estimateMessageTokens(msg)` → `countTokens(msg.text ?? "")`
- `computeProtectedRefs` 同样改用 countTokens（保护区 token 累计也应校准，否则 preserveRecentTokens 语义随密度漂移）
- `recommendNode.run` 传 `ctx.countTokens` 给两处
- 或者更简单：把 `estimateMessageTokens` 的实现直接改成 `countTokens` 语义（但它是模块级函数，无 ctx 访问权，需传参）
- **更新测试断言**（F3）：acp-kernel 45 个测试中凡断言 pending/token 数值的用例，从 chars/4 口径改为 CJK-aware 口径（否则 Phase 1 PR 的 CI 会红灯）

**adapter 改动（本仓库）**（⚠️ **依赖 Phase 1 已发布**：若 density 在 kernel chars/4 未修时上线，
Δest 用 chars/4 低基线 → density ≈ 4.8 被 clamp 到 2.5 → 中文注入 2.5 tok/char 高估 2×。
必须 kernel 先发版，Δest 才是 CJK-aware 口径，density 才收敛到 ~1.2 的正确值。评审 B2）：
- 新建 `src/density.ts`：累积锚点密度估计器（Δreal/Δest 同窗口、clamp [0.5,2.5]、
  最小 Δest=50 门槛、压缩后跳过一轮、per-model Map 存储、模型切换重置）
- `src/runtime.ts`：`createCore({ countTokens: (t) => defaultCountTokens(t) × density })`
- `src/index.ts` context 事件：更新 density（每轮）；tokenCount 逻辑不变
- `src/compress-tool.ts` / `src/status-tool.ts`：beforeTokens/breakdown 统一走校准口径（可选，显示层）

### 待确认问题（实现阶段）

- [x] **已决定**：累积锚点法采用"连续 2 轮 ±20% 才采纳"加固（C1 推荐实现，§3.2）
- [x] **已决定**：`acp_status` breakdown **不乘** density——status 显示 kernel 口径（调试视角），
      footer 已显示 provider 真实值，用户有对照
- [x] **已决定（2026-08-16 修订）**：T2/T3 pending **随** density 放大（注入计数器
  是 kernel 内部唯一计数器，未拆分）——原"不乘"结论与实现不符，现以实现为准，
  见 §5.7
- [x] **已验证**：`computeProtectedRefs` 的 preserveRecentTokens 改用 countTokens 后，保护区大小变化**影响存在但可控，且是正确方向**——中文消息的保护区物理大小变小（1 字符 ≈ 1 token 而非 0.25），`preserveRecentTokens` 现在保护"最近 N 真实 token"而非"最近 N 字符/4 估算"；`preserveRecentMessages` 作为消息数兜底仍有效（至少保护最近 N 条消息）；nudge 因可压缩范围变大而略微提前，正是校准目的。测试见 `tests/recommend.test.ts` 第 3 例（computeProtectedRefs 注入 countTokens 撑大保护区）。结论：校准后的正确语义，非回归。
- [x] **已确认**：runtime 拿 modelId 用 `ctx.model.id`（`src/delegate-tool.ts:562`，完整标识符）

## 9. 问题溯源（哪些关键问题由用户提出）

以下关键问题/洞察均由用户提出，推动并塑形了本方案。
**实测环境：DeepSeek V4-Flash（1M 窗口）**，其 tokenizer 中英文密度差异大
（官方 1 英文字符 ≈ 0.3 token vs 1 中文字符 ≈ 0.6 token；实测 1 汉字 ≈ 1.2-1.3 token），
是本方案校准系数的直接动因。

1. **质疑触发时上下文比估算大**（2026-08）：用户观察实际触发时上下文比初版估算大很多，
   要求看当前对话实测 → 暴露了三处口径分裂，是本方案研究的起点。
2. **"为什么不能一开始就从 provider 拿？"**（2026-08）：用户问为什么不能直接用 provider
   真实值而非自算系数 → 澄清了"provider 只给总数、分类求和只能本地算"（§2）。
3. **"系数其实第一轮、第二轮就能开始算了"**（2026-08）：用户指出校准无需等压缩事件，
   第二轮起每轮都能喂样本 → 消除了"预热期"设计（§4）。
4. **"把根因写上，文档里我的问题要注明"**（2026-08）：要求根因显式化 + 问题归属标注
   （本修订）。
5. **"中英文 chars/token 比例不同模型差异大"**（2026-08）：用户指出不同模型 tokenizer
   密度差异（DeepSeek 1.2 vs GPT-4 0.7 vs Claude 0.5），差值法虽自适应，但需 per-model
   存储 + 切换重置 → 补充 §5.3/§5.4（本修订）。

## 10. 独立评审记录（MiMo-V2.5-Pro，2026-08）

评审结论：**有条件通过**。方案方向正确，差值法原理成立，但发现 3 个中风险缺陷 + 4 个
低风险加固项，均已纳入本方案：

| # | 缺陷 | 处置 |
|---|------|------|
| D1 | Δreal/Δest 时间错位（off-by-one），工具密集轮虚高 | §3.2 改用累积锚点法 |
| D2 | EMA α=0.15 粘滞，语言切换 ~20 轮才收敛 | §3.2 锚点法无 α 参数 |
| D3 | clamp 上界 4 过宽 | §5.5 收紧 [0.5, 2.5] |
| D4 | 无最小 Δest 阈值 | §5.6 加 ≥50 门槛 |
| D5 | 并行 session 共享 density | §5.4 per-session×model 存储 |
| D6 | mid-session 模型切换不重置 | §5.3 监听 model 变化重置 |
| D7 | 压缩后第一轮正增长含残余 usage | §5.1 压缩后 flag 跳过一轮 |

评审还建议：**Phase 1（kernel 修复）独立先行**——仅把 `buildCompressibleRanges` 改用
CJK-aware countTokens 就解决 80% 问题（0.25 → 1.0 tok/char，改善 4 倍），零风险可独立
PR；density 系数只是校准残余 ~20% 误差。实施顺序：Phase 1 kernel → Phase 2 adapter
density → Phase 3 显示层。完整评审见 `/tmp/token-calibration-review.md`。

### 第二轮评审（MiMo-V2.5-Pro，2026-08）

结论：**可进入实现阶段**。D1-D7 修订全部到位；`ctx.model.id` 确认可拿模型标识
（`src/delegate-tool.ts:562`）；新增 2 项补救（已纳入 §5/§8）：
- **B1（高）** 密度不持久化，重启回 1 → §5.8 声明为已知行为（收敛 2-3 轮，不做持久化）
- **B2（中）** Phase 2 依赖 Phase 1 先行 → §8 标注：chars/4 未修时 density 会被低基线
  污染（≈4.8 被 clamp 到 2.5，中文高估 2×）
- 建议项：§3.2 ±20% 连续 2 轮确认从可选升为推荐（C1）
完整评审见 `/tmp/token-calibration-review-2.md`。

### 第三轮终审（MiMo-V2.5-Pro，2026-08）

结论：**有条件通过 → 修复 F1/F2 后方案冻结**。核心设计（双层校准 + 累积锚点法 +
per-model 隔离）自洽且可实现。B1/B2/C1 补救到位；D1-D7 全部验证通过。
终审发现 2 处文档内部矛盾（非设计缺陷），已修复：
- **F1（高）** §3.2 算法规范缺 post-compression flag（与 §5.1/D7 描述不一致）→ 伪代码已加
  `if (postCompressionSkip) skip` 逻辑
- **F2（中）** §8 待确认列表与正文矛盾（±20% 推荐 vs 可选、T2/T3 定论 vs 待确认）→ 已对齐，
  已决定项标注 [x]
- 建议项：F3 kernel 测试断言同步更新（已入 §8 清单）
额外确认：density 的 estTotal 来自 adapter `estimateTokens`（本就 CJK-aware），B2 的
发布顺序约束是预防性保障而非运行时崩溃风险；F4/F5/F6 均验证无阻塞。
完整评审见 `/tmp/token-calibration-review-3.md`。

### 第四轮终审复核（MiMo-V2.5-Pro，2026-08）

结论：**✅ 方案正式冻结，Phase 1 可启动**。
- F1（postCompressionSkip flag 入算法规范）✅ 通过——伪代码第 2 行检查、置位/复位时机正确
- F2（§8 与正文对齐）✅ 通过——无残留矛盾，唯一开放项合理标记为实现阶段验证
- F3（测试断言更新说明）✅ 通过——可执行
- 仅 1 个小瑕疵 G1（§3.2 重复行）已清理；文档可直接作为实现规格书
完整评审见 `/tmp/token-calibration-review-4.md`。

## 10. 实测观察（Phase 1/2 实现后，真实会话验证，2026-08）

实现与部署完成后，在真实会话（deepseek-v4-flash，1M 窗口）中开启 debug 日志
（`~/.pi/acp-debug.log`，`~/.pi/acp.json` 设 `{ "debug": true }`）观察到的行为。

### 10.1 Phase 1 生效：nudge 从"永不触发"变"正常触发"

旧实现（chars/4 口径）下同一批中文消息 T1 compressible 仅 ~14K，**永远达不到 50K 阈值**，
nudge 从不触发——这正是要修的问题。Phase 1（CJK-aware countTokens 注入）后：

```
[processTurn] nudgeReason=T1 compressible 59725 >= 50000, growth 70660, usage 14% nudgeVoice=gentle nudgeTier=1
```

校准后 T1 峰值可达 101K（×density），真实反映中文会话的上下文压力。

### 10.2 density 收敛过程（真实数据）

- 会话开始 density=1（session_start reset）；首轮建立锚点不采样
- 采样轮 instant 序列（相邻轮 Δreal/Δest）：`10.5（Δest=204 噪声，clamp 2.5）→ 1.44 → 1.58 → 1.07 → 1.03 → 1.21`
- 异常轮（10.5）被 C1 拒绝（超 ±20% 重置 pending）✅；压缩轮 Δest 为负被跳过 ✅
- 最终采纳 **1.07 并连续稳定**——这是**该混合会话的真实增量密度**

**关键认知修正**：预想"中文会话密度应收敛到 1.4-2.0"，但实测混合会话（大量英文
工具输出 + 少量中文对话）的**增量**密度就是 ~1.0-1.2。density 学的是"当前模型+内容
组合的实时增量密度"，不是全中文密度。累计口径 realTokens/estimatedTokens 达 2.07×
是含固定开销的累计值，与增量口径不同，两者不可混用。

### 10.3 MIN_DELTA_EST=50 门槛实测权衡（结论：保持 50）

被 50 门槛滤掉的低增量轮（Δest<50）对应比值实测：

| Δ(real, est) | instant | 若降低门槛 |
|---|---|---|
| (259, 78) | 3.3（clamp 2.5） | 噪声样本 |
| (340, 136) | 2.5 | 噪声样本 |
| (217, 136) | 1.6 | 噪声样本 |
| (124, 40) | 3.1 | 噪声样本 |

而大窗口样本（Δest≥200）比值稳定（1.03/1.07/1.21/1.44）。**降低门槛到 20-30 的
三个问题**：① 噪声样本频繁触发 C1 重置，收敛不一定更快；② 异常值连续 2 轮巧合一致
可能被采纳（高估 2× 风险）；③ Δreal 中的固定开销/usage 滞后波动在小窗口占比放大。

**结论：保持 MIN_DELTA_EST=50。** 本会话 1.07 最终收敛正确，正是门槛 + C1 确认
机制配合的结果。若未来需要加速收敛，优先考虑自适应门槛
（`max(20, density × 系数)`），而非全局下调。

## 11. 标签 token 数快照化（修复 density 校准期缓存重建）——定稿版

> 2026-08-10 提出初稿 → mimo-v2.5-pro 子代理四轮外审 → 2026-08-10 定稿。
> 外审 findings 编号（F1-F7）见 11.6；本节已逐条纳入。

### 11.1 问题：density 校准期 → 前缀缓存反复重建

**现象**：重启 pi 后（session_start 重置 density=1），校准期 density 大幅震荡
（实测：`1 → 1.9358 → 1.1743 → 2.3714 → 1.8740 → … → 收敛 1.4977`），pi 界面
出现多次"缓存重建"（DeepSeek prompt cache miss）。

**根因链**：
1. `render-refs.ts:renderMessage` **每轮对所有消息**：剥离旧 `<acp>` 标签 → 用
   `ctx.countTokens`（**带 density 的实时估算**）重新计算 → 重打标签
2. density 校准期每轮变化 → **所有历史消息的 `<acp tokens="X">` 数字每轮变化**
3. 消息文本变化 → 请求前缀与上一轮不同 → DeepSeek 前缀缓存整条 miss → 重建
4. 收敛后（density 稳定）标签不再变化 → 缓存恢复命中（与实测吻合：收敛后无重建）

**关键事实**：标签只是渲染给模型的元数据（提示消息大小），**不参与压缩决策**
（pending/压缩范围用 state 内的 countTokens 计算，不经标签文本）。所以标签
token 数**不需要每轮跟随 density 重算**。

### 11.2 方案 A（定稿）：快照放 state 顶层，key = message ref

**思路**：token 数在消息**首次渲染时确定并存入 `CompressionState.tokenSnapshot`**，
之后永远读快照，不随 density 重算。

**核心设计决策**（吸收外审 F2）：
- **快照放 `CompressionState` 顶层**（`tokenSnapshot: Record<string, number>`），
  **不放 `MessageRefMap` 里**。原因：`assignRefsNode` 每轮调用 `assignRefs`，
  而 `assignRefs`/`rebuildRefIndex` 只拷贝 `byRaw`/`byRef` 两个字段并整体覆盖
  `state.messageRefs`——快照若放里面，第一轮写入、第二轮就被吞掉，方案直接
  失效。放顶层则与 ref 分配生命周期完全解耦，`assignRefs` **零改动**。
- **key 用 message ref（`mNNNNN`）而非 message id**（吸收外审建议 + 额外验证）：
  - ref 跨重启稳定（`byRef` 持久化在 `.acp.json`）
  - ref 与标签文本直接对应（`<acp ...>mNNNNN</acp>` 里的就是 ref）
  - **额外收益（规避 F4）**：omp 场景 `mergeLiveEntries` 会给未持久化消息临时
    raw id `live-N`，但 `assignRefs` 对任何有 id 的消息都分配稳定 ref——
    快照 key=ref 后，`live-N` 被正式 id 替换不影响快照（ref 不变）

**改动点（acp-kernel）**：
1. `types.ts`：`CompressionState` 增加 `tokenSnapshot: Record<string, number>`
2. `state.ts`：`createInitialState()` 返回 `tokenSnapshot: {}`
3. `render-refs.ts`：
   - `renderMessage(..., snapshot)`：strip 旧标签后
     `const tokens = snapshot[ref] ?? (snapshot[ref] = countTokens(cleanText))`
   - `renderVisibleRefs(...)` **保留旧签名**（返回 `CoreMessage[]`，吸收 G5，
     非 breaking change），新增内部 `renderWithSnapshot(messages, state,
     countTokens, strategy)` 返回 `{ messages, tokenSnapshot }`——函数内
     `const snapshot = { ...(state.tokenSnapshot ?? {}) }` 局部拷贝后写入，
     节点侧用它
   - `createRenderRefsNode.run(io, ctx)`（**目标态，非现状**，吸收 G6）：
     `return { ...io, messages, state: { ...io.state, tokenSnapshot } }`
     （现状 dist 的 run 只返回 `{ ...io, messages: ... }` 不更新 state）
4. `sync.ts` `syncBlocks()`：重建 state 时**保留并 shallow-clone**
   `tokenSnapshot: { ...(state.tokenSnapshot ?? {}) }`（吸收 G1——pipeline 中
   sync-blocks 节点在 render-refs **之前**运行；不保留则 render-refs 每轮读到
   空快照、全部重算，方案失效）
5. `compress.ts` `cloneState()`：同样保留 `tokenSnapshot`（吸收 G2——
   applyCompression 的 clone→压缩→写回路径，不保留则压缩后快照丢失）

**改动点（billion-context-pi adapter，吸收 F1）**：
- `src/state.ts` `mergeInitialState`：补
  `tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot`
  ——旧 `.acp.json`（无该字段）加载后为 `{}`，不触发 TypeError
  **注意（吸收 G3）**：`fresh.tokenSnapshot` 来自 kernel `createInitialState`，
  **必须 kernel 先改先发，adapter 再改**，兼容闭环才成立；顺序反了会
  fallback 成 `undefined`（随后读取报错或退化）

**效果**：
- 标签在消息首次渲染时用"当时的 density"算一次 → **之后永久稳定**
- density 收敛期标签不再变化 → 前缀稳定 → **缓存只 miss 一次（重启首轮），
  不再每轮重建**
- 新消息（density 收敛后写入）标签用收敛值，**精度不损失**
- 旧消息标签是历史快照（可能在 density=1 时写入而低估）——稳定优先，可接受

**成本**：kernel 改动 5 处（types/state/render-refs/sync/cloneState）+ adapter
mergeInitialState 一行 + 测试更新。跨重启持久化后重启也不重算。

### 11.3 已知 trade-off（吸收 F3/F5，明确不修）

- **F3 孤儿条目**：快照只增不减。消息被压缩进 block / prune 后其 ref 不再渲染，
  快照条目成为孤儿。**接受**：规模上限 ≈ 会话历史消息总数（与 `messageRefs`
  同量级，几百~几千条），`.acp.json` 多几十 KB 无实际影响。未来若需要可加 GC
  （syncBlocksNode 后删除不在 `byRef` 的 key），当前不做。
- **F5 内容重写刷新**：**明确不做**。若加"偏差 >30% 刷新"，density 校准期
  跳变（1→1.93→2.37，远超 30%）会误触发刷新 → 缓存重建复现，与根治目标
  直接冲突。消息内容被宿主重写的场景罕见，接受快照固定。未来若需要，应引入
  独立于 density 的"内容哈希"机制（存 `{ hash, tokens }`，仅当文本哈希变化
  才刷新），不在本期范围。

### 11.4 备选方案对比（修正 F6 表述）

| 维度 | A（快照，定稿） | C（render/决策分离） | E（收敛期冻结） |
|---|---|---|---|
| 根治缓存重建 | ✅ 只 miss 一次 | ✅ 零 miss（标签恒定） | ⚠️ 仍 miss 一次 |
| 标签精度 | ✅ 新消息保留校准 | ❌ 不随 density 校准（CJK-aware 估算与真实差 10-30%） | ⚠️ 收敛后才有 |
| 改动量 | 中（kernel state+render + adapter 1 行） | 小（换固定函数） | 最小 |
| 副作用 | 旧消息标签是历史快照 | 标签精度永久偏差 | 校准变慢 |

- **方案 C**：render-refs 打标签改用不含 density 的固定估算（CJK-aware
  countTokens），density 只用于决策路径。改动最小、零 cache miss，但标签
  精度永远差 10-30%（仅影响展示，不影响压缩决策）。若未来追求"实现最简单 +
  绝对稳定"可退化为 C。
- **方案 E**：density 在确认（±20% 连续 2 轮）前保持 1，确认后一次应用。从
  "每轮重建"变"一次重建"，不彻底且拖慢校准。不推荐。

**推荐 A（定稿）**：唯一"既根治又不牺牲精度"的方案——快照让旧消息稳定
（缓存友好）、新消息精确（校准受益），两者兼得。

### 11.5 验证方式（吸收外审，补两条）

1. 单测：同一消息用 density=1 和 density=2 各 render 一次 → 标签 token 数一致
2. 集成：模拟 density 1→2 收敛 5 轮 → 断言标签不变、前缀稳定
3. **旧 `.acp.json`（无 `tokenSnapshot` 字段）加载后不报错、快照为 `{}`**（F1）
4. **`processTurn` 多轮运行后 `tokenSnapshot` 仍在**（assignRefs 覆盖 ref 分配
   不吞快照 + sync-blocks 覆盖重建不丢快照，F2/G1/G4 回归守卫，吸收 H2）
5. 真实会话：重启后校准期观察缓存 miss 次数（应只有 1 次）

### 11.6 PR 归属

- **kernel 侧**（`types.ts` + `state.ts` + `render-refs.ts`）：新 acp-kernel PR。
  快照放 state 顶层后 **`assignRefs`/`rebuildRefIndex` 无需改动**（F2 已通过
  设计规避），PR 描述中说明这一点。
- **adapter 侧**（`src/state.ts` mergeInitialState 一行）：进 #97（仍在 open，
  追加 1 commit）。
- 关联：issue #96（同属校准副作用修复）。

### 11.7 外审 findings 闭环

| # | 严重度 | 内容 | 处置 |
|---|---|---|---|
| F1 | Blocker | `mergeInitialState` 不补新字段 → 旧 state 读 `undefined` 报错 | ✅ 11.2 adapter 改动 + 11.5 验证 3 |
| F2 | Blocker | `assignRefsNode` 每轮覆盖 `messageRefs`，快照放里面必被吞 | ✅ 快照改放 state 顶层，assignRefs 零改动 |
| F3 | Minor | 快照只增不减 → 孤儿数据 | ⚠️ 接受为 trade-off（11.3），未来可 GC |
| F4 | Minor | `live-N` 临时 id 不稳定 | ✅ key 用 ref 天然规避（11.2） |
| F5 | Minor | 内容重写后快照不失效 | ⚠️ 明确不做（与根治冲突），记入 trade-off（11.3） |
| F6 | Nit | 方案 C "永远低估"表述过强 | ✅ 11.4 修正为"不随 density 校准（差 10-30%）" |
| F7 | Nit | 未点出 assignRefs 需保留 | ✅ 11.6 说明快照顶层化后 assignRefs 无需改动 |

### 11.8 下游兼容性分析（2026-08-10 调查）

**acp-kernel 下游使用者（共 3 个，全部 ranxianglei 自家生态）**：

| 项目 | 类型 | devDeps 版本 | 依赖方式 |
|---|---|---|---|
| billion-context-pi（本项目） | Pi adapter（in-process） | acp-kernel 0.0.17 | tsup 无 external 配置 → 默认 inline |
| billion-context | 通用 proxy（Claude Code/Codex/Cursor/Aider） | acp-kernel 0.0.17 | tsup `noExternal: ["acp-kernel", ...]` 明确 inline |
| pai-acp | Pi 生态 in-process host | acp-kernel 0.0.16 | tsup external 只列 pi 包（@earendil-works/pi-*），acp-kernel 默认 inline |

- **opencode-acp 不用 acp-kernel**：它是 DCP（opencode-dynamic-context-pruning）的衍生，
  自己实现（dependencies 仅 zod/jsonc-parser/@opencode-ai/sdk/@anthropic-ai/tokenizer）。
- 三个下游全部 **build 时 inline bundle + devDependencies**（零运行时依赖）。

**方案 A 改动对下游的影响——完全向后兼容**：

| 改动 | 对下游的影响 |
|---|---|
| `CompressionState` 加 `tokenSnapshot` | ✅ 新增字段；实现时用 `?? {}` 兜底（`...(state.tokenSnapshot ?? {})`），下游未改 mergeInitialState 也不崩 |
| `renderVisibleRefs` 返回类型 | ✅ **保留旧签名**（返回 `CoreMessage[]`），新增内部 `renderWithSnapshot()` 供 `createRenderRefsNode.run` 用——下游现有调用零破坏 |
| `createRenderRefsNode.run` 写回快照 | ✅ 行为透明，state 多一字段，下游无感知 |

**Phase 1（#51，注入 countTokens）对下游**：`estimateMessageTokens` fallback 仍为
chars/4——下游不传 countTokens 时行为与原来完全一致；传入才用真实估算（更准，纯收益）。

**发布流程（唯一"影响"）**：acp-kernel 为 0.0.x + exact pin，下游**显式 bump** 才升级
（不会漂移）。发布链：kernel 先发 → npm 验证 → 三个下游逐个 bump devDeps + 重新
build 发布（billion-context-pi 的 AGENTS.md 已规范：acp-kernel 必须先于下游发布并
验证 npm 在线）。

### 11.9 二次审阅闭环（mimo-v2.5-pro，2026-08-10）

> 定稿版初稿提交（db2eb4b）后二次外审，聚焦 F2 规避全链路验证。结论：
> **定稿方向正确，但改动清单扩大——kernel 侧从 3 处变 5 处**。G1/G2 为
> Blocker，已并入 §11.2 改动点；G3 决定实施顺序；G5 与 §11.8 一致（保留
> 旧签名）；G6 为文档标注。

| # | 严重度 | 内容 | 处置 |
|---|---|---|---|
| G1 | Blocker | `syncBlocks()`（dist:230-265）手动重建 state 只拷 6 字段，`tokenSnapshot` 被丢；pipeline 中 sync-blocks 在 render-refs **之前**运行 → render-refs 每轮读到空快照、全部重算，方案失效 | ✅ §11.2 改动点 4：syncBlocks 保留并 shallow-clone `tokenSnapshot` |
| G2 | Blocker | `cloneState()`（dist:1597-1615）同样不保留 → applyCompression 的 clone→压缩→写回路径丢快照 | ✅ §11.2 改动点 5：cloneState 保留 `tokenSnapshot` |
| G3 | Major | adapter `mergeInitialState` 尚未实现 + kernel `createInitialState` 当前也无该字段 → 兼容闭环不成立 | ✅ §11.2 标注：**kernel 先改先发，adapter 再改** |
| G4 | Minor | processTurn 返回 turn.state、adapter save 的链路本身 OK | ✅ 验证清单补"连续两轮 processTurn 后 tokenSnapshot 仍在"（11.5 第 4 条已覆盖 assignRefs，补 sync-blocks 场景） |
| G5 | Major | `renderVisibleRefs` 改返回类型是 breaking change | ✅ §11.2 改为保留旧签名 + 内部 `renderWithSnapshot()`（与 §11.8 下游分析一致） |
| G6 | Nit | 文档写的 run 返回 state 与现状不一致（现状 run 不更新 state） | ✅ §11.2 标注"目标态，非现状" |

### 11.10 第三轮审阅闭环（最终验收，mimo-v2.5-pro，2026-08-10）

> 结论：**可实施**。全量扫描确认无第三个遗漏的 state 重建点（kernel 5 +
> adapter 1 = 6 个构造点全覆盖）；G1/G2 shallow clone 修复正确安全（值为
> primitive，无共享引用，拷贝量可忽略）；文档自洽。

| # | 严重度 | 内容 | 处置 |
|---|---|---|---|
| H1 | Major（实为澄清） | adapter `mergeInitialState` 是第 6 个构造点，手动拼 6 字段缺 tokenSnapshot | ✅ 已被 §11.2 改动点 6 覆盖，非遗漏 |
| H2 | Nit | §11.5 第 4 条只提 assignRefs，与 §11.9 G4"补 sync-blocks 场景"不一致 | ✅ 11.5 第 4 条已改为"processTurn 多轮运行后 tokenSnapshot 仍在"（覆盖 assignRefs + sync-blocks） |
| H3 | Minor（优化，非阻塞） | 快照全命中时仍写回新 state → 每轮无谓 save（JSON.stringify + 磁盘写） | ✅ 采纳为实现时优化：`createRenderRefsNode.run` 仅当快照有新增条目才写回 state（`Object.keys(snapshot).length !== Object.keys(prev).length`），稳态零 I/O |
| H4 | — | 第三个重建点排查：prune/filter/hideCompressCalls/recommend/nudge/emergencyTruncate/applyCompression/hideConsumedCompressCalls/prune 逐一排除，均只改 messages 或 spread 保留 | ✅ 确认无遗漏 |
| H5 | — | G1/G2 shallow clone 验证：`{ ...(state.tokenSnapshot ?? {}) }` 值 primitive 无共享引用；syncBlocks 每轮 ~32KB 拷贝、cloneState 更低频，均可忽略 | ✅ 方案正确 |
| H6 | — | 文档自洽：§11.2 vs §11.8 的 renderVisibleRefs 表述一致；无旧表述残留；G6"目标态"标注在位 | ✅ 自洽 |
