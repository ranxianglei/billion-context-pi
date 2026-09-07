import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

// Nudge arbitration runs on the SENT-VIEW estimate floored at the host's real
// context usage (issue #257): the floor keeps the 0.75/0.95 bands on the real
// scale when the CJK-aware estimate under-reports, and the sent view still
// drives the decision when the host reports nothing useful.

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

test("context transform DOES go emergency when the sent view itself overflows", async () => {
  await rm(`${STATE_FILE}.1000.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);

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

// issue #257: the nudge decision must run on the provider's real per-request
// prompt size (floored), not just the chars/4 estimate. A CJK session whose
// estimate reads ~42% but whose real prompt is 97% of the window must still
// trip the emergency nudge. The kernel suppresses the nudge when no tier has
// compressible content above minCompressRange, so the stream needs real bulk
// (MID-sized messages), not just a high usage number.
test("context transform trips the emergency nudge from the provider-usage floor (estimate 42%, real 97%)", async () => {
  await rm(`${STATE_FILE}.175000.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);

  const ctx = fakeCtx(175_000);
  const entries = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 18; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  entries.push({ type: "message", id: "e19", parentId: null, timestamp: "", message: { role: "assistant", content: "f19 " + MID, timestamp: Date.now(), usage: { input: 175_000, cacheRead: 0, cacheWrite: 0 } } });
  branchEntries = entries;
  const r = await fire(handlers, entries, ctx);
  assert.ok(nudgeCount(r) >= 1, "emergency nudge fires from the provider-usage floor despite a 42% estimate");
  await rm(`${STATE_FILE}.175000.acp.json`, { force: true });
});

// Control: same 20-message stream with a tiny (500-token) real usage → the
// floor is a no-op, the meter stays on the ~42% estimate and no nudge fires,
// proving the floor (not the bulk) drives the emergency above.
test("context transform stays idle when there is no provider usage to floor from", async () => {
  await rm(`${STATE_FILE}.500.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);

  const ctx = fakeCtx(500);
  const entries = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 18; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  entries.push(msg("e19", "assistant", "f19 " + MID));
  branchEntries = entries;
  const r = await fire(handlers, entries, ctx);
  assert.equal(nudgeCount(r), 0, "no nudge: 42% estimate and no provider usage to floor from");
  await rm(`${STATE_FILE}.500.acp.json`, { force: true });
});

// issue #325: the usage anchor (e19's 175K) predates the successful compress
// toolResult that follows it, so the host's 175K still reflects the PRE-compress
// request. Seeding a real reclaiming block makes the meter floor at
// (anchor − reclaimed) instead of skipping the floor or flooring at the raw
// anchor — the next turn must not snap back to 97% and re-fire a false EMERGENCY.
async function seedState(file: string, block: Record<string, unknown>) {
  const state = { blocks: [block], nextBlockId: 2, messageRefs: { byRaw: {}, byRef: {}, nextRef: 0 }, nudge: {}, stats: {} };
  await writeFile(file, JSON.stringify(state), "utf8");
}

const seedBlock = (over: Record<string, unknown> = {}) => ({
  blockId: "b0", runId: 0, tier: 1, generation: "young", active: true,
  summary: "compressed early history", directMessageIds: ["e1", "e2", "e3"],
  effectiveMessageIds: ["e1", "e2", "e3"], directBlockIds: [], compressedTokens: 60_000,
  survivedCount: 3, createdAt: Date.now(), compressCallId: "c1", ...over,
});

const staleStream = (): any[] => {
  const entries = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 18; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  entries.push({ type: "message", id: "e19", parentId: null, timestamp: "", message: { role: "assistant", content: "f19 " + MID, timestamp: Date.now(), usage: { input: 175_000, cacheRead: 0, cacheWrite: 0 } } });
  entries.push({ type: "message", id: "e20", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "compress", toolCallId: "c1", content: [{ type: "text", text: "▣ ACP | 42.3K → 18.9K tokens (~23.4K reclaimed, 3 blocks)" }], timestamp: Date.now() } });
  return entries;
};

test("context transform floors at anchor-minus-reclaimed while the anchor predates a successful compress", async () => {
  const acpFile = `${STATE_FILE}.175000.acp.json`;
  await rm(acpFile, { force: true });
  await seedState(acpFile, seedBlock({ compressedTokens: 60_000 }));
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);

  const ctx = fakeCtx(175_000);
  branchEntries = staleStream();
  const r = await fire(handlers, branchEntries, ctx);
  assert.equal(nudgeCount(r), 0, "no false emergency: floor adjusted down by ~60K reclaimed since the anchor");
  await rm(acpFile, { force: true });
});

// issue #325 guard: if the compress barely reclaimed anything while the context
// is already near the limit, the adjusted floor must stay high enough to STILL
// trip the nudge — never over-suppress a genuinely full context.
test("context transform still trips the nudge when a stale-anchor compress reclaimed little", async () => {
  const acpFile = `${STATE_FILE}.174000.acp.json`;
  await rm(acpFile, { force: true });
  await seedState(acpFile, seedBlock({ compressedTokens: 1_000 }));
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);

  const ctx = fakeCtx(174_000);
  branchEntries = staleStream();
  const r = await fire(handlers, branchEntries, ctx);
  assert.ok(nudgeCount(r) >= 1, "nudge still fires: only ~1K reclaimed, context is genuinely near the limit");
  await rm(acpFile, { force: true });
});
