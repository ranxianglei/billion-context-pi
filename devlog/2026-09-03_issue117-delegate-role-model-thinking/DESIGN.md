# DESIGN - Per-role delegate default model + thinking level

- Task ID: `2026-09-03_issue117-delegate-role-model-thinking`
- Home Repo: `billion-context-pi`
- Created: 2026-09-03
- Status: Accepted

## 1. Goals & Non-Goals

- **Goals**:
  - Persistently configure a default model and thinking level per delegate role, plus a global default thinking level.
  - Deterministic resolution with per-call overrides preserved.
  - Graceful degradation when a configured model is unknown (warn + fall back, never fail).
  - Zero-config backward compatibility (byte-identical CLI args to before).
- **Non-Goals**:
  - No system-prompt model-list injection (owner chose config over prompt).
  - No auto-inheritance of the parent's live `thinkingLevel`.
  - No OMP support (delegates are Pi-only by construction).

## 2. Background & Motivation

`acp_delegate` fans out pi sub-processes. Cost scales with the number of parallel delegates × the parent model, because every child inherits the parent model. Operators want cheap/long-context models for `reviewer`/`researcher`, a strong implementer for `worker`, a high-reasoning `oracle` — without the main agent having to remember `model:` on every call. Reasoning/thinking was previously unconfigurable (always Pi default).

## 3. Current Architecture (as-is)

- `buildChildArgs(args, rolePrompt, ctx, runId)` in `src/delegate-tool.ts` built `cliArgs`. Model was: `if (args.model?.includes("/")) split → --provider/--model; else if (ctx.model) → --provider/--model (inherit)`. No reasoning handling.
- Config: `DelegateConfig { enabled?, displayUsage? }`; `resolveDelegate()` returned `{enabled, displayUsage}` only.
- `src/index.ts` threaded `displayUsage` into the tool via a module-level setter at `session_start`.

## 4. Proposed Design (to-be)

- **Module / data-flow changes**:
  - `src/config.ts`: `resolveDelegate` now returns `ResolvedDelegate { enabled, displayUsage, thinkingLevel?, agents? }`. Additive fields; boolean-shorthand / unset object leave them undefined.
  - `src/index.ts`: at `session_start`, after `reloadConfig`, call `setDelegateDefaults({ thinkingLevel, agents })` alongside the existing `setDelegateDisplayUsage`.
  - `src/delegate-tool.ts`: module state `delegateDefaults` + `setDelegateDefaults` / `resetDelegateDefaults` (mirrors the existing `setDelegateDisplayUsage` pattern — avoids changing `buildChildArgs`'s signature, which many tests call directly). Resolution happens inside `buildChildArgs`, which already receives `ctx` (has `model`, `modelRegistry`).
- **New types / interfaces**:
  - `DelegateRoleConfig { model?: string; thinkingLevel?: string }`
  - `DelegateConfig.thinkingLevel?: string`, `DelegateConfig.agents?: Record<string, DelegateRoleConfig>`
  - `ResolvedDelegate` (exported)
  - `VALID_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]` + `isValidThinkingLevel(v)` type guard
  - `DelegateParams.thinkingLevel?` (optional schema param)
- **Resolution logic** (in `buildChildArgs`):
  - MODEL priority **call > role > inherit**:
    ```
    const roleCfg = delegateDefaults.agents?.[args.agent];
    normalizeModelRef(args.model) ?? normalizeModelRef(roleCfg?.model)
      → else inherit ctx.model.provider/id   (source tracked as "call"|"role"|"inherit")
    ```
    Only when `source === "role"` is the ref validated: `ctx.modelRegistry?.find(provider, modelId)`; if missing → `logWarn(role-model-missing)` + fall back to parent (if `ctx.model` exists), else keep the ref. Then push `--provider <p> --model <m>`.
  - THINKING priority **call > role > global > Pi default**:
    ```
    pickFirstDefined([args.thinkingLevel, roleCfg?.thinkingLevel, delegateDefaults.thinkingLevel])
    → valid ? push --thinking <lvl> : logWarn(invalid-thinking-level)   // no cascade
    ```
- **New files**: none (all edits in existing modules + devlog).

## 5. Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Thread config through `buildChildArgs` params | Explicit, no hidden state | Changes signature; every test caller must update | Rejected |
| Module-level setter (`setDelegateDefaults`) | Mirrors existing `setDelegateDisplayUsage`; stable signature; easy test reset | Hidden module state | **Chosen** |
| Validate ALL model sources (call+role+inherit) against registry | Uniform safety | Breaks legit custom/non-catalog per-call models pi resolves itself | Rejected — validate **role** only |
| Cascade invalid thinking to lower priority | More "forgiving" | Non-deterministic; hides a bad explicit value | Rejected — drop highest-priority defined value, warn |
| Auto-inherit parent `thinkingLevel` | Fewer config lines | Changes no-config behavior (violates compat req) | Rejected |

## 6. Risks & Trade-offs

- **Backward compatibility**: Zero-config path emits identical CLI args (no `--thinking`, same provider/model inheritance). Verified by existing inheritance/override tests still passing.
- **Performance**: One optional `registry.find()` per role-sourced model launch; negligible. No new deps.
- **Cross-platform** (Node >=20; Linux / macOS / Windows): Pure arg-building logic, no platform-specific code. Full e2e env not yet ready (owner); unit coverage here, owner to do windows/linux e2e.

## 7. Open Questions

- Whether to also surface the resolved effective model/thinking in the delegate completion notice (nice-to-have; not required by issue). Deferred.
