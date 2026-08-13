# Issue #105: Delegate Usage Tracking

## Problem

When `acp_delegate` spawns a subagent, the subagent's LLM usage (input/output tokens, cost) is **not tracked** in the main session's usage statistics. This makes the main session's cost accounting inaccurate — the delegate's token consumption is invisible.

## Root Cause

1. **`DelegateRun` interface** (`delegate-tool.ts:93-113`) has no `usage` field
2. **`parseEventLine`** (`delegate-events.ts:91-155`) doesn't parse `message_end` events — the Pi JSON stream carries `usage` data in these events
3. **`DelegateWaitTool`** returns `{ details, content }` without `usage`
4. **`DelegateCancelTool`** returns `{ details, content }` without `usage`

## Solution Design

### Pi SDK `Usage` Interface

From `@earendil-works/pi-ai/dist/types.d.ts` (line 260):

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

Per Pi docs: *"If a tool makes nested LLM calls, return their combined `Usage` as `usage`. Pi persists it on the tool result and includes it in footer, `/session`, and RPC session totals."*

### Changes Overview

| File | Change |
|------|--------|
| `src/delegate-events.ts` | Add `Usage` type export, `UsageUpdateEvent`, parse `message_end` |
| `src/delegate-tool.ts` | Add `usage` to `DelegateRun`, accumulate from stream, return in wait/cancel, usage-injection helper |

### Design Constraints (from review)

- **`message_end` usage is per-call, not cumulative** — each assistant `message_end` carries that single LLM call's usage. Summing is correct today but if Pi switches to cumulative usage, accumulation would double-count. Add a code comment + regression fixture.
- **Only assistant messages carry usage** — filter by `msg.role === "assistant"` to avoid future-proofing bugs.
- **`cacheWrite1h` is a subset of `cacheWrite`** — summing both independently is correct (pi's own `addUsageToTotals` ignores both in totals; only input/output/cacheRead/cacheWrite/cost.total count).

---

## Implementation Plan

### Step 1: Single source of truth for `Usage` type (`delegate-events.ts`)

`pi-coding-agent` does not re-export `Usage` from `@earendil-works/pi-ai`. Define it once in `delegate-events.ts` and import from there in `delegate-tool.ts`.

```typescript
// src/delegate-events.ts
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

### Step 2: Add `UsageUpdateEvent` + parse `message_end` (`delegate-events.ts`)

```typescript
export interface UsageUpdateEvent {
  kind: "usage-update";
  usage: Usage;
}
```

Update `ParsedEvent` union to include `UsageUpdateEvent`.

In `parseEventLine`, add handling for `message_end`:

```typescript
if (e.type === "message_end") {
  const msg = e.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return null;
  // Only accumulate usage from assistant messages
  if (msg.role !== "assistant") return null;
  const u = msg.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return null;
  // Defensive: cost may be missing/null/malformed
  const costRaw = u.cost as Record<string, unknown> | undefined;
  const cost = (costRaw && typeof costRaw === "object") ? {
    input: Number.isFinite(Number(costRaw.input)) ? Number(costRaw.input) : 0,
    output: Number.isFinite(Number(costRaw.output)) ? Number(costRaw.output) : 0,
    cacheRead: Number.isFinite(Number(costRaw.cacheRead)) ? Number(costRaw.cacheRead) : 0,
    cacheWrite: Number.isFinite(Number(costRaw.cacheWrite)) ? Number(costRaw.cacheWrite) : 0,
    total: Number.isFinite(Number(costRaw.total)) ? Number(costRaw.total) : 0,
  } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    kind: "usage-update",
    usage: {
      input: safeNumber(u.input),
      output: safeNumber(u.output),
      cacheRead: safeNumber(u.cacheRead),
      cacheWrite: safeNumber(u.cacheWrite),
      totalTokens: safeNumber(u.totalTokens),
      // Preserve undefined for absent optionals (not coerce to 0)
      ...(u.cacheWrite1h != null ? { cacheWrite1h: safeNumber(u.cacheWrite1h) } : {}),
      ...(u.reasoning != null ? { reasoning: safeNumber(u.reasoning) } : {}),
      cost,
    },
  };
}

function safeNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
```

**Key decisions**:
- Only `msg.role === "assistant"` → avoids capturing toolResult/nested delegate usage
- `Number.isFinite` guards → NaN from malformed data doesn't poison sums
- Absent optionals preserved as `undefined` → consistent with `accumulateUsage` helper
- Entire `message_end` branch is defensive → untrusted child stream can't crash host

### Step 3: Add `usage` to `DelegateRun` (`delegate-tool.ts`)

```typescript
import type { Usage } from "./delegate-events.js";

interface DelegateRun {
  // ... existing fields ...
  usage?: Usage;
  usageReported?: boolean;  // Prevent double-count on repeated waits/cancels
}
```

### Step 4: Extract `accumulateUsage` pure helper (`delegate-tool.ts`)

```typescript
export function accumulateUsage(existing: Usage, incoming: Usage): Usage {
  return {
    input: existing.input + incoming.input,
    output: existing.output + incoming.output,
    cacheRead: existing.cacheRead + incoming.cacheRead,
    cacheWrite: existing.cacheWrite + incoming.cacheWrite,
    cacheWrite1h: (existing.cacheWrite1h != null || incoming.cacheWrite1h != null)
      ? (existing.cacheWrite1h ?? 0) + (incoming.cacheWrite1h ?? 0)
      : undefined,
    reasoning: (existing.reasoning != null || incoming.reasoning != null)
      ? (existing.reasoning ?? 0) + (incoming.reasoning ?? 0)
      : undefined,
    totalTokens: existing.totalTokens + incoming.totalTokens,
    cost: {
      input: existing.cost.input + incoming.cost.input,
      output: existing.cost.output + incoming.cost.output,
      cacheRead: existing.cost.cacheRead + incoming.cost.cacheRead,
      cacheWrite: existing.cost.cacheWrite + incoming.cost.cacheWrite,
      total: existing.cost.total + incoming.cost.total,
    },
  };
}
```

### Step 5: Accumulate usage in `runDelegate` (`delegate-tool.ts`)

In `handleEventLine` (inside the async branch of `runDelegate`):

```typescript
// NOTE: `run` is declared later at line 531; this closure captures it via
// lexical scope — safe because stdout `data` events fire after synchronous
// setup completes. See delegate-tool.ts:531.
if (ev.kind === "usage-update") {
  run.usage = run.usage ? accumulateUsage(run.usage, ev.usage) : ev.usage;
  return;
}
```

### Step 6: Return `usage` from `DelegateWaitTool` (`delegate-tool.ts`)

`makeDelegateWaitTool` has multiple return paths. Usage must be attached on all result-delivering paths, and guarded against double-count.

**Helper function**:

```typescript
// Helper to build usage-aware return payload
export function buildWaitResult(
  run: DelegateRun,
  content: Array<{ type: "text"; text: string }>,
): { details: undefined; content: typeof content; usage?: Usage } {
  if (run.usage && !run.usageReported) {
    run.usageReported = true;
    return { details: undefined, content, usage: run.usage };
  }
  return { details: undefined, content };
}
```

**Return paths** (actual line numbers from `delegate-tool.ts`):

| Line | Path | Usage behavior |
|------|------|----------------|
| 259 | not-found | No usage (n/a) |
| 265 | already-cancelled | No usage |
| 274-279 | already-injected dedup | `buildWaitResult` — usage reported if available, `usageReported` guards double-count |
| 286-287 | already-finished (with result) | `buildWaitResult` |
| 292 | already-waiting | No usage (n/a) |
| 316-321 | cancelled-after-park | No usage (partial) |
| 323 | parked-waiter (primary async) | `buildWaitResult` — requires `finish` restructure (see below) |
| 327 | timeout | No usage (still running) |

**Parked-waiter `finish` restructure** (N4 fix):

The existing `finish(text)` callback at line 306-309 builds the payload internally. To attach usage, change its signature:

```typescript
// Before:
const finish = (text: string) => {
  run.consumed = true;
  resolve({ details: undefined, content: [{ type: "text" as const, text }] });
};

// After:
const finish = (text: string) => {
  run.consumed = true;
  resolve(buildWaitResult(run, [{ type: "text" as const, text }]));
};
```

This way the parked-waiter path (line 323) automatically gets usage via `buildWaitResult` without further changes.

### Step 7: Return `usage` from `DelegateCancelTool` (`delegate-tool.ts`)

Same pattern — attach `usage` on the result-delivering paths, with `usageReported` guard:

```typescript
// Helper for cancel tool (same logic as buildWaitResult but for cancel context)
export function buildCancelResult(
  run: DelegateRun,
  text: string,
): { details: undefined; content: Array<{ type: "text"; text: string }>; usage?: Usage } {
  const content = [{ type: "text" as const, text }];
  if (run.usage && !run.usageReported) {
    run.usageReported = true;
    return { details: undefined, content, usage: run.usage };
  }
  return { details: undefined, content };
}

// Apply at both result-delivering paths:
// 1. Already-finished path
return buildCancelResult(run, `Cancelled ${runId} (${run.agent}). Run already finished with exit code ${run.exitCode}.`);

// 2. Killed path
return buildCancelResult(run, `Cancelled ${runId} (${run.agent}).`);
```

**Design decision**: Cancel returns partial usage (accumulated so far) — consistent with the "partial usage on cancel" known limitation.

### Step 8: Surface usage in injected notification text (`delegate-tool.ts`)

**B1 mitigation**: The default async path delivers results via `injectResult(pi, agent, runId, task, code, file, timedOut?)` → `pi.sendUserMessage(text, { deliverAs: "followUp" })`. This path **cannot** carry `usage` (the extension API doesn't support it).

The function signature has no `run` parameter. Pass `usage` as an optional parameter:

```typescript
// Change injectResult signature:
function injectResult(
  pi: PiContext,
  agent: string,
  runId: string,
  task: string,
  code: number,
  file: string | null,
  timedOut?: boolean,
  usage?: Usage,  // NEW optional parameter
): Promise<boolean> {
  // ... existing text building ...
  // After building the main text, before the try block:
  if (usage) {
    const cost = usage.cost.total;
    const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";
    text += `\n\n> delegate usage: ${usage.totalTokens} tokens${costStr}`;
  }

  try {
    // ... existing send.call(pi, ...) ...
    return true;
  } catch {
    return false;
  }
}
```

**Caller side** (line 596):

```typescript
// Before:
run.injected = true;
run.injectedWaitMessage = await injectResult(pi, run.agent, runId, run.task, run.exitCode ?? 1, resultFile, run.timedOut);

// After:
const injectedText = await injectResult(pi, run.agent, runId, run.task, run.exitCode ?? 1, resultFile, run.timedOut, run.usage);
run.injected = true;
run.injectedWaitMessage = injectedText;
```

**Note**: `usageReported` is deliberately NOT set here — the notification is text-only visibility. The dedup/wait path must still be able to report usage to Pi's session totals later.

### Step 9: Documentation — tool description update

Update `acp_delegate_wait` tool description to mention:
- The result carries the delegate's accumulated LLM usage in the `usage` field
- Usage is only recorded in session totals when the wait tool is called
- For async delegates, call `acp_delegate_wait` to capture usage in cost tracking

---

## Test Plan

### File: `tests/events.test.ts` — New tests

```typescript
// ─── message_end with usage ─────────────────────────────────────────────

test("parses message_end with full usage data", () => {
  const ev = parseEventLine(
    '{"type":"message_end","message":{"role":"assistant","usage":{"input":1000,"output":500,"cacheRead":200,"cacheWrite":100,"totalTokens":1800,"cost":{"input":0.003,"output":0.0015,"cacheRead":0.0001,"cacheWrite":0.0002,"total":0.0048}}}}'
  );
  assert.deepEqual(ev, {
    kind: "usage-update",
    usage: {
      input: 1000, output: 500, cacheRead: 200, cacheWrite: 100,
      totalTokens: 1800,
      cost: { input: 0.003, output: 0.0015, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0048 },
    },
  });
});

test("parses message_end with optional fields (cacheWrite1h, reasoning)", () => {
  const ev = parseEventLine(
    '{"type":"message_end","message":{"role":"assistant","usage":{"input":500,"output":200,"cacheRead":0,"cacheWrite":50,"cacheWrite1h":25,"reasoning":80,"totalTokens":750,"cost":{"input":0.001,"output":0.0006,"cacheRead":0,"cacheWrite":0.0001,"total":0.0017}}}}'
  );
  assert.ok(ev && ev.kind === "usage-update");
  assert.equal(ev.usage.cacheWrite1h, 25);
  assert.equal(ev.usage.reasoning, 80);
});

test("optional fields absent → undefined (not 0)", () => {
  const ev = parseEventLine(
    '{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150,"cost":{"input":0.001,"output":0.0005,"cacheRead":0,"cacheWrite":0,"total":0.0015}}}}'
  );
  assert.ok(ev && ev.kind === "usage-update");
  assert.equal(ev.usage.cacheWrite1h, undefined);
  assert.equal(ev.usage.reasoning, undefined);
});

// ─── defensive parsing (B3) ─────────────────────────────────────────────

test("cost missing → zeroes", () => {
  const ev = parseEventLine(
    '{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150}}}'
  );
  assert.ok(ev && ev.kind === "usage-update");
  assert.deepEqual(ev.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("cost: null → zeroes", () => {
  const ev = parseEventLine(
    '{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150,"cost":null}}}'
  );
  assert.ok(ev && ev.kind === "usage-update");
  assert.deepEqual(ev.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("cost fields as strings → coerced to numbers", () => {
  const ev = parseEventLine(
    '{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150,"cost":{"input":"0.001","output":"0.0005","cacheRead":"0","cacheWrite":"0","total":"0.0015"}}}}'
  );
  assert.ok(ev && ev.kind === "usage-update");
  assert.ok(Math.abs(ev.usage.cost.input - 0.001) < 1e-10);
});

test("cost fields as NaN string → 0 (no NaN propagation)", () => {
  const ev = parseEventLine(
    '{"type":"message_end","message":{"role":"assistant","usage":{"input":"not-a-number","output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}'
  );
  assert.ok(ev && ev.kind === "usage-update");
  assert.equal(ev.usage.input, 0);
});

// ─── role filtering (B5) ────────────────────────────────────────────────

test("ignores message_end from non-assistant role", () => {
  const ev = parseEventLine(
    '{"type":"message_end","message":{"role":"user","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}'
  );
  assert.equal(ev, null);
});

test("ignores message_end with no role", () => {
  const ev = parseEventLine(
    '{"type":"message_end","message":{"usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}'
  );
  assert.equal(ev, null);
});

// ─── existing tests ─────────────────────────────────────────────────────

test("ignores message_end without usage", () => {
  const ev = parseEventLine('{"type":"message_end","message":{"role":"assistant","content":[]}}');
  assert.equal(ev, null);
});

test("ignores message_end with malformed usage", () => {
  const ev = parseEventLine('{"type":"message_end","message":{"role":"assistant","usage":"not-an-object"}}');
  assert.equal(ev, null);
});

test("activityLines ignores usage-update events", () => {
  const lines = activityLines(
    { kind: "usage-update", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { showThinking: false },
  );
  assert.deepEqual(lines, []);
});

// ─── per-call vs cumulative regression fixture ──────────────────────────

test("two consecutive message_end events accumulate (per-call, not cumulative)", () => {
  // This is a regression fixture: if Pi switches to cumulative usage on messages,
  // this test will detect the double-count.
  const line1 = '{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150,"cost":{"input":0.001,"output":0.0005,"cacheRead":0,"cacheWrite":0,"total":0.0015}}}}';
  const line2 = '{"type":"message_end","message":{"role":"assistant","usage":{"input":200,"output":100,"cacheRead":0,"cacheWrite":0,"totalTokens":300,"cost":{"input":0.002,"output":0.001,"cacheRead":0,"cacheWrite":0,"total":0.003}}}}';

  const ev1 = parseEventLine(line1);
  const ev2 = parseEventLine(line2);

  assert.ok(ev1 && ev1.kind === "usage-update");
  assert.ok(ev2 && ev2.kind === "usage-update");

  // If usage were cumulative, ev2.input would already be 300 (100+200).
  // Per-call means each event has its own call's usage only.
  assert.equal(ev1.usage.input, 100);
  assert.equal(ev2.usage.input, 200);
});
```

### File: `tests/delegate-tool.test.ts` — New tests

```typescript
import { accumulateUsage, buildWaitResult, buildCancelResult } from "../src/delegate-tool.js";
import type { Usage } from "../src/delegate-events.js";

// ─── accumulateUsage ────────────────────────────────────────────────────

test("accumulateUsage sums tokens and costs correctly", () => {
  const a: Usage = { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, totalTokens: 1800, cost: { input: 0.003, output: 0.0015, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0048 } };
  const b: Usage = { input: 500, output: 300, cacheRead: 100, cacheWrite: 50, totalTokens: 950, cost: { input: 0.0015, output: 0.0009, cacheRead: 0.00005, cacheWrite: 0.0001, total: 0.00255 } };

  const result = accumulateUsage(a, b);
  assert.equal(result.input, 1500);
  assert.equal(result.output, 800);
  assert.equal(result.cacheRead, 300);
  assert.equal(result.cacheWrite, 150);
  assert.equal(result.totalTokens, 2750);
  assert.ok(Math.abs(result.cost.total - 0.00735) < 1e-10);
});

test("accumulateUsage handles optional cacheWrite1h and reasoning", () => {
  const a: Usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 10, reasoning: 20, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const b: Usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  const result = accumulateUsage(a, b);
  assert.equal(result.cacheWrite1h, 10);
  assert.equal(result.reasoning, 20);
});

test("accumulateUsage returns undefined for optional fields when both are undefined", () => {
  const a: Usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const b: Usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  const result = accumulateUsage(a, b);
  assert.equal(result.cacheWrite1h, undefined);
  assert.equal(result.reasoning, undefined);
});

// ─── buildWaitResult (B2 guard) ─────────────────────────────────────────

test("buildWaitResult attaches usage on first call", () => {
  const run = {
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 } },
    usageReported: false,
  } as any;

  const result = buildWaitResult(run, [{ type: "text", text: "done" }]);
  assert.ok(result.usage);
  assert.equal(result.usage.input, 100);
  assert.equal(run.usageReported, true);
});

test("buildWaitResult does not attach usage on second call (prevents double-count)", () => {
  const run = {
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 } },
    usageReported: true,  // Already reported
  } as any;

  const result = buildWaitResult(run, [{ type: "text", text: "done" }]);
  assert.equal(result.usage, undefined);
});

test("buildWaitResult works when run has no usage", () => {
  const run = { usageReported: false } as any;

  const result = buildWaitResult(run, [{ type: "text", text: "done" }]);
  assert.equal(result.usage, undefined);
});

// ─── buildCancelResult (N2 fix) ─────────────────────────────────────────

test("buildCancelResult attaches usage and sets usageReported", () => {
  const run = {
    agent: "researcher",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 } },
    usageReported: false,
  } as any;

  const result = buildCancelResult(run, "Cancelled.");
  assert.ok(result.usage);
  assert.equal(result.usage.input, 100);
  assert.equal(run.usageReported, true);
});

test("buildCancelResult does not double-count on repeated cancel", () => {
  const run = {
    agent: "researcher",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 } },
    usageReported: true,  // Already reported by first cancel
  } as any;

  const result = buildCancelResult(run, "Cancelled.");
  assert.equal(result.usage, undefined);
});
```

---

## Separate Display Mode (Issue #105 Enhancement)

### Problem

Users want delegate LLM usage displayed separately from main session usage, not merged into session totals.

### Design

**Config option**: `displayUsage?: "merged" | "separate"` (default: `"separate"`)

**Module-level accumulator** in `src/delegate-tool.ts`:
```typescript
let delegateUsageTotal: Usage | undefined;

export function addDelegateUsage(u: Usage): void {
  delegateUsageTotal = delegateUsageTotal
    ? accumulateUsage(delegateUsageTotal, u)
    : u;
}

export function getDelegateUsage(): Usage | undefined {
  return delegateUsageTotal;
}

export function resetDelegateUsage(): void {
  delegateUsageTotal = undefined;
}
```

**Helper functions** with `mode` parameter:
- `buildWaitResult(run, content, mode = "separate")`: In "merged" mode, returns `usage` in result. In "separate" mode, calls `addDelegateUsage()`.
- `buildCancelResult(run, content, mode = "separate")`: Same behavior.

**Notification format** in `injectResult`:
- `"separate"` mode: Shows cumulative delegate usage with label "Session delegate usage (excluded from main totals)"
- `"merged"` mode: Shows per-run usage (original behavior)

**Edge cases**:
- No usage → "N/A"
- Config reads latest value
- Timeout/abort paths return plain payloads without setting `usageReported`

### Implementation Status

✅ Implemented and tested (166 tests pass, typecheck clean)

### omp (Oh My Pi) Compatibility

**⚠️ Limitation**: Delegate usage tracking only works on **pi host**, not on **omp**.

**Reason**: omp doesn't support `--mode json`, so:
- No streaming events
- No `message_end` events
- Cannot track delegate usage

**Behavior on omp**:
- `isPiHost()` returns `false`
- Async delegates use `-p` instead of `--mode json`
- No usage data collected
- `run.usage` remains `undefined`
- Notification shows "N/A" for usage
---

## Verification Steps

```bash
cd ~/GitHub/billion-context-pi-delegate-usage
npm run typecheck    # Ensure no type errors
npm test             # Run all tests including new ones
npm run build        # Verify build succeeds
```

---

## Scope

- **In scope**: Parsing usage from JSON stream, accumulating in DelegateRun, returning from wait/cancel tools, human-readable usage in notifications, separate display mode, config option
- **Out of scope**: Sync delegate usage tracking (sync delegates block and don't stream events), usage display in UI widgets

## Known Limitations

1. **Async path**: The default async flow delivers results via `injectResult` → `pi.sendUserMessage`. This path **cannot** carry `usage` to Pi's session totals. Mitigation: human-readable usage appended to notification text. For full cost tracking, the model must call `acp_delegate_wait` after completion.
2. **Sync/one-shot delegates**: Sync delegates and print/json hosts (async auto-downgrade) don't stream events → `usage: undefined` returned. Feature silently no-ops.
3. **Partial usage on cancel**: Cancelling a running delegate kills the child with SIGTERM; the final `message_end` may be cut off → `run.usage` is partial. Cancel returns this partial usage.
4. **Resumed session reset**: `pi --continue` refires `session_start` and wipes the accumulator. Documented v1 limitation; if needed, key by `sessionId` for robustness.
