# REQ: delegate LLM usage tracking (issue #105, PR #106)

- Task ID: `2026-08-10_delegate-usage-tracking`
- Home Repo: `billion-context-pi`
- Created: 2026-08-10
- Status: Done
- Priority: P1
- Owner: Tyan66666
- References: issue #105, PR #106

## 1. Background & Problem Statement

- **Context**: `acp_delegate` spawns a subagent (a child `pi` process) to run a
  delegated task. The child streams a Pi JSON event stream back.
- **Current behavior (symptom)**: The subagent's LLM usage (input/output tokens,
  cache tokens, cost) is **not tracked** in the main session's usage statistics.
  The delegate's token consumption is invisible, so the main session's cost
  accounting is inaccurate. Additionally, the delegate's injected "wait" /
  "cancel" notifications never displayed usage, and a hung delegate could hold
  its stdout fd open for up to ~5 minutes (the idle-watchdog floor) before being
  killed.
- **Expected behavior**: subagent usage is accumulated from the stream and
  surfaced in the footer, `/acp-status`, and the wait/cancel tool results; a
  delegate that has reported `agent_settled` but fails to exit is force-killed
  within ~10s.
- **Impact**: inaccurate cost/token accounting; long stalls on hung delegates.

## 2. Root Cause

1. `DelegateRun` (`src/delegate-tool.ts`) had no `usage` field.
2. `parseEventLine` (`src/delegate-events.ts`) did not parse `message_end`
   events — the Pi JSON stream carries per-call `usage` in these events.
3. `DelegateWaitTool` / `DelegateCancelTool` returned `{ details, content }`
   without `usage`.
4. The "injection-notify shows no usage" chain: `injectResult` never called
   `addDelegateUsage`; the waiter callback did not receive `displayMode`;
   `displayUsage` was declared but never wired; an `as` precedence bug.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: existing delegate behavior for users who do not opt
    into the new display must not change.
  - Node >= 20; cross-platform (Linux / macOS / Windows).
- **Non-Goals**: changing the Pi stream protocol; per-call (non-cumulative)
  usage attribution to individual messages.

## 4. Acceptance Criteria

- [x] `message_end` usage is parsed from the child stream and accumulated.
- [x] Wait/cancel tool results carry accumulated `usage`.
- [x] Footer shows a `sub-agents` line; `/acp-status` shows a delegate usage
      section.
- [x] `agent_settled` triggers a ~10s grace force-kill of a non-exiting child.
- [x] `resetDelegateUsage()` zeroes the accumulator on reload/restart.
- [x] New test cases added and passing (see WORKLOG).

## 5. Proposed Approach

See `DESIGN.md` (moved from the original `PROPOSAL.md`).

- **Affected modules & entry files**: `src/delegate-events.ts`,
  `src/delegate-tool.ts`, `src/delegate-watchdog.ts`, `src/footer-status.ts`,
  `src/index.ts`.
- **Risks**: see DESIGN + WORKLOG risk sections (malformed usage events,
  settled-kill of a legitimately slow process, cross-platform process kill).
- **Rollback strategy**: revert PR #106.
