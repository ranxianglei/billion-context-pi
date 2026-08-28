import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

// Regression (mirrors omp tests/sent-view-arbitration.test.ts): nudge
// arbitration must run on the SENT-VIEW estimate. pi's getContextUsage is
// anchored on the last assistant's provider-reported usage when available,
// but falls back to summing the whole session tree when providers don't
// report usage — the tree includes compressed originals and never shrinks,
// so a session switched to a smaller-window model (or a provider that never
// reports usage) showed permanent false EMERGENCY nudges at "204%" while the
// real sent view was a few percent and the chat kept working.

const STATE_FILE = "/tmp/pai-acp-sent-view-it.session.json";

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

const MID = "lorem ".repeat(3000);

let branchEntries: any[] = [];

function fakeCtx(tokens: number) {
  return {
    mode: "rpc" as const,
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 180_000 },
    sessionManager: {
      getBranch: () => branchEntries as any[],
      getSessionId: () => "sent-view-" + tokens,
      getSessionFile: () => `${STATE_FILE}.${tokens}`,
    },
    getContextUsage: () => ({ tokens, percent: tokens / 180_000, contextWindow: 180_000 }),
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, entries: any[], ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);

// pi's injected nudge text: "⚠️ Context limit reached — compress now. …"
const nudgeCount = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached|compress/i.test(JSON.stringify(m.content))).length;

test("context transform ignores session-tree accounting (180K window, 366K tree)", async () => {
  await rm(`${STATE_FILE}.365606.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 180_000 })(api as any);

  // Host reports a tree that outgrew the window (switched down from 1M).
  // The live stream the model actually sees is ~36K — 20% of the window.
  const ctx = fakeCtx(365_606);
  const entries = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 7; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));

  branchEntries = entries;
  const r = await fire(handlers, entries, ctx);
  assert.equal(nudgeCount(r), 0, "no emergency nudge: sent view is well within the window");
  await rm(`${STATE_FILE}.365606.acp.json`, { force: true });
});

test("context transform DOES go emergency when the sent view itself overflows", async () => {
  await rm(`${STATE_FILE}.1000.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 180_000 })(api as any);

  // Host reports a small tree; irrelevant now. The stream itself is 60 ×
  // ~4.5K ≈ 270K tokens → 150% of the 180K window.
  const ctx = fakeCtx(1000);
  const entries = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 59; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));

  branchEntries = entries;
  const r = await fire(handlers, entries, ctx);
  assert.ok(nudgeCount(r) >= 1, "emergency nudge fires on real sent-view overflow");
  await rm(`${STATE_FILE}.1000.acp.json`, { force: true });
});
