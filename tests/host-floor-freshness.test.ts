import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

// issue #600: after an errored model turn (e.g. network "fetch failed") the host's
// getContextUsage() has no fresh provider-usage anchor and reports the raw
// session-tree total (uncompressed, only grows). That transient inflation used to
// floor the raise-only meter into the emergency band and drive a redundant compress
// on every flaky turn. The meter must reject the tree-sum and floor at the last
// REAL provider reading instead; the fresh-turn floor path (#257/#325) stays intact.
// (The no-anchor-at-all fallback — trusting the tree-sum because nothing has been
// compressed yet — is pinned by tests/terminal-escape.test.ts.)

const STATE_FILE = tmpPath("pai-acp-host-floor-freshness.session.json");

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

// Sized so ONLY the host floor can drive a nudge here. Two kernel bounds pin the
// band (180K window): the estimate's effective compressible mass must stay BELOW
// the flat 50K nudge-growth floor (else the first-sight-mass T1 branch fires on
// the bulk alone — the original 3000-repeat sizing measured 90K est / 67.5K
// effective and nudged legitimately, masking the host-floor variable), while the
// pending mass must stay ABOVE minPressureBenefit (max(5K, 1% of window)) so an
// un-fixed meter dragged to the inflated tree-sum still injects and fails this
// test. Measured with 1800 repeats: ~54K est / ~40.5K effective compressible —
// inside the band (verified red against master's index.ts, green with the fix).
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
      getSessionId: () => "host-floor-" + tokens,
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

test("control: fresh 175K provider reading still trips the emergency nudge", async () => {
  await rm(`${STATE_FILE}.175000.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);
  const entries = [
    ...baseStream(),
    { type: "message", id: "e18", parentId: null, timestamp: "", message: { role: "assistant", content: "f18 " + MID, timestamp: Date.now(), usage: { input: 175_000, cacheRead: 0, cacheWrite: 0 } } },
  ];
  const ctx = fakeCtx(175_000);
  branchEntries = entries;
  const r = await fire(handlers, entries, ctx);
  assert.ok(nudgeCount(r) >= 1, "emergency still fires from a FRESH 175K provider reading (#257 path intact)");
  await rm(`${STATE_FILE}.175000.acp.json`, { force: true });
});

test("errored latest turn: tree-sum rejected, meter floors at last real reading (no spurious compress)", async () => {
  await rm(`${STATE_FILE}.174000.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);
  const entries = [
    ...baseStream(),
    { type: "message", id: "e18", parentId: null, timestamp: "", message: { role: "assistant", content: "f18 " + MID, timestamp: Date.now(), usage: { input: 60_000, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", id: "e19", parentId: null, timestamp: "", message: { role: "assistant", content: "f19 " + MID, timestamp: Date.now(), stopReason: "error", errorMessage: "Error: fetch failed" } },
  ];
  const ctx = fakeCtx(174_000);
  branchEntries = entries;
  const r = await fire(handlers, entries, ctx);
  assert.equal(nudgeCount(r), 0, "no spurious compress: tree-sum (174K) rejected, meter floors at last real reading (60K)");
  await rm(`${STATE_FILE}.174000.acp.json`, { force: true });
});
