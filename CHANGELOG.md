# Changelog

## Unreleased (master, since v0.1.38)
- **fix(compress): 彻底移除 `content` 参数的 JSON 字符串形式（closes #273）** — 撤销此前为兼容非严格工具 provider 加的 `Type.Union([Array, String])` 兜底：schema 改回仅 `Type.Array(RangeSpec)`，删除 `tailRepair`/`repairContentTail`/`jsonParseError` 及 `describeDiagnostics` 的字符串解析分支，`normalizeRanges` 改为纯数组校验。非数组 `content`（含 JSON 编码的数组字符串）现在直接抛错（pi 标 `isError:true`，计入失败上限）。权衡：会把数组参数字符串化的非严格 provider 现在在 schema 层被拒，不再进兜底解析
- **fix(delegate): 并发完成的 delegate 通知合并为单条批量消息（closes #157）** — 多个 subagent 同时（或主窗口正忙时接连）完成时，每条完成各自 `sendUserMessage(deliverAs: followUp)` 注入一条通知，N 个完成的 delegate 吃掉 N 个完整模型轮次，且模型已收尾后通知仍在持续涌入。现在 finalize 不再直接注入，而是进入 2s 尾沿防抖窗口（自首个排队完成起硬上限 10s，防连续错峰完成饿死投递）；窗口关闭时 `flushDelegateNotifications` 发**一条**批量消息：头部计数（`[acp_delegate] 3 delegates finished (2 completed, 1 FAILED)`）+ 每个 run 一节（状态/exit code/超时注记/任务/结果文件/失败错误摘录）+ 单一尾部（仍在跑的 delegate 数、session delegate usage、收尾指令）。窗口期内获得 waiter 或被 `acp_delegate_wait`/`acp_delegate_cancel` 消费的 run 自动出批（不重复投递）；发送失败不置 delivered，run 留在未送达集由后续 carrier 补投（`findUndeliveredRuns` 将排队中视为已排程而非丢失）；单 run flush 保留原单条格式。净效果：N 个同时完成 → 1 个模型轮次
- **feat(delegate): 失败/取消保留日志 + 失败诊断 + `resumeFrom` 续跑中断的 run (closes #235)** — 此前 cancel 与 spawn error 路径直接删除 `.out`/`.activity` 文件，失败通知只有 exit code（信号被丢弃、stderr 可能为空、activity 轨迹不可见）。现在：① 所有终止路径保留文件（spawn error 把错误写入 `.out`；cancel 回填部分回复，cancel/wait 结果明确给出文件路径）；② 失败通知带 exit 信号（`exit SIGTERM`）、stderr、activity 日志尾部（400 字符）与 activity 文件路径；③ pi 宿主 delegate 用 `--session <OUT_DIR>/<runId>.session.jsonl` + `--session-dir` 持久化自身会话（omp 不变，保持 `--no-session`），新增 `resumeFrom: "<runId>"` 参数让新 run 恢复原会话（原任务 + 已执行的 tool calls + 部分结果）从中断处继续——`task` 变为可选（提供时作为本次追加指引）；校验：原 run 不得仍在运行、session 文件必须存在、非 pi 宿主拒绝
- **fix(floor): provider-usage floor 跳过压缩后一轮的 stale anchor(#258 评审)** — pi 的 `getContextUsage()` 锚定最后一条有效 assistant usage;成功 compress 落在锚点之后时,下一个 LLM 调用仍以压缩前的大数字 floor,会在刚缩小的上下文上重跑 emergency(nudge 注入 + 工具结果机械截断),面板也继续显示压缩前数字,直到下一条 usage 到达。新增 `src/floor-stale.ts`(`usageAnchorPredatesCompression`):锚点(跳过 aborted/error/全零)早于最后一条成功 compress toolResult(失败/0-block no-op 不算)时跳过 floor,context transform / `acp_status` / `/acp` 三处一致(面板 sessionTokens 同步);对齐 pi 自身 compaction 的 "usage source must be post-compaction" 检查。已知接受:provider 永不报 usage 时(omp #18 tree-sum 回退)floor 仍会永久高位
- **fix(nudge): 移除瞬态 compress 重试提示注入（closes #223，取代 #217）** — compress 失败后每次 LLM 调用重注入的 `compressRetryMessage` 瞬态 user 提示整体移除：对从不重试的模型，该提示无限追加（用户日志 ~400 次/小时、emergency pct 95→127%），即 #223 的"永远追加失败标记"。失败信息本身仍以 toolResult 形式持久留在 session 日志中（模型可见、可自我纠正，随正常压缩流程淘汰）；issue #6 的 nudge 断路器保留：每用户轮 MAX_COMPRESS_ATTEMPTS=3 次失败/no-op 后 emergency nudge 停止重注入（kernel 紧急截断仍机械兜底），UI 提示改为 "nudge paused until the next user message (emergency truncation still active)"。`noteCompressOutcomes` 返回值去掉 `retryFor`
- **fix(tokens): 图片 token 计入发送视图估算 (closes #200)** — `extractText` 只投影 `type:"text"` 块，图片在 sent-view 估算中计 0 token：含图会话的 nudge/truncation/compress 仲裁系统性偏晚（只等真实 400 后 overflow-selfheal 被动触发），且 density 校准被 phantom gap 污染（provider 真实 usage 含图、估算不含 → 图片轮 dReal/dEst 爆表被 clamp 到 2.5×，纯文本轮又拉回 1.0，density 振荡且仍低估 5-10× → 过早/过晚压缩交替）。现在 `collectImageTokens` 按 `IMAGE_TOKEN_COST=1600`/张计入（仅视觉模型，`model.input` 含 `image`；非视觉模型 pi-ai 静默丢图、计 0），density 校准环自动收敛真实成本（A/B 实测收敛 ~0.98）；出站 payload 字节不变（sha256 一致），前缀缓存不受影响 (#201)
- **fix(delegate): 并发多 agent 时失败必达，不再静默 (#16)** — async delegate 此前有三条失败路径完全不通知主模型(spawn error、结果持久化 error、`sendUserMessage` 注入丢失)，模型未挂在 `acp_delegate_wait` 上时失败被吞，直到收尾汇总才发现少了结果。现在：所有终止路径 best-effort 注入 `FAILED ⚠️` 通知(带错误摘录，与 sync 路径对齐，明确提示"该任务结果缺失、收尾前决定是否重派")；注入失败的 run 进入未送达集，随**下一个** delegate 通知或任何 delegate 工具结果(`acp_delegate`/`wait`/`cancel`)捎带 Recovery notice 补投；Recovery notice 的 delivered 标记改为 carrier 发送成功后才提交（发送抛错不再永久吞掉其他 run 的结果）；system prompt 补充 FAILED/Recovery 通知说明
- **fix(delegate): bad cwd 等即时 spawn 失败不再击穿宿主 (#16)** — `OUT_DIR` 的 `mkdir` 原本夹在 `spawn()` 与 `child.on("error")` 注册之间：不存在的工作目录使 spawn 立即 ENOENT，错误事件先于监听器注册到达 → uncaughtException → 整个 pi 会话被杀。现在 mkdir 提前到 spawn 之前，spawn 到 close/error 处理器注册全程同步，tmux 实测原崩溃场景稳定注入 FAILED ⚠️ 且宿主存活
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
