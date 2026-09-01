import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

// issue #267: the meter switches rulers when the usage anchor flips
// stale↔not-stale (estimate ↔ provider). A growth delta spanning that switch
// is a false artifact. The context transform must re-anchor the growth
// baseline on the flip so growth only accumulates same-source deltas — while
// the usage bands keep the floor-stale behavior untouched.

const STATE_FILE = "/tmp/pai-acp-growth-scale.session.json";

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

function msg(id: string, role: string, text: string, over: Record<string, unknown> = {}) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now(), ...over } };
}

const MID = "lorem ".repeat(3000);
const COMPRESS_PANEL = "▣ ACP | 42.3K → 18.9K tokens (~23.4K reclaimed, 3 blocks)";

let branchEntries: any[] = [];

function fakeCtx(tokens: number) {
  return {
    mode: "rpc" as const,
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 180_000 },
    sessionManager: {
      getBranch: () => branchEntries as any[],
      getSessionId: () => "growth-scale",
      getSessionFile: () => STATE_FILE,
    },
    getContextUsage: () => ({ tokens, percent: tokens / 180_000, contextWindow: 180_000 }),
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, entries: any[], ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);

// 20 MID-sized messages (~75-90K estimate) + a 175K provider usage anchor.
function bulkEntries(): any[] {
  const entries: any[] = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 18; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  return entries;
}

test("growth baseline re-anchors on the stale→not-stale scale flip (no cross-scale false growth)", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);

  // Turn 1 — STALE: the successful compress lands after the 175K usage anchor,
  // so the meter runs on the estimate scale (sentTokens), far below 175K.
  const staleEntries = [
    ...bulkEntries(),
    { type: "message", id: "e19", parentId: null, timestamp: "", message: { role: "assistant", content: "f19 " + MID, timestamp: Date.now(), usage: { input: 175_000, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", id: "e20", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "compress", toolCallId: "c1", content: [{ type: "text", text: COMPRESS_PANEL }], timestamp: Date.now() } },
  ];
  branchEntries = staleEntries;
  await fire(handlers, staleEntries, fakeCtx(175_000));
  const afterStale = JSON.parse(await readFile(`${STATE_FILE}.acp.json`, "utf-8"));
  assert.ok(afterStale.nudge.lastPerMessageNudgeTokens < 100_000, "turn 1 baseline on estimate scale");

  // Turn 2 — NOT-STALE: a fresh 175K usage lands after the compress, so the
  // meter switches to the provider scale. Without the scale-flip reset the
  // baseline would still be the turn-1 estimate and growth would read as a
  // huge false delta (provider − estimate).
  const freshEntries = [
    ...staleEntries,
    { type: "message", id: "e21", parentId: null, timestamp: "", message: { role: "assistant", content: "f20 " + MID, timestamp: Date.now(), usage: { input: 175_000, cacheRead: 0, cacheWrite: 0 } } },
  ];
  branchEntries = freshEntries;
  await fire(handlers, freshEntries, fakeCtx(175_000));
  const afterFresh = JSON.parse(await readFile(`${STATE_FILE}.acp.json`, "utf-8"));
  assert.ok(
    afterFresh.nudge.lastPerMessageNudgeTokens >= 170_000,
    `baseline re-anchored to provider scale after flip (got ${afterFresh.nudge.lastPerMessageNudgeTokens})`,
  );
  // Per-tier cadence baselines (kernel 0.0.55 lastShownByTier) must also live
  // on one scale: old-scale lastShown minus new-scale tokenCount is exactly
  // the false "+35k growth" cadence bypass from issue #267.
  for (const [tier, shownAt] of Object.entries(afterFresh.nudge.lastShownByTier ?? {})) {
    assert.ok(
      (shownAt as number) >= 170_000,
      `tier ${tier} cadence baseline re-anchored after flip (got ${shownAt})`,
    );
  }
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});

test("no reset when the scale is stable (baseline keeps accumulating same-source growth)", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);

  // Two consecutive NOT-STALE turns (provider scale, no compress in between):
  // the baseline must NOT be reset — it stays anchored so real growth is tracked.
  const entriesA = [
    ...bulkEntries(),
    { type: "message", id: "e19", parentId: null, timestamp: "", message: { role: "assistant", content: "f19 " + MID, timestamp: Date.now(), usage: { input: 120_000, cacheRead: 0, cacheWrite: 0 } } },
  ];
  branchEntries = entriesA;
  await fire(handlers, entriesA, fakeCtx(120_000));
  const afterA = JSON.parse(await readFile(`${STATE_FILE}.acp.json`, "utf-8"));
  const baselineA = afterA.nudge.lastPerMessageNudgeTokens;
  assert.ok(baselineA >= 115_000, `turn 1 baseline on provider scale (got ${baselineA})`);

  const entriesB = [
    ...entriesA,
    { type: "message", id: "e20", parentId: null, timestamp: "", message: { role: "assistant", content: "f20 " + MID, timestamp: Date.now(), usage: { input: 130_000, cacheRead: 0, cacheWrite: 0 } } },
  ];
  branchEntries = entriesB;
  await fire(handlers, entriesB, fakeCtx(130_000));
  const afterB = JSON.parse(await readFile(`${STATE_FILE}.acp.json`, "utf-8"));
  // Same scale (provider) both turns → no flip → baseline unchanged from turn 1.
  assert.equal(afterB.nudge.lastPerMessageNudgeTokens, baselineA, "stable scale keeps the baseline (no spurious reset)");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});
