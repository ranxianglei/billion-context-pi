import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshLoopState,
  evaluateCall,
  noteResult,
  blockReason,
  wireToolLoopGuard,
} from "../src/tool-loop-guard.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const T0 = 1_000_000;

function call(state: ReturnType<typeof freshLoopState>, input: unknown, now = T0) {
  return evaluateCall(state, "write", input, now);
}

test("first three identical calls pass, the fourth is blocked", () => {
  const s = freshLoopState();
  const input = { path: "a.ts", content: "x" };
  assert.equal(call(s, input), undefined);
  assert.equal(call(s, input), undefined);
  assert.equal(call(s, input), undefined);
  const d = call(s, input);
  assert.ok(d?.block, "4th identical call must be blocked");
  assert.equal(d.terminate, false);
  assert.match(d.reason, /has already succeeded/);
});

test("changing any argument resets the streak", () => {
  const s = freshLoopState();
  const a = { path: "a.ts", content: "x" };
  const b = { path: "a.ts", content: "y" };
  call(s, a);
  call(s, a);
  assert.equal(call(s, b), undefined, "different args start a fresh streak");
  call(s, b);
  call(s, b);
  assert.ok(call(s, b)?.block, "streak of the new key reaches the threshold independently");
});

test("argument key order does not matter (canonical JSON)", () => {
  const s = freshLoopState();
  call(s, { path: "a.ts", content: "x" });
  call(s, { content: "x", path: "a.ts" });
  assert.ok(call(s, { content: "x", path: "a.ts" })?.block === undefined);
  assert.ok(call(s, { path: "a.ts", content: "x" })?.block);
});

test("stale gap (>5min) starts a fresh streak", () => {
  const s = freshLoopState();
  const input = { cmd: "npm test" };
  call(s, input, T0);
  call(s, input, T0 + 60_000);
  call(s, input, T0 + 120_000);
  assert.ok(call(s, input, T0 + 120_000 + 6 * 60_000)?.block === undefined,
    "after a 6min gap the next call is treated as a new round");
  call(s, input, T0 + 120_000 + 6 * 60_000 + 1_000);
  call(s, input, T0 + 120_000 + 6 * 60_000 + 2_000);
  assert.ok(call(s, input, T0 + 120_000 + 6 * 60_000 + 3_000)?.block);
});

test("block reason carries the last successful result excerpt", () => {
  const s = freshLoopState();
  const input = { path: "a.ts", content: "x" };
  call(s, input);
  noteResult(s, "write", input, [{ type: "text", text: "Successfully wrote 100 bytes" }], false);
  call(s, input);
  call(s, input);
  const d = call(s, input)!;
  assert.match(d.reason, /Successfully wrote 100 bytes/);
});

test("failed results do not feed the reason excerpt", () => {
  const s = freshLoopState();
  const input = { path: "a.ts", content: "x" };
  call(s, input);
  noteResult(s, "write", input, [{ type: "text", text: "boom" }], true);
  call(s, input);
  call(s, input);
  const d = call(s, input)!;
  assert.doesNotMatch(d.reason, /boom/);
  assert.match(d.reason, /\(no output\)/);
});

test("streak reaches terminate on the 5th consecutive block", () => {
  const s = freshLoopState();
  const input = { cmd: "sleep 1" };
  for (let i = 0; i < 4; i++) call(s, input);
  for (let i = 0; i < 3; i++) {
    const d = call(s, input)!;
    assert.ok(d.block && !d.terminate, `block #${i + 1} must not terminate`);
  }
  const d = call(s, input)!;
  assert.ok(d.block && d.terminate, "5th block terminates the turn");
  assert.match(d.reason, /TERMINATED/);
});

test("compress tool is excluded from the guard", () => {
  const s = freshLoopState();
  const input = { content: [{ startId: "m1", endId: "m2", summary: "x" }] };
  for (let i = 0; i < 10; i++) {
    assert.equal(evaluateCall(s, "compress", input, T0 + i), undefined);
  }
});

test("blockReason message shape: actionable guidance; excerpt capped by noteResult", () => {
  const long = "x".repeat(1000);
  const s = freshLoopState();
  noteResult(s, "write", { path: "a" }, [{ type: "text", text: long }], false);
  assert.ok(s.lastResult.length <= 401, "excerpt must be capped at 400 chars (+ ellipsis)");
  const msg = blockReason("write", 2, s.lastResult, false);
  assert.match(msg, /Choose a DIFFERENT action/);
  assert.doesNotMatch(msg, /TERMINATED/);
});

// --- wiring ---

function wireFor() {
  const handlers: Record<string, (e: never) => unknown> = {};
  const pi = {
    on: (name: string, fn: (e: never) => unknown) => {
      handlers[name] = fn;
    },
  } as unknown as ExtensionAPI;
  wireToolLoopGuard(pi);
  return handlers;
}

function ev(kind: "call" | "result", toolName: string, input: unknown, opts?: { isError?: boolean; text?: string }) {
  return kind === "call"
    ? ({ type: "tool_call", toolName, input })
    : ({ type: "tool_result", toolName, input, content: [{ type: "text", text: opts?.text ?? "ok" }], isError: opts?.isError ?? false });
}

test("wired guard blocks the 4th identical call end-to-end", () => {
  const handlers = wireFor();
  const input = { path: "loop.ts", content: "x" };
  const callHandler = handlers["tool_call"] as (e: never) => unknown;
  const resultHandler = handlers["tool_result"] as (e: never) => unknown;
  for (let i = 0; i < 3; i++) {
    callHandler(ev("call", "write", input) as never);
    resultHandler(ev("result", "write", input, { text: `wrote ${i}` }) as never);
  }
  const d = callHandler(ev("call", "write", input) as never) as { block: boolean; reason: string };
  assert.ok(d?.block);
  assert.match(d.reason, /wrote 2/);
  // a different call afterwards is untouched
  const other = callHandler(ev("call", "write", { path: "other.ts", content: "y" }) as never) as unknown;
  assert.equal(other, undefined);
});
