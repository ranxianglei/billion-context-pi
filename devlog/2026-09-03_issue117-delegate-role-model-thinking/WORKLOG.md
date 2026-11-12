# WORKLOG - Per-role delegate default model + thinking level

- Task ID: `2026-09-03_issue117-delegate-role-model-thinking`
- Home Repo: `billion-context-pi`
- Status: Done
- Updated: 2026-09-03 23:15

## 1. Summary

- **What was done** (1–3 sentences): Added per-role default model + thinking-level configuration for `acp_delegate` (`delegate.agents.<role>.{model,thinkingLevel}` plus global `delegate.thinkingLevel`), threaded into child-process CLI args with deterministic call > role > inherit (model) and call > role > global (thinking) priority.
- **Why** (1–3 sentences): Delegates previously always inherited the parent model and had no reasoning control, so parallel fan-out multiplied cost and forced the main agent to pass `model:` every time. Persistent per-role config enables cheap/long-context models for `reviewer`/`researcher`, strong implementers for `worker`, high-reasoning `oracle` (#117).
- **Behavior / compatibility changes**: Yes — additive only. With **no** config the launched CLI args are byte-identical to before (inherit parent, no `--thinking`). New optional `acp_delegate` param `thinkingLevel`.
- **Risk level**: Low.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `8f7a68c` | feat(delegate): per-role default model + thinking level (closes #117) |

### Key Files

- `src/config.ts` — new `DelegateRoleConfig`; extended `DelegateConfig` (+`thinkingLevel`, +`agents`) and `resolveDelegate` return type `ResolvedDelegate` (+`thinkingLevel`, +`agents`). Additive fields.
- `src/delegate-tool.ts` — module defaults (`setDelegateDefaults`/`resetDelegateDefaults`); `VALID_THINKING_LEVELS` + `isValidThinkingLevel`; optional `DelegateParams.thinkingLevel`; model resolution (call > role > inherit) with role-model registry validation + warn-and-fallback; thinking resolution (call > role > global) with warn-and-drop on invalid.
- `src/index.ts` — thread resolved `thinkingLevel`/`agents` into the tool at `session_start` via `setDelegateDefaults`.
- `tests/config.test.ts` — 3 new `resolveDelegate` cases (agents/thinking passthrough; boolean shorthand; unset object).
- `tests/delegate-tool.test.ts` — helpers `flagVal` + `ctxWithRegistry`; ~16 cases covering model priority, missing/malformed role-model fallback, slash-in-id split, thinking priority, no-flag default, invalid-value drop, `isValidThinkingLevel`.
- `CONFIGURATION.md`, `CONFIGURATION.zh-CN.md` — summary-table rows + subsections for `delegate.thinkingLevel` and `delegate.agents` (with example).
- `CHANGELOG.md` — bullet under Unreleased.

## 3. Design & Implementation Notes

- **Entry point / key function**: `buildChildArgs(args, rolePrompt, ctx, runId)` in `src/delegate-tool.ts` (already receives `ctx` with `.model` / `.modelRegistry`). Config reached via module-level `delegateDefaults` (mirrors existing `setDelegateDisplayUsage`), keeping the signature stable for direct test callers.
- **Key configuration items**: `delegate.thinkingLevel` (global), `delegate.agents.<role>.model` (`"provider/id"`), `delegate.agents.<role>.thinkingLevel`; per-call `acp_delegate({ model?, thinkingLevel? })`.
- **Key logic explanation** (if non-trivial):
  - Model: `normalizeModelRef(args.model) ?? normalizeModelRef(roleCfg?.model) ?? inherit ctx.model`. Only `source === "role"` refs are validated via `ctx.modelRegistry?.find(provider, modelId)`; a miss logs `role-model-missing` and falls back to the parent model (never throws). Per-call and inherited refs pass through untouched so custom/non-catalog models pi resolves itself still work. `prov/a/b` splits on the first slash.
  - Thinking: `pickFirstDefined([args.thinkingLevel, roleCfg?.thinkingLevel, delegateDefaults.thinkingLevel])`; valid level → `--thinking <lvl>`; invalid → log `invalid-thinking-level` and drop (no cascade); none set → no flag (Pi default preserved).
  - `registry.find` is guarded with runtime truthiness because test mocks omit `modelRegistry`.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck      # tsc --noEmit
npm test               # node --import tsx --test tests/*.test.ts
npm run build          # tsup && tsc --emitDeclarationOnly
```

### Test Coverage

- New/modified test files: `tests/config.test.ts`, `tests/delegate-tool.test.ts`.
- Test count: full suite 488 total, 485 pass, 0 fail, 3 pre-existing skips. ≈19 new cases added.
- Key scenarios verified:
  - Model priority call > role > inherit; missing role model → fallback + warning; malformed role model ignored; `prov/a/b` first-slash split.
  - Thinking priority call > role > global; no flag when unset; invalid value dropped without cascade; `isValidThinkingLevel` boundary set.
  - `resolveDelegate` returns new fields; backward-compat (unset) leaves them undefined.

### Results

- **PASS/FAIL**: PASS — typecheck exit 0; full suite green; build success (self-contained dist, acp-kernel inlined).

## 5. Risk Assessment & Rollback

- **Risk points**: Low. Additive config; zero-config path unchanged; registry lookup guarded against mocks lacking `modelRegistry`. Full e2e env not yet available (owner) — unit coverage here, owner to run windows/linux e2e.
- **Rollback method**:
  - Revert commit(s): `8f7a68c`
  - Rollback impact: None — config keys are additive and simply ignored by prior code; no data migration.
- **Compatibility notes** (data format, config schema): No breaking change. `ResolvedDelegate` gains optional fields only.

## 6. Lessons Learned (optional)

- What went well: Reusing the existing module-setter pattern avoided touching `buildChildArgs`'s signature and every test caller.
- What could be improved: Surfaceing the resolved effective model/thinking in the completion notice would help debugging (deferred).
- Reusable conclusions: Validate *persisted* config against the registry (fail-safe) but pass *explicit momentary* overrides through untouched — protects automation from bad config while preserving advanced usage.

## 7. Follow-ups (optional)

- [ ] Owner e2e on windows + linux (full env pending).
- [ ] Optional: report resolved effective model/thinking level in the delegate completion notice.
