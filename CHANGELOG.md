# Changelog

## Unreleased (master, since v0.1.38)
- **fix(overflow)**: 无 body 4xx 也触发溢出自愈 — pi 把 provider 空 body 的 4xx 原样透出为 `400/413 status code (no body)`（pi-ai 自身按 `/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i` 归类为 overflow），但 OVERFLOW_MARKER 不含该形态，扩展侧自愈永不武装 → 死循环无法恢复（2026-08-23 事故：50k 字符 bash toolResult 撞穿 sglang input+max_tokens 硬上限，此后每轮 400 无 body，模型永远等不到成功回合去 compress，用户「继续」只是原样重发超限上下文）。现将其作为**疑似溢出**信号：仅当发送视图估算 ≥ 有效上限 50%（与 turn 日志 pct 同口径）或自上次成功 assistant 回合起连续 ≥2 次无 body 4xx 时才武装紧急压缩；成功回合/新会话清零计数（runtime 内存态，与 armed 同生命周期，不入 acp.json）。无 body 解析不出窗口数 → 不学习窗口，紧急压缩直接用已解析的有效上限。经典文本标记路径不变 (relates #204)
- **fix(guardrail): `toolOutputMaxBytes` 未配置时文档默认值 200000 现在实际生效** — 原接线 `if (max !== undefined && max > 0)` 把「未配置」当成「禁用」，内置 200KB 天花板永远不可达（`capToolOutput` 内部的回退到不了）；pi 只内置 cap bash/read/grep，其余工具可无限注入 context，与 CONFIGURATION.md 承诺的 ACTIVE 默认不符。改为接线层 `?? DEFAULT_TOOL_OUTPUT_MAX_BYTES` 回退，`0`/负数禁用语义不变 (#210)

- **fix(compress): 接受 JSON 字符串形式的 `content` 参数** — 非严格工具 provider（vLLM openai-completions，`supportsStrictTools:false`）会把嵌套数组参数字符串化，pi 的 typebox 校验直接拒掉（`content.0: must be object`）。实测会话 01a00a38 全部唯一一次 compress 调用即死于此，3 小时会话零压缩。schema 改为 `Type.Union([Array, String])`，字符串自动 `JSON.parse` 并校验（错误信息引导模型传数组）
- **feat(nudge): compress 失败即时重试提示** — 失败的 compress toolResult 不再白白吃掉本轮 nudge 预算：下一次 context 事件立即注入重试提示（引用被截短的错误文本、给出正确调用格式）。仅统计**当前用户轮**的失败（旧轮失败不再复发），封顶按**失败调用次数**计：每轮最多 3 次（`MAX_COMPRESS_ATTEMPTS`），成功重置；中性结果（非错误非面板文本，如 "No ranges provided."）不重置也不递增——混合失败模式无法绕过封顶。参数类错误改为 throw（pi 仅对 throw 的工具错误标 `isError:true`，return 字符串会被当成成功并重置计数）。提示在重试前每次 LLM 调用都重新注入（pi 每次重建上下文，一次性 append 会消失）
- **fix(context)**: 上下文窗口自愈 — 上游 overflow 时从错误信息学习真实窗口、重新校准 nudge/truncate 阈值，并预留模型输出 headroom（Anthropic 除外）；下一轮强制 usage≥95% 触发紧急截断（#177）
- **feat(throttle)**: 自动重试 provider token 限流（Bedrock 429 throttle）— message_end 改写为 429 触发 pi 原生重试 + agent_settled 渐进式 ACP kick（60s→300s 指数退避），用户输入取消、per-session episode、shutdown 清理（#170）
- test: 出站 provider 视图字节稳定性回归 — 30 轮 context 事件 append-only 字节稳定（29/29 前缀一致），压缩仅改写一次（#175）
- **fix(cache)**: 标签 `tokens=` 与密度校准解耦 — 发给模型的 `` 标签恒用 raw `defaultCountTokens`（正文纯函数），density 只保留 nudge/emergency 仲裁；消除快照缺失/会话恢复/密度漂移引起的标签字节漂移与前缀缓存全量失效（61k re-bill 根因，closes #171）(#173)
- Density calibration (Phase 2 of token calibration) + token-count snapshot: kernel 0.0.24→0.0.27 (`acp-kernel`), `src/density.ts` 累积锚点密度估计器（clamp [0.5,2.5]、Δest≥50、±20% 双轮确认、per-model 隔离、压缩后重锚），`countTokens` 注入 kernel；`tokenSnapshot` 跨重启稳定 `<acp>` 标签数字，修复校准期前缀缓存反复重建（closes #146）(#155)
- Three-level compress cascade (global > provider > model, per-field deepest-wins): `compress.providers` in acp.json (#145)
- `decompress` `toFile` 加固：拒绝经符号链接逃出 `tmpdir()`/`~/.cache/opencode`/`~/.cache/pi` 的路径（含悬空链接）(#140)
- **fix(density)**: 压缩后密度重锚定 — 原实现锚点跨压缩事件不重置，重采样被阻断直到 est 涨回压缩前水平（长死区）；现于 post-compression 跳过轮在干净基准上重锚并丢弃旧 pending 确认
- **fix(density)**: `postCompression` 检测改为 runtime 按 session 跟踪新 active block（原实现比较单次 processTurn 输入/输出 state，而 block 只能由 applyCompression 在事件间创建，标志生产路径永远不触发）
- **fix(usage)**: 四个 processTurn 调用点的 `tokenCount` 改为 `rawSentTokens × density`（`calibrateTokens`）— 75% 强制 nudge / 95% emergency truncate 在 provider 锚定尺度上仲裁，CJK 会话不再偏晚触发（估计器样本仍用 RAW 口径）
- docs: token-calibration-plan 对齐实现（T2/T3 随 density 放大、mid-session 模型切换为 per-model 隔离、重锚时机、postCompression 检测方式）

## v0.1.38

- **fix: sent-view nudge arbitration** — 四个 processTurn 调用点统一用发送视图估算（`estimateTokens + sysPrompt`）仲裁 nudge/usage，不再用 `getContextUsage` 的 session-tree 口径（provider 不报 usage 时树总量只增不减 → 永久假 EMERGENCY；omp issue #18 同类）(#150)
- **adopt billion-context-kit 0.2.0** — `/acp` 面板改用共享 `buildStatusPanel`（双账本：session accounting / sent view、viability 过滤、bar 用 sent 视图、block 列表 topic 回退），`viableRanges` 移入 kit (#149)
- **fix: 只推荐 viable 可压缩范围（≥200 tokens）** — 注入 nudge / `acp_status` / `/acp` 面板三处统一过滤碎片小范围（小范围进批量 compress 会因 summary 过短整体失败）(#148)
- docs(readme): 配置参考指向 CONFIGURATION.md (closes #35) (#144)
- acp-kernel 0.0.23 → 0.0.24

## v0.1.37

- feat(prompts): acp.json 可定制提示词（Layer 2，默认提示词字节级不变）(#128)
- fix(omp): 转换上下文/分支切换后保留压缩状态；provider 前缀后保留压缩 ref (#138 + omp 系列修复)
- fix: block decompress 在树导航后回退到完整 session 树 (#133)
- fix: delegate 子代理在嵌入宿主（如 pi-web）下解析正确的 pi CLI 入口 (#130)
- ci: Windows 加入测试矩阵 + 跨平台 e2e runner（真实 `pi -p`）(#132, #134)

## v0.1.36

- Bump acp-kernel to 0.0.21 (two-tier gating: maxContextLimitPct 75% force-nudge + emergencyThresholdPct 95% truncate, spam fix when no compressible content, over-limit emergency voice)
- New compress config sub-object: `maxContextLimit`, `emergencyThresholdPercent`, `nudgeGrowthTokens` (maps to kernel `nudge.maxContextLimitPct`, `nudge.emergencyThresholdPct` + `truncate.threshold`, `nudge.growthFloor` + `nudge.growthCap`)
- New delegate config sub-object: `delegate: { enabled, displayUsage }` (boolean shorthand + legacy flat `displayUsage` backward compat)
- Standalone CONFIGURATION.md + CONFIGURATION.zh-CN.md reference docs
