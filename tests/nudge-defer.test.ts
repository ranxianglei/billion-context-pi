import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

// issue #665: during a sustained API outage every model turn fails (zero usage), so a
// compress call can NEVER land — yet the emergency nudge (which bypasses per-turn dedup)
// was injected into every failing LLM call and flashed EMERGENCY in the TUI, deadlocking
// the user between "context exploded" readings and a compress that cannot run (#665's
// session: 4 consecutive failed turns, meter pinned at 882k/176% vs real ~90k). With
// #600 in place the meter stays honest (floor at the last real reading); these tests pin
// the second line of defense: while the LATEST assistant turn errored/aborted, the
// emergency nudge is deferred (nothing marked shown/recorded), the first COMPLETED turn
// at the same pressure re-fires it immediately, and legit emergencies on fresh turns are
// untouched. (The honest-meter half of the fix is pinned by host-floor-freshness.test.ts.)

const STATE_FILE = tmpPath("pai-acp-nudge-defer.session.json");

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

function msg(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now() } };
}

// Sized exactly like host-floor-freshness.test.ts so ONLY the usage band can drive a
// nudge here: ~54K est / ~40.5K effective compressible — below the flat 50K nudge-growth
// floor (no first-sight-mass T1 branch on the bulk alone), above minPressureBenefit
// (max(5K, 1% of window)) so an emergency decision actually injects.
const MID = "lorem ".repeat(1800);

let branchEntries: any[] = [];

function fakeCtx(tokens: number) {
  return {
    mode: "rpc" as const,
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 180_000 },
    sessionManager: {
      getBranch: () => branchEntries as any[],
      getSessionId: () => "nudge-defer-" + tokens,
      getSessionFile: () => `${STATE_FILE}.${tokens}`,
    },
    getContextUsage: () => ({ tokens, percent: tokens / 180_000, contextWindow: 180_000 }),
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, entries: any[], ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);

const nudgeCount = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached|compress/i.test(JSON.stringify(m.content))).length;

const baseStream = (): any[] => {
  const entries = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 17; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  return entries;
};

test("#665: genuine emergency + errored latest turn → nudge deferred (no injection)", async () => {
  await rm(`${STATE_FILE}.174000.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);
  const entries = [
    ...baseStream(),
    { type: "message", id: "e18", parentId: null, timestamp: "", message: { role: "assistant", content: "f18 " + MID, timestamp: Date.now(), usage: { input: 172_000, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", id: "e19", parentId: null, timestamp: "", message: { role: "assistant", content: "f19 " + MID, timestamp: Date.now(), stopReason: "error", errorMessage: "Error: fetch failed" } },
  ];
  const ctx = fakeCtx(174_000);
  branchEntries = entries;
  const r = await fire(handlers, entries, ctx);
  assert.equal(nudgeCount(r), 0, "emergency deferred while the latest turn errored: no compress instruction sent into a turn that cannot complete it");
  await rm(`${STATE_FILE}.174000.acp.json`, { force: true });
});

test("#665 control: same pressure with a FRESH successful latest turn → emergency still fires", async () => {
  await rm(`${STATE_FILE}.172000.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);
  const entries = [
    ...baseStream(),
    { type: "message", id: "e18", parentId: null, timestamp: "", message: { role: "assistant", content: "f18 " + MID, timestamp: Date.now(), usage: { input: 172_000, cacheRead: 0, cacheWrite: 0 } } },
  ];
  const ctx = fakeCtx(172_000);
  branchEntries = entries;
  const r = await fire(handlers, entries, ctx);
  assert.ok(nudgeCount(r) >= 1, "legit emergency on a fresh 172K reading still injects (deferral must not blind real emergencies)");
  await rm(`${STATE_FILE}.172000.acp.json`, { force: true });
});

test("#665 recovery: first COMPLETED turn after the outage re-fires the emergency at the same pressure", async () => {
  await rm(`${STATE_FILE}.173000.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);
  const entries = [
    ...baseStream(),
    { type: "message", id: "e18", parentId: null, timestamp: "", message: { role: "assistant", content: "f18 " + MID, timestamp: Date.now(), usage: { input: 172_000, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", id: "e19", parentId: null, timestamp: "", message: { role: "assistant", content: "f19 " + MID, timestamp: Date.now(), stopReason: "error", errorMessage: "Error: fetch failed" } },
    { type: "message", id: "e20", parentId: null, timestamp: "", message: { role: "assistant", content: "f20 " + MID, timestamp: Date.now(), usage: { input: 172_000, cacheRead: 0, cacheWrite: 0 } } },
  ];
  const ctx = fakeCtx(173_000);
  branchEntries = entries;
  const r = await fire(handlers, entries, ctx);
  assert.ok(nudgeCount(r) >= 1, "restore is immediate: nothing was marked shown/recorded during the deferral, so the first completed turn re-injects");
  await rm(`${STATE_FILE}.173000.acp.json`, { force: true });
});
