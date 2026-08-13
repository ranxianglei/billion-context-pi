# REQ: Block decompress full-tree fallback after tree navigation

- Task ID: `2026-08-13_decompress-full-tree-fallback`
- Home Repo: `billion-context-pi`
- Created: 2026-08-13
- Status: Done
- Priority: P1
- Owner: Tyan66666
- References: PR #133

## 1. Background & Problem Statement

- **Context**: 会话树导航（pi-workspace-history `/undo`/`/redo`、Pi 原生 `/tree`）只移动 leaf 指针、不删除任何 entry（`ctx.navigateTree` → `branch(entryId)`）；但块级解压只从**活动分支**取原文。
- **Current behavior (symptom)**: 对撤销区间内的块，`decompress({blockId:"b1"})` 返回 `Block b1 has no restorable message content.`——full 模式返回空，非 full 模式只剩嵌套子块摘要。
- **Expected behavior**: 块级解压与单消息解压一致，能从 session log（全量树）取回原文。
- **Impact**: 无数据丢失（块/摘要/原文都在磁盘）、无崩溃；"块级解压还原全文"能力对撤销区间失效，属功能缺口。

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22
  - OS/Arch: darwin-arm64
- **Minimal reproduction steps**:
  1) 压缩一批消息 → 产生块 b1
  2) `/undo`（或 `/tree`）导航，使被压缩消息退出活动分支
  3) `decompress({blockId:"b1"})`
- **Relevant configuration**: 无

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: 不改变 `.acp.json` schema，旧状态文件直接可用
  - Performance requirements: 无缺失时零开销（不触发 fallback）
  - Resource limits: 不引入新依赖；不动 acp-kernel（跨仓改动受发布顺序约束）
- **Non-Goals**: 不修单消息解压（已正常，走 `getEntries()` 全量树）；不做 undo 后自动重解压

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] undo 后块级解压恢复原文（fallback 到 `getEntry` 全量树）
  - [x] 全量树也找不到时保留现有降级提示，不抛异常
  - [x] 多 tool-call assistant（`#` 后缀 id）归一化后全部恢复
  - [x] 多轮 compress → navigate → decompress 状态不丢、ref 不串
- **Performance / Stability**:
  - [x] 无缺失消息时短路返回原 `coreMessages`，零额外开销
- **Regression**:
  - [x] 新测试 4 个加入测试套件并通过（全量 237/237）

## 5. Proposed Approach (optional)

- **Affected modules & entry files**: `src/decompress-tool.ts`（新增 `resolveBlockMessages` + `handleDecompress` 调用点 2 行）；`tests/decompress-tool.test.ts`
- **Risks**: 低——改动隔离在解压路径、只读、不写回 state
- **Rollback strategy**: `git revert 716e3b9`；不涉及 acp-kernel 与 schema
