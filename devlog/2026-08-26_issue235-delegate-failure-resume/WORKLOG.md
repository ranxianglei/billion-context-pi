# WORKLOG - 子 agent 失败/取消保留日志 + 失败诊断 + resumeFrom 续跑

- Task ID: `2026-08-26_issue235-delegate-failure-resume`
- Home Repo: `billion-context-pi`
- Status: InProgress
- Updated: 2026-08-26

## 1. Summary

- **What was done** (1–3 sentences):
  delegate 子 agent 的三条终止路径（失败 / 取消 / spawn error）不再删除日志文件，失败通知补充 exit 信号、stderr、activity 日志尾部与 activity 文件路径；pi 宿主 delegate 改为 `--session` 持久化自身会话，新增 `resumeFrom` 参数从中断处续跑。
- **Why** (1–3 sentences):
  issue #235：失败/取消后 AI 无法查看已产出的内容（文件被删）；失败原因不可见（信号丢弃、stderr 常为空、activity 轨迹不在通知里）；用户希望失败的 run 能继续唤起。
- **Behavior / compatibility changes**: Yes — cancel/spawn-error 后文件保留（原先删除）；pi 宿主 delegate 子进程从 `--no-session` 改为 `--session <OUT_DIR>/<runId>.session.jsonl --session-dir <OUT_DIR>`（omp 不变）；`acp_delegate` schema 新增 `resumeFrom`，`task` 变为可选；cancel/wait 结果文案变化。
- **Risk level**: Medium（子进程 CLI 参数变化 + 通知文案变化；逻辑路径均有测试覆盖）

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `c1f48c5` | feat(delegate): 失败/取消保留日志 + 失败诊断 + resumeFrom 续跑 (#235) |
| `6988df0` | fix(delegate): resume 二级续跑 — 每 run 独占 session 文件，resume 时 copy 原 session (#235) |

### Key Files

- `src/delegate-tool.ts` — 全部改动：文件保留、诊断、session 持久化、resumeFrom 校验与参数、通知文案
- `tests/delegate-tool.test.ts` — 新增 10 个测试 + e2e spawn-error 测试扩展（文件保留断言）
- `CHANGELOG.md` — Unreleased 条目

## 3. Design & Implementation Notes

- **Entry point / key function**:
  `buildChildArgs(args, rolePrompt, ctx, runId)`（session 参数）、`finalize(code, signal)`（取消保留 + 失败 body 组装）、`runDelegate` 内 resume 校验、`delegateStdinText(resumeFrom, task)`（resume 指令）。
- **Key configuration items**:
  `SESSION_EXT=".session.jsonl"`、`ACTIVITY_TAIL_CHARS=400`、`RESUME_INSTRUCTION`（resume 时的 stdin 指令文本）。
- **Key logic explanation**:
  - pi 的 `--session <abs-path>`：文件存在则续写、不存在则在该路径新建（`SessionManager.open` → `_setSessionFile`），且 pi 会话写入是同步的（`appendFileSync`）→ 文件 crash-safe，kill 后已产生的内容都在盘上。
   - 每个 run 独占 session 文件（`<runId>.session.jsonl`）；resume 时 spawn 前 `copyFile` 原 run 的 session 到新 run 文件（历史完整带入）→ 被 resume 的 run 再失败时 `resumeFrom` 可直接指向最近 runId（写回原文件则二级续跑无文件可指，且与失败通知里的 resume 提示相矛盾）。新 run 的 `.out`/`.activity` 用新 runId。
  - 失败 body 组装顺序 = 优先级：`stderr:` → `last activity (full log: …):`（尾部 400 字符）→ `partial reply:`；`formatPayload` 里整体截断 500 字符。
  - `exitLabel(code, signal)`：code 为 null 且有信号时显示 `exit SIGTERM`（Node close 事件语义：正常退出 code 有值 signal 为 null，被杀则相反）。
  - resume 校验三关：非 pi 宿主拒绝 → 原 run 仍 running 拒绝 → session 文件不存在拒绝（fail fast，不 spawn）。

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck      # tsc --noEmit
npm test               # node --import tsx --test tests/*.test.ts
npm run build          # tsup
```

### Test Coverage

- New/modified test files: `tests/delegate-tool.test.ts`
- Test count: 440 total, 440 pass, 0 fail
- Key scenarios verified:
  - pi 宿主 cliArgs 含 `--session <...>/<runId>.session.jsonl` + `--session-dir`，无 `--no-session`；omp 保持 `--no-session`
  - `resumeFrom` 时 session 参数指向**新 run** 的 session 文件；e2e：resume spawn 前把原 session 内容 copy 到新 run 文件（内容一致）、子进程以真实 pi CLI 跑无效 session 内容正常失败并注入 FAILED
  - `exitLabel` 全部分支（0 / 1 / null+SIGTERM / null）
  - `cancelledFileNote` 含保留文件路径 + resumeFrom 提示
  - `delegateStdinText`：fresh 原样透传；resume 带指令；resume+guidance 追加
  - `injectResult` 失败通知含 `Activity log:` 行与 `exit SIGTERM`
  - `readActivityTail` 截断（400 上限 + `…` 前缀）/ 文件缺失返回空
  - `resumeFrom` session 文件缺失 → fail fast 不 spawn；omp 宿主 → 拒绝
  - e2e：bad cwd spawn error 后 `.out` 文件保留、内容含 `spawn error`、注入消息指向该文件

### Results

- **PASS/FAIL**: PASS（typecheck / 439 tests / build 全绿）
- **Key logs/data** (optional): 无

## 5. Risk Assessment & Rollback

- **Risk points**:
  - pi 子进程 CLI 参数变化（`--no-session` → `--session`）：依赖 pi 0.83 的 `--session <path>` 语义（已核对 pi 源码：缺失文件在新路径创建、存在则续写、同步落盘）。
  - 并发 resume 同一原 run：原 run 仍 running 时已拒绝；结束后两个并发 resume 各自 copy 出独立 session 文件（无同文件并发写，产生两个分支，合理 fork 语义）。
  - 取消路径现在保留文件 → `~/.acp-delegate`（tmpdir）下文件累积略增（原本只保留成功/失败 run 的 `.out`）。
- **Rollback method**:
  - Revert commit(s): `c1f48c5` + 本表第二行 fix commit
  - Rollback impact: 回到失败/取消删文件、无 resumeFrom 的旧行为，无数据迁移问题。
- **Compatibility notes** (data format, config schema): 无配置变化；`acp_delegate` 工具 schema 向后兼容（新增可选参数，`task` 放宽为可选）。

## 6. Lessons Learned (optional)

- What went well:
  - pi 的 `--session <abs-path>` 语义恰好满足"确定性路径 + 缺失即新建"，无需 fork 或自管 session 存储。
- What could be improved:
  - 测试中 `injectResult` 的信号用例初版误传 `code:1 + SIGTERM`（真实语义是 code null 才有 signal），靠失败测试发现并修正。
  - 评审发现"resume 写回原 run 文件"的二级续跑陷阱：被 resume 的 run 无自有 session 文件，其失败通知却提示 `resumeFrom: <该 runId>` → 必然 fail fast。改为每 run 独占文件 + resume 时 copy（代价：每次 resume 多一份 session 副本，tmpdir 可接受）。
- Reusable conclusions:
  - Node `child.on("close")` 的 `(code, signal)`：正常退出 code 有值、signal 为 null；被信号杀死则 code 为 null、signal 有值。展示 exit 状态应按此组合。

## 7. Follow-ups (optional)

- [ ] 真实 pi 宿主端到端验证 resume（本环境无 pi 宿主，仅源码核对 + 单测）
- [ ] 考虑对 `~/.acp-delegate` 增加过期清理（文件保留后累积略增）
