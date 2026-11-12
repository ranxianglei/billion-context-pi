# DESIGN - Delegate 失败/取消日志保留 + 失败诊断 + resumeFrom 续跑

- Task ID: `2026-08-26_issue235-delegate-failure-resume`
- Home Repo: `billion-context-pi`
- Created: 2026-08-26
- Status: Accepted

## 1. Goals & Non-Goals

- **Goals**: ① 失败/取消/spawn-error 保留日志文件并在消息中给出路径；② 失败通知含 exit signal、stderr、activity 尾部、部分回复、activity 文件路径；③ pi 宿主子进程会话落盘 + `resumeFrom` 断点续跑。
- **Non-Goals**: omp resume；session 文件清理策略；watchdog 语义变更；并发 resume 互斥锁。

## 2. Background & Motivation

- `acp_delegate` 子进程此前一律 `--no-session`：进程被杀（watchdog SIGTERM、取消、崩溃）即上下文全丢，只能从零重派；且取消路径主动删除日志文件，失败通知诊断信息不足。
- pi CLI 0.83 提供 `--session <path|id>` + `--session-dir <dir>`：`--session <abs-path>` 在文件存在时打开并继续、缺失时在该路径新建（已验证 `SessionManager.open` → `_setSessionFile`）；会话条目同步落盘（`appendFileSync`），崩溃安全。
- 因此"失败内容能否继续唤起"的答案是**可以**：会话文件天然保留了任务、工具调用、部分发现。

## 3. Current Architecture (as-is)

- `buildChildArgs` (src/delegate-tool.ts:973) 生成 `--no-session`（pi/omp、sync/async 一致）；runId 在 `buildChildArgs` 之后生成（src/delegate-tool.ts:741）。
- async 终止路径：`finalize(code)` (src/delegate-tool.ts:846) — cancelled 分支 `rm` 两文件；失败分支保留 `.out`、body = `stderr || output`；`child.on("close", (code) => finalize(code))` 丢弃 signal (src/delegate-tool.ts:919)；`child.on("error")` `rm` 两文件、`result.file=""` (src/delegate-tool.ts:921-944)。
- 通知：`injectResult` (src/delegate-tool.ts:1077) header `exit ${code ?? "?"}`；`formatPayload` (src/delegate-tool.ts:1196) 只有 Full result 文件行。
- wait/cancel 的 cancelled 消息为 "was cancelled (no result)"，无文件路径 (src/delegate-tool.ts:591-594, 637-644, 692)。

## 4. Proposed Design (to-be)

- **Module / data-flow changes**（全部在 `src/delegate-tool.ts`）:
  1. runId 生成前移到 `buildChildArgs` 之前；`buildChildArgs(args, rolePrompt, ctx, runId)` 返回 `sessionFile`。
  2. 会话旗标：`useSession = isPiHost(ctx.sessionManager)` → `--session ${OUT_DIR}/<id>.session.jsonl --session-dir ${OUT_DIR}`；每个 run 独占一个文件，`<id>` = 本 run 的 `runId`。resume 时 spawn 前把原 run 的 session `copyFile` 到新 run 的文件（历史完整带入），从而**被 resume 的 run 再失败时也能直接 `resumeFrom` 指向它**（若写回原文件，最近 runId 无自有文件，二级续跑会 fail fast 且与通知里的 resume 提示相矛盾）。omp → 维持 `--no-session`，`sessionFile=null`。
  3. `finalize(code, signal)`：
     - 记录 `run.exitCode`/`run.exitSignal`；
     - cancelled 分支不再 `rm`：空回复时 backfill（stderr 或 "(no output)"）、`run.result = { code, file: replyFile, body }`、唤醒 waiter；
     - 失败 body 组合：`stderr:` 段 → `last activity (full log: <activityFile>):` 段（`readActivityTail`，末 400 字符）→ `partial reply:` 段，均空则 "(no output)"；
     - `injectResult` 追加 `activityFile`/`signal` 尾参，失败时渲染 "Activity log: `<path>`" 行与 `exit <SIGNAL>`。
  4. `child.on("error")`：不 `rm`；`writeFile(replyFile, "spawn error: ...")`；`run.result.file = replyFile`。
  5. `waitForChild` 捕获 `close(code, signal)` → `ChildResult.signal`；`formatSyncResult` 用 `exitLabel`。
  6. wait 两处 cancelled 消息 + cancel 工具消息：统一 `cancelledFileNote(runId, file)`（保留文件路径 + `resumeFrom` 提示）；文件路径取 `run.result?.file`，缺失时按确定性路径 `${OUT_DIR}/<runId>.out` 兜底。
  7. schema 新增 `resumeFrom?: string`；`runDelegate` 前置校验：非 pi 宿主拒绝；目标 run 仍 running 拒绝；session 文件不存在拒绝（提示重新派发）。resume 时 `task` 可空，stdin = `RESUME_INSTRUCTION`（+ 可选 "Additional guidance for this attempt" 段）；run 记录 `resumedFrom`。
- **New types / interfaces**:
  - `DelegateRun.exitSignal?: NodeJS.Signals`；`DelegateRun.activityFile?: string`；`DelegateRun.resumedFrom?: string`
  - `ChildResult.signal?: NodeJS.Signals | null`
  - 导出纯函数（可单测）：`exitLabel(code, signal)`、`cancelledFileNote(runId, file)`、`delegateStdinText(resumeFrom, task)`、`readActivityTail(file, maxChars=400)`
- **New files**: `devlog/2026-08-26_issue235-delegate-failure-resume/{REQ,DESIGN,WORKLOG}.md`；运行期新增产物 `${OUT_DIR}/<runId>.session.jsonl`（仅 pi 宿主）。

## 5. Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `--session <abs path>` + `--session-dir` | 确定性路径、父进程可预知、缺失即新建 | 需显式传 `--session-dir` 防用户 settings 重定向 | ✅ 采用 |
| `--session-id <runId>` | 更短 | 文件落在 pi 默认 sessionDir（用户 settings 可改），父进程无法预知路径，resume 定位困难 | ✗ |
| `--fork <path>` resume | pi 原生 fork 语义 | fork 创建新会话副本，原会话不动；语义是"分支"而非"继续"，且需先知道路径 | ✗（`--session` 直接续写更符合"唤起"） |
| 取消后保留但压缩文件 | 省空间 | 复杂度不值；tmp 目录由系统清理 | ✗ |
| resume 用 `--resume`（交互 picker） | 原生 | 交互式，headless 不可用 | ✗ |

## 6. Risks & Trade-offs

- **Backward compatibility**: 参数向后兼容；取消语义不变（仍 SIGTERM），只是文件保留；omp 行为不变。
- **Performance**: 父进程零新增 I/O（session 文件由子进程同步写）；失败通知 body 最多 +400 字符 activity 尾部。
- **Cross-platform**: 路径经 `join()`；`--session` 绝对路径含分隔符 → pi 按 path 解析（已验证 resolveSessionPath）。
- **已知边界**: ① 子进程 cwd 在 resume 时已删除 → pi 明确报错（Stored session working directory does not exist）；② 原 run 无 assistant 输出 → session 文件未创建 → resume 前置校验拒绝；③ 宿主重启后 registry 丢失，无法检测"原 run 仍 running"（仅靠 session 文件存在性）；④ 每个 run 独占 session 文件（resume 时 copy），无并发写同文件；对同一原 run 并发 resume 产生两个独立分支（合理 fork 语义）。

## 7. Open Questions

- 无。
