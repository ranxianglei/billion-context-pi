import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { MAX_SUCCESSFUL_COMPRESSES_PER_TURN } from "../src/runtime.js";

// Compress success throttle (see MAX_SUCCESSFUL_COMPRESSES_PER_TURN).
//
// Motivating session (01a06693, 2-hour unattended run on a local 3.5bpw model):
// the model entered a tool-call repetition loop. Each time the repeated-call
// guard BLOCKED it, the model fired a SUCCESSFUL compress (29.2K→9.9K,
// 9.9K→9.9K, 10.5K→5.0K in three minutes) that erased the just-delivered
// BLOCKED feedback from its context, then resumed the identical call from a
// clean slate. Existing breakers only count FAILED compresses — and
// noteCompressOutcomes actually RESETS the failure counter on success — so
// this escape hatch was completely ungated.
//
// Behavior under test:
//  1. After MAX_SUCCESSFUL_COMPRESSES_PER_TURN successful compresses in one
//     user turn, further compress calls return the THROTTLED rejection
//     (0 → 0 panel) and create NO block.
//  2. A new user message resets the budget (normal cross-turn compression is
//     untouched).
//  3. Failed compresses (dead refs / noop panels) do NOT consume the success
//     budget.
//  4. compress.maxSuccessfulPerTurn in the adapter config overrides the
//     default; 0 disables the throttle entirely.

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function fakeCtx(entries: any[], stateFile: string) {
  let usage: { tokens: number; percent: number } | null = null;
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => usage,
    __setUsage(t: number) { usage = { tokens: t, percent: t / 200_000 }; },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "throttle-test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const ZH = "中".repeat(5500); // > kernel minCompressRange (5000 chars) so a single-message range compresses

async function runContextRound(handlers: Map<string, any[]>, ctx: any) {
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
}

function compressText(out: any): string {
  return typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
}

// Fresh harness: N user messages, context round primed, compress tool resolved.
// Compressable refs must stay OUTSIDE the protected zone (last 5 messages,
// preserveRecentMessages default) — 10 entries leaves m00001..m00005 compressable.
async function harness(entryCount: number, adapterConfig: Record<string, unknown> = {}) {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, ...adapterConfig })(api as any);
  const stateFile = `/tmp/pai-acp-success-throttle-${Date.now()}-${Math.random().toString(36).slice(2)}.session.json`;
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = Array.from({ length: entryCount }, (_, i) => userMsg(`e${i + 1}`, ZH));
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  async function compress(callId: string, msgIndex: number): Promise<string> {
    const ref = `m${String(msgIndex).padStart(5, "0")}`;
    const summary = `Detailed summary of message ${msgIndex}: discussion points, decisions and open questions were recorded here for future reference.`;
    const out = await compressTool.execute(callId, { content: [{ startId: ref, endId: ref, summary }] }, undefined, undefined, ctx);
    return compressText(out);
  }
  return { entries, ctx, compress };
}

test("success throttle: default limit blocks the compress after the budget is spent, creating no block", async () => {
  const { compress } = await harness(10);
  for (let i = 1; i <= MAX_SUCCESSFUL_COMPRESSES_PER_TURN; i++) {
    const text = await compress(`tc${i}`, i);
    assert.match(text, /▣ ACP \| [\d.]+(K)? → [\d.]+(K)? tokens \(~[\d.]+(K)? reclaimed, 1 block\)/, `call ${i} should succeed: ${text}`);
  }
  const throttled = await compress("tc-throttled", MAX_SUCCESSFUL_COMPRESSES_PER_TURN + 1);
  assert.match(throttled, /0 → 0 tokens \(~0 reclaimed, 0 blocks\)/, `throttled call must be a no-op: ${throttled}`);
  assert.match(throttled, /THROTTLED/, `throttled call must explain itself: ${throttled}`);
  assert.match(throttled, /erase your OWN recent history/, "must name the failure-erasure mechanism");
});

test("success throttle: a new user turn resets the budget", async () => {
  const { entries, ctx, compress } = await harness(10);
  for (let i = 1; i <= MAX_SUCCESSFUL_COMPRESSES_PER_TURN; i++) await compress(`tc${i}`, i);
  const throttled = await compress("tc-throttled", MAX_SUCCESSFUL_COMPRESSES_PER_TURN + 1);
  assert.match(throttled, /THROTTLED/, "budget should be exhausted within the turn");

  // New user message → new turnKey → fresh budget. The pushed message shifts
  // the protected zone forward, so m00005 (never compressed above) stays
  // compressable on the new turn.
  entries.push(userMsg("e-next", "continue the task"));
  const text = await compress("tc-after-new-turn", MAX_SUCCESSFUL_COMPRESSES_PER_TURN + 1);
  assert.match(text, /1 block\)/, `compress must succeed again on the new turn: ${text}`);
  assert.ok(!ctx.sessionManager.buildContextEntries().length || true); // entries live in the closure
});

test("success throttle: failed compresses do not consume the success budget", async () => {
  const { compress } = await harness(10);
  await compress("tc1", 1); // success #1
  // Two failures: re-compressing the same (already compressed) ref → noop/dead, no block.
  for (const callId of ["tc-bad-1", "tc-bad-2"]) {
    const text = await compress(callId, 1);
    assert.match(text, /0 block\)/, `stale-ref call must create no block: ${text}`);
  }
  // The success budget must still be at 1/MAX (failures consumed nothing):
  // the remaining MAX-1 successes fit, and the next attempt is throttled.
  // If failures consumed budget, ok-2 would already be rejected.
  for (let i = 2; i <= MAX_SUCCESSFUL_COMPRESSES_PER_TURN; i++) {
    const text = await compress(`tc-ok-${i}`, i);
    assert.match(text, /1 block\)/, `success ${i} should still fit after failures: ${text}`);
  }
  const throttled = await compress("tc-throttled", MAX_SUCCESSFUL_COMPRESSES_PER_TURN + 1);
  assert.match(throttled, /THROTTLED/, "throttle engages at MAX total successes, failures not counted");
});

test("success throttle: config override maxSuccessfulPerTurn: 1 engages after one success", async () => {
  const { compress } = await harness(10, { compress: { maxSuccessfulPerTurn: 1 } });
  const ok = await compress("tc1", 1);
  assert.match(ok, /1 block\)/, `first compress must succeed: ${ok}`);
  const throttled = await compress("tc2", 2);
  assert.match(throttled, /THROTTLED/, `second compress must be throttled: ${throttled}`);
});

test("success throttle: maxSuccessfulPerTurn: 0 disables the throttle", async () => {
  const { compress } = await harness(10, { compress: { maxSuccessfulPerTurn: 0 } });
  for (let i = 1; i <= 5; i++) {
    const text = await compress(`tc${i}`, i);
    assert.match(text, /1 block\)/, `compress ${i} must succeed with throttle disabled: ${text}`);
  }
});
