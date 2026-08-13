# DESIGN: Block decompress full-tree fallback

- Task ID: `2026-08-13_decompress-full-tree-fallback`
- Home Repo: `billion-context-pi`
- Created: 2026-08-13
- Status: Accepted

## 1. Goals & Non-Goals

- **Goals**: tree 导航（undo/redo//tree）后块级解压仍能还原原文；补全只发生在解压路径，不污染压缩主链路。
- **Non-Goals**: 不改变状态持久化格式；不跨仓修改 acp-kernel（受发布顺序约束）；不改变单消息解压行为。

## 2. Background & Motivation

`navigateTree` 只移动会话叶子指针、不删 entry，消息原文始终在 append-only session tree。但块级解压的取数来源是 `buildContextEntries()`（**仅活动分支**），与单消息解压的 `getEntries()`（全量树）不对称——同一概念两处实现口径不一致即根因信号。

## 3. Current Architecture (as-is)

```
decompress 工具 → decompress-tool.ts handleDecompress()
  → runtime.stateFor(ctx) → readContextEntries(sm)          [src/runtime.ts]
      → buildContextEntries()                                // 仅活动分支
  → entriesToCoreMessages(entries) → coreMessages
  → collectBlockContent(state, block, coreMessages, {full})  [acp-kernel]
      → messages.filter(m => block.effectiveMessageIds.has(m.id))  // 找不到 → 空
```

对比：`findMessageContent` 扫 `ctx.sessionManager.getEntries()`（全量树）——undo 后仍可恢复，证明原文未丢。

## 4. Proposed Design (to-be)

- **Module / data-flow changes**: `src/decompress-tool.ts` 新增 `resolveBlockMessages(block, coreMessages, ctx)`，在 `collectBlockContent` 前补全：
  1. 双侧 `split("#")[0]` 归一化——块存 CoreMessage id（多 tool-call assistant 为 `` `${entryId}#${callId}` ``，`messages.ts` `projectMessage`），`getEntry()` 键是 SessionEntry id（无后缀）；
  2. `missingBaseIds` 逐个 `ctx.sessionManager.getEntry(id)`（O(1) 全量树查找），`entriesToCoreMessages` 重投影（多 tool-call 自动拆回 `#` 后缀，命中 `collectBlockContent` 的 `targetIds`）；
  3. 无缺失时短路返回原 `coreMessages`，零开销。
- **New types / interfaces**: 无（复用 `CompressionBlock` / `CoreMessage`）
- **New files**: 无（单函数）

## 5. Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A. 块级解压前补全 messages（getEntry 全量树） | 改动最小、隔离解压路径、原文精确恢复 | 无 | **选 A** |
| B. `readContextEntries` 改用 `getEntries()` | 中 | 压缩判定/状态同步会重见已撤销消息 → 重压缩、ref 混乱 | 否决 |
| C. acp-kernel 内部 fallback | 根治 | 跨仓，受"acp-kernel 先发布"约束 | 否决 |

## 6. Risks & Trade-offs

- **Backward compatibility**: 无 schema 变化；旧 `.acp.json` 直接可用；无缺失时行为与修复前逐字节一致
- **Performance**: `getEntry` O(1)；仅缺失时触发；只读不写回 state
- **Cross-platform**: 纯 JS，无平台差异
- 风险：`getEntry` 返回非 message entry → `entriesToCoreMessages` 跳过；`count` 语义变化 → 仅影响提示文案，无状态影响

## 7. Open Questions

- 无（两轮模型评审已闭环：首轮 5 finding 修正，二轮 GO ✅）
