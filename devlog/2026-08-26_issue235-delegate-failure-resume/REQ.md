# REQ - Delegate 失败/取消日志保留 + 失败诊断 + resumeFrom 续跑

- Task ID: `2026-08-26_issue235-delegate-failure-resume`
- Home Repo: `billion-context-pi`
- Created: 2026-08-26
- Status: InProgress
- Priority: P1
- Owner: ework-daemon
- References: https://github.com/ranxianglei/billion-context-pi/issues/235

## 1. Background & Problem Statement

- **Context**: `acp_delegate` 把任务派给独立的 pi 子进程。async run 的实时输出流到 `${OUT_DIR}/<runId>.out`（回复）与 `<runId>.activity`（工具活动）。
- **Current behavior (symptom)**:
  1. **取消即删档**：`finalize` 的 cancelled 分支 `rm` 掉 `.out` 和 `.activity`（src/delegate-tool.ts:859-866）；spawn error 路径同样 `rm` 两文件（src/delegate-tool.ts:928-929）。失败/取消后 AI 无法回看子 agent 已产出的内容。
  2. **失败原因暴露不足**：`close(code)` 丢弃了 exit signal（被 SIGTERM 杀死显示 `exit ?`）；失败通知 body 只有 `stderr || output`，provider 错误常不落 stderr 时 body 为空/误导；activity 日志（工具调用轨迹）不在通知里，模型不知道去哪看。
  3. **无法续跑**：子进程一律 `--no-session`，进程被杀后上下文（已做的工具调用、部分发现）全部丢失，只能从零重派。
- **Expected behavior**:
  1. 失败、取消、spawn error 三种终止路径都保留日志文件，并在 cancel/wait 返回与失败通知中给出文件路径。
  2. 失败通知含：exit code/signal、stderr、activity 日志尾部、部分回复、activity 文件路径。
  3. pi 宿主下子进程会话持久化到确定性文件；`acp_delegate({ resumeFrom: "<runId>" })` 可恢复原会话历史从断点继续。
- **Impact**: 失败任务的工作量浪费（无法复用）、排障困难（无轨迹）、长任务被 watchdog 杀掉后只能推倒重来。

## 2. Reproduction

- **Environment**: Node >=20, linux/darwin/win32; pi 宿主 (interactive/rpc)
- **Minimal reproduction steps**:
  1) `acp_delegate({ agent: "worker", task: "...", async: true })` 启动一个会失败的 run（如无效 cwd 或 provider 429）
  2) 观察：失败通知 body 常为空或只有 stderr；`<runId>.activity` 存在但通知未提及
  3) `acp_delegate_cancel({ runId })` 后：`.out`/`.activity` 被删除，`ls ${TMPDIR}/acp-delegate/` 无该 run 文件
- **Relevant configuration**: 无新增配置。

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: 现有工具参数（agent/task/cwd/model/async/showThinking）语义不变；`resumeFrom` 为新增可选参数。
  - 子进程崩溃安全依赖 pi 的 SessionManager 同步落盘（appendFileSync，已验证 node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js）。
  - omp 宿主无 `--session` 能力 → resume 仅限 pi 宿主，omp 保持 `--no-session`。
  - AGENTS.md：无 `as any`、无 `@ts-ignore`、无多余注释。
- **Non-Goals**:
  - 不做跨宿主（omp）resume。
  - 不做 session 文件的自动清理策略（沿用 OUT_DIR 现状，由系统 tmp 清理）。
  - 不改 watchdog 阈值与取消语义（SIGTERM）。
  - 不做并发 resume 同一 session 文件的互斥锁（原 run 仍在 running 时拒绝；其余场景极罕见，接受）。

## 4. Acceptance Criteria

- **Correctness**:
  - [ ] 取消后 `.out`/`.activity` 保留；cancel 工具返回与 wait 的 cancelled 消息均含保留文件路径 + resumeFrom 提示
  - [ ] spawn error 后 `.out` 保留且内容为 `spawn error: ...`；run.result.file 指向该文件
  - [ ] 失败通知 header 显示 `exit <code>` 或 `exit <SIGNAL>`（code 为 null 时）；body 按 stderr → activity 尾部 → 部分回复 组合；通知含 activity 文件路径
  - [ ] pi 宿主：子进程 cliArgs 含 `--session ${OUT_DIR}/<runId>.session.jsonl --session-dir ${OUT_DIR}`（sync/async 均是），无 `--no-session`；omp 宿主保持 `--no-session`
  - [ ] `resumeFrom` 指向不存在的 session 文件 → 明确报错不 spawn；指向 running run → 拒绝；非 pi 宿主 → 明确报错
  - [ ] resume 子进程以原 run 的 session 文件启动，stdin 为续跑指令（task 可选，作为补充指引）
- **Performance / Stability**:
  - [ ] 无新增每次轮询开销；session 文件由 pi 子进程同步写，父进程零额外 I/O
- **Regression**:
  - [ ] 现有 45+ 测试全绿；新增覆盖：cancel 保留文件、spawn error 保留文件、exitLabel、activity 尾部入通知、session 旗标（pi/omp/resume）、resume 校验、resume stdin 文本

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `src/delegate-tool.ts` — 全部改动集中于此（finalize/close/error 路径、buildChildArgs、wait/cancel 消息、injectResult/formatPayload、schema/描述）
  - `tests/delegate-tool.test.ts` — 更新 buildChildArgs 调用签名 + 新增用例
- **Risks**:
  - pi 子进程加载了 billion-context-pi 扩展 → 子进程会话也会有 ACP 状态文件（现状已如此，无变化）
  - `--session <path>` 文件缺失时 pi 会在该路径新建会话（已验证 session-manager.js `_setSessionFile`）→ resume 到"无 assistant 输出"的 run 会静默变成新会话，故 resume 前置校验文件必须存在
  - 子进程 cwd 在 resume 时已不存在 → pi 报 "Stored session working directory does not exist"（明确错误，可接受）
- **Rollback strategy**: 单一功能分支，revert 即可；无数据格式迁移（session 文件为新增产物，旧版本忽略）。
