# WORKLOG: Block decompress full-tree fallback

- Task ID: `2026-08-13_decompress-full-tree-fallback`
- Home Repo: `billion-context-pi`
- Status: Done
- Updated: 2026-08-13 13:37

## 1. Summary

- **What was done**: 块级解压新增全量树 fallback（`resolveBlockMessages`），undo/redo//tree 后仍可从 `getEntry` 恢复原文。
- **Why**: 树导航只移叶子指针、原文未丢，但块级解压只从活动分支取数，导致撤销区间内的块无法还原全文。
- **Behavior / compatibility changes**: No——仅新增缺失消息补全路径；无缺失时行为不变；`.acp.json` 结构不变
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `716e3b9` | fix: block decompress falls back to full session tree after tree navigation（基于 `f472485 release v0.1.35`） |

### Key Files

- `src/decompress-tool.ts` — +33/-2：新增 `resolveBlockMessages`（双侧 `#` 归一化 + `getEntry` 全量树补全 + `entriesToCoreMessages` 重投影 + 无缺失短路）；`handleDecompress` 块级分支改用 resolved 结果
- `tests/decompress-tool.test.ts` — +162：4 个新测试（undo fallback / 降级保留 / 多 tool-call `#` 归一化 / 多轮状态）

## 3. Design & Implementation Notes

- **Entry point / key function**: `resolveBlockMessages`（`src/decompress-tool.ts:111-138`），`handleDecompress` 调用点 `:205`
- **Key configuration items**: 无新配置
- **Key logic explanation**: block 存 CoreMessage id（多 tool-call 带 `#`），`getEntry()` 键是 SessionEntry id——两侧归一化到 baseId 再比较；取回的 entry 重投影拆回 `#` 后缀 CoreMessage，命中 `collectBlockContent` 的 `targetIds` 集合

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck      # PASS
npm test               # PASS 237/237（原 233 + 新 4）
npm run build          # PASS（产物已安装到 ~/.pi/agent/npm/node_modules/billion-context-pi/dist/）
```

### Test Coverage

- New/modified test files: `tests/decompress-tool.test.ts`（+4 测试）
- Test count: 237 total, 237 pass, 0 fail
- Key scenarios verified: undo 后原文恢复；全树缺失保留降级；多 tool-call `#` 归一化；多轮 compress→navigate→decompress

### Results

- **PASS/FAIL**: PASS
- **Key logs/data**: 产物级 before/after 对比（旧/新 `dist/index.js` bundle 跑同一场景）——旧返回 `Block b1 has no restorable message content.`，新返回 `Restored block b1 (1 item) inline:` + 原文全文

## 5. Risk Assessment & Rollback

- **Risk points**: 补全路径仅解压时触发、只读；`getEntry` 返回非 message entry 由 `entriesToCoreMessages` 跳过
- **Rollback method**: `git revert 716e3b9`
- **Compatibility notes**: 无 schema/数据格式变更

## 6. Lessons Learned (optional)

- 同一概念多处实现、口径不一致即根因信号（块级取活动分支 vs 单消息取全量树）
- 单测全绿 ≠ 产物正确：安装到 Pi 的 `dist/index.js` 需产物级验证（ESM 解析 external 宿主包、bundle 行为）
- ESM 调试坑：`.bak` 后缀不被 Node ESM 识别；external 包按 bundle 所在目录向上解析 node_modules

## 7. Follow-ups (optional)

- [ ] PR #133 合并（AGENTS.md：human-only）
- [ ] 重启 Pi 后真实环境验证（装 workspace-history，`/undo` 后 `decompress` 块）
