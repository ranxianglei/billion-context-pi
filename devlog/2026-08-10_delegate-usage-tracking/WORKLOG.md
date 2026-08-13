# WORKLOG: delegate LLM usage tracking (issue #105, PR #106)

- Task ID: `2026-08-10_delegate-usage-tracking`
- Home Repo: `billion-context-pi`
- Status: Done
- Updated: 2026-08-13

## 1. Summary

- **What was done**: PR #106 parses the delegate child's Pi JSON stream
  `message_end` events to track sub-agent LLM usage (tokens + cost), accumulates
  it across calls, surfaces it in the footer + `/acp-status` + wait/cancel tool
  results, force-kills a hung delegate ~10s after `agent_settled` (was ~5 min
  idle-watchdog floor), and adds a `displayUsage` config.
- **Why**: sub-agent cost/token accounting was invisible; hung delegates stalled
  the main session.
- **Behavior / compatibility changes**: Yes — additive. New `displayUsage` config
  (default `separate`); new footer line; delegate now force-exits faster on
  `agent_settled`. Users not reading the new fields see no behavior change.
- **Risk level**: Medium (new stream parsing + process-kill timing change).

## 2. Change Log

### Commits (author)

| Commit | Description |
|--------|-------------|
| `7edc762` | feat: track delegate LLM usage + separate display mode (#105) |
| `8fdb60d` | merge of `origin/master` into the PR branch (the branch tip merged at `1bf6bb4`) |

### Merge resolution (by maintainer side)

The PR was opened against an older master. After `#121/#123/#124/#125` landed,
it conflicted. Resolved in merge commit `1bf6bb4` (parents `[8fdb60d, 4c058eb]`),
pushed to the author's fork `Tyan66666:fix/105-delegate-usage-tracking`.

### Post-review fixes

A cross-platform/regression review found minor issues, all fixed in follow-up
commits on `resolve-pr106`:

- **R1 — footer `setStatus` churned every 500ms tick when there was no usage**
  (`src/footer-status.ts`). The dedup compared `text` against `lastFooterText`,
  but `lastFooterText = text ?? ""` normalised `undefined` to `""` *after* the
  comparison, so the empty state never matched. Fix: compare `(text ?? "")` on
  both sides, and reset `lastFooterText` to `undefined` in `initFooterStatus`
  so the first refresh of each session always fires (defensive clear) while
  subsequent identical ticks dedup.
- **R2 (onKill) — a post-`agent_settled` force-kill was mislabeled
  `(timed out: ...)`** (`src/delegate-tool.ts`). After `agent_settled` the agent
  flow is complete and the reply is already streamed, so a watchdog kill is stuck
  teardown, not a timeout. Fix: track `run.agentSettled` (set in the `onSettled`
  callback); in `onKill`, only set `run.timedOut` when `!run.agentSettled`.
  Localized to `delegate-tool.ts`; `watchdog.test.ts` unaffected.
- **R2 (onEofGrace) — the same mislabel also affected the EOF-grace path**
  (`src/delegate-tool.ts`). `onEofGrace` set `run.timedOut` unconditionally, so a
  post-`agent_settled` teardown where stdout closed but the process lingered
  could still be labeled a timeout. Fix: mirror the `if (!run.agentSettled)`
  guard in `onEofGrace`.
- **Usage double-count on inject failure** (`src/delegate-tool.ts`). In
  `separate` mode `addDelegateUsage` runs before the `send.call` try, but
  `usageReported` was only set when `injected` succeeded; a later `wait` on a
  finished-but-not-injected run re-accumulated. Fix: set `usageReported` whenever
  the terminal inject path ran and usage was accounted/delivered
  (`mode === "separate" || injected`).
- **R4 — `displayUsage` side-channel** (`src/index.ts`, `src/delegate-tool.ts`).
  Replaced `(pi as unknown as Record<string, unknown>).displayUsage` reads/write
  with a module-level `delegateDisplayUsage` + `setDelegateDisplayUsage()` setter,
  called in `session_start`. A default reset (`"separate"`) runs before the
  config-load try so a config-load failure can't leak a stale mode from a prior
  session.
- **R9 — regression tests**: footer churn-dedup (`tests/footer-status.test.ts`),
  CRLF line tolerance + partial-usage-fills-0 (`tests/events.test.ts`).

### Key Files

- `src/delegate-events.ts` — modified (pre-existed on master). Added `Usage`
  interface, `handleMessageEnd`, `usage-update` / `agent_settled` event parsing.
- `src/delegate-tool.ts` — `makeEventApplier` (master refactor) extended with
  `onUsage` / `onSettled` callbacks; `accumulateUsage`; `buildChildArgs`;
  `delegateSpawnOptions`; usage returned from wait/cancel.
- `src/delegate-watchdog.ts` — modified (pre-existed on master). Added
  `settledGrace` to `attachWatchdogs` (reuses existing SIGTERM→SIGKILL
  escalation).
- `src/footer-status.ts` — NEW (genuinely new file). `sub-agents ↑in ↓out ($cost)`
  footer line.
- `src/index.ts` — `/acp-status` delegate usage section; `resetDelegateUsage()`
  + `setDelegateDisplayUsage("separate")` on `session_start` / reload / restart.

## 3. Design & Implementation Notes

- **Entry point / key function**: `makeEventApplier` dispatches stream events;
  `accumulateUsage(run.usage, ev.usage)` sums per-call usage; only assistant
  `message_end` events carry usage (filtered by `msg.role === "assistant"`).
- **Conflict resolution**: master refactored the spawn's inline event-handling
  closure into `makeEventApplier` (for unit-testability). #106 had added
  `usage-update` / `agent-settled` branches to the old inline closure. Resolved
  by keeping `makeEventApplier` and adding optional `onUsage` / `onSettled`
  callbacks (keeps the applier testable — no hard dependency on `run` /
  `watchdog`), wired at the spawn call site.
- **`agent_settled` kill**: Pi emits `agent_settled` exactly once in the
  `finally` of `_runAgentPrompt`; a normal exit follows within milliseconds. If
  the child is still alive after `SETTLED_GRACE_MS` (10s), it is genuinely hung
  in teardown → `killByWatchdog` (SIGTERM, escalate to SIGKILL). Idempotent.

## 4. Testing & Verification

```sh
npm run typecheck   # 0 errors
npm test            # 233 pass / 0 fail
npm run build       # success
```

- New/modified test files: `tests/delegate-tool.test.ts`, `tests/events.test.ts`,
  `tests/watchdog.test.ts`, `tests/footer-status.test.ts`.
- Test count: 233 total, 233 pass, 0 fail (master 211 + #106 net new).
- `pr-validation` fails only on the `fix/...` branch name (regex requires
  `YYYY-MM-DD_...`); overridden at merge, same as the other recent PRs.

## 5. Risk Assessment & Rollback

- **Risk points**:
  - Malformed/missing usage fields — handled by `safeNumber` / `safeCost` (fill 0);
    covered by `tests/events.test.ts`.
  - `agent_settled` force-kill could theoretically hit a legitimately slow
    teardown; mitigated by the 10s grace + the fact Pi emits `agent_settled`
    only after the agent flow is fully done. The misleading `(timed out: ...)`
    label for such kills is suppressed via `run.agentSettled` on both the
    `onKill` and `onEofGrace` paths (see R2).
  - Cross-platform: process kill reuses the existing SIGTERM→SIGKILL
    `killByWatchdog` (SIGKILL is reliable on Windows); the new `settledGrace`
    path adds no new signal behavior.
- **Rollback method**: revert PR #106.
- **Compatibility notes**: additive config field `displayUsage`; no persisted
  state schema change.

## 6. Follow-ups

- [ ] Rename the PR branch to a `YYYY-MM-DD_...` name to satisfy `pr-validation`
      (currently overridden at merge).
- [x] Remove `PROPOSAL.md` from the repo root — content now lives here as
      `DESIGN.md` (done in the devlog-establishment commit).
