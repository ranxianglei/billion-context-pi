# REQ - Per-role delegate default model + thinking level

- Task ID: `2026-09-03_issue117-delegate-role-model-thinking`
- Home Repo: `billion-context-pi`
- Created: 2026-09-03
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: issue #117 (https://github.com/ranxianglei/billion-context-pi/issues/117)

## 1. Background & Problem Statement

- **Context**: `acp_delegate` spawns pi sub-processes for roles (`reviewer`, `researcher`, `worker`, `planner`, `oracle`). Today a child only gets a model via the per-call `model: "provider/id"` param; otherwise it inherits the parent agent's current provider/model. There is no way to persistently pin a model or reasoning/thinking level per role, and no reasoning/thinking control at all.
- **Current behavior (symptom)**: Every delegate inherits the parent model. If the main agent runs an expensive high-capability model, every parallel delegate pays that cost. Relying on the main agent to fill `model:` correctly on each call is fragile. Reasoning/thinking level is always the Pi process default — not configurable, not inherited explicitly.
- **Expected behavior**:
  - Configure a default model per delegate role (and optionally a global default thinking level).
  - Model resolution priority: per-call `model` > role default > parent current model.
  - Thinking level priority: per-call > role > global > Pi default.
  - If a configured role model does not exist → fall back (to parent) and log a warning, NEVER fail (owner: "omo 的教训").
  - No configuration → behavior unchanged (inherit parent + Pi default).
- **Impact**: Long-running multi-role automation; cost control when fan-out delegates run in parallel; stable per-role capability tuning without depending on the main agent remembering to pass `model`.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: >=20 (runtime), tested on Linux
  - OS/Arch: linux (owner test matrix: windows + linux; mac expected fine)
- **Minimal reproduction steps**:
  1) With no `delegate.agents` config, any `acp_delegate({agent:"worker"})` child inherits the parent model and gets no `--thinking` flag.
  2) After adding `delegate.agents.worker.model = "provider/model-b"`, the child launches with `--provider provider --model model-b`.
  3) If that model is absent from the registry, the child falls back to the parent model and a `role-model-missing` warning is logged (no failure).
- **Relevant configuration**: `~/.pi/agent/acp.json` → `delegate.thinkingLevel`, `delegate.agents.<role>.{model,thinkingLevel}`.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: with zero config the launched CLI args must be byte-identical to before (inherit parent, no `--thinking`).
  - A missing *role-configured* model must degrade gracefully (warn + fall back), never throw/fail the delegate.
  - Per-call `model` overrides must keep working exactly as before, including custom/non-catalog `provider/id` strings that pi resolves itself.
  - OMP hosts do not register delegate tools, so this feature is Pi-only by construction (no omp guard needed).
- **Non-Goals** (explicitly out of scope):
  - Injecting the available model list into the system prompt (owner preferred config over prompt injection).
  - Per-call reasoning-effort values beyond pi's discrete `--thinking` levels.
  - Auto-inheriting the parent's live `thinkingLevel` (would change default behavior); explicit config only.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] Model resolution honors call > role > inherit priority.
  - [x] Role-configured model validated against `ctx.modelRegistry.find()`; missing → fall back to parent + `role-model-missing` warning (no failure).
  - [x] Malformed role model (no `/`) is ignored → inherit parent.
  - [x] `provider/a/b` splits on the FIRST slash (provider=`prov`, model=`a/b`).
  - [x] Thinking level honors call > role > global priority; emitted as `--thinking <level>`.
  - [x] No thinking value anywhere → no `--thinking` flag (Pi default preserved).
  - [x] Invalid thinking value → dropped with `invalid-thinking-level` warning, no cascade to lower priority.
  - [x] `isValidThinkingLevel` accepts exactly off|minimal|low|medium|high|xhigh|max.
  - [x] `resolveDelegate` returns `thinkingLevel` + `agents`; boolean shorthand / unset object leave them undefined.
- **Performance / Stability**:
  - [x] No new runtime deps; acp-kernel still bundled inline (self-contained dist).
  - [x] Module-default setter/reset keeps tests isolated (no cross-test leakage).
- **Regression**:
  - [x] New/modified test cases added to test suite and passing (config + delegate-tool suites green; full suite green).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `src/config.ts` — new `DelegateRoleConfig`, extend `DelegateConfig` + `ResolvedDelegate`, extend `resolveDelegate`.
  - `src/delegate-tool.ts` — module defaults setter, `VALID_THINKING_LEVELS` + guards, `thinkingLevel` schema param, model/thinking resolution in `buildChildArgs`.
  - `src/index.ts` — thread resolved `thinkingLevel`/`agents` into the tool at `session_start`.
  - `tests/config.test.ts`, `tests/delegate-tool.test.ts` — coverage.
  - Docs: `CONFIGURATION.md`, `CONFIGURATION.zh-CN.md`, `CHANGELOG.md`.
- **Risks**: Low. Additive config; no-config path unchanged; validation guarded against mocks lacking `modelRegistry`.
- **Rollback strategy**: Revert the single feature commit; config keys are additive and ignored by prior code, so no data migration needed.
