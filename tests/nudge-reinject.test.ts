import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

// issue #269: the per-turn nudge dedup suppressed ALL re-shows within one user
// turn, so a model that ignored a 78% pressure nudge was driven straight into
// the 95% emergency band (per-turn suppression → mechanical truncation) with
// no fresh reminder on the growth in between. Fix: once the context has grown
// by a full growth floor (mirroring the kernel's decideNudge cadence:
// max(minGrowthFloor, minGrowthRatio × adaptiveGrowth) — for the current
// defaults, 0.45 × 100 000 = 45 000), the nudge re-injects within the same
// turn. After a successful compress the baseline re-anchors (mirror of the
// kernel's nudgeNode drop re-anchor), so post-compress regrowth into the
// pressure band re-injects without needing to exceed the old peak.

const LIMIT = 300_000;
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
const COMPRESS_PANEL = "▣ ACP | 120.5K → 55.1K tokens (~65.4K reclaimed, 2 blocks)";

let branchEntries: any[] = [];
let stateFile = "";

function fakeCtx(tokens: number) {
  return {
    mode: "rpc" as const,
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: LIMIT },
    sessionManager: {
      getBranch: () => branchEntries as any[],
      getSessionId: () => "reinject",
      getSessionFile: () => stateFile,
    },
    getContextUsage: () => ({ tokens, percent: tokens / LIMIT, contextWindow: LIMIT }),
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, entries: any[], tokens: number) =>
  handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, fakeCtx(tokens));

// Six MID-sized messages (~11K compressible mass, above the 5K
// minPressureBenefit floor) ending in the anchor assistant. The LAST USER
// message (u5) is the turnKey and stays fixed across events within a turn.
function bulk(): any[] {
  const entries: any[] = [msg("u0", "user", "start " + MID)];
  entries.push(msg("a1", "assistant", "f1 " + MID));
  entries.push(msg("u2", "user", "f2 " + MID));
  entries.push(msg("a3", "assistant", "f3 " + MID));
  entries.push(msg("u4", "user", "f4 " + MID));
  entries.push(msg("u5", "user", "f5 " + MID));
  return entries;
}

function anchor(input: number) {
  return msg("an", "assistant", "tail " + MID, { usage: { input, cacheRead: 0, cacheWrite: 0 } });
}

const nudgeCount = (rebuilt: any[]) =>
  rebuilt.filter((m: any) => {
    if (m.role !== "user") return false;
    const t = JSON.stringify(m.content);
    // gentle/pressure voice vs emergency voice markers (kernel renderNudgeText)
    return t.includes("efficiency nudge to compress early") || t.includes("Context limit reached");
  }).length;

test("same-turn pressure nudge re-injects only after a full growth floor (issue #269)", async () => {
  stateFile = "/tmp/pai-acp-reinject-a.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: LIMIT })(api as any);

  // Event 1 — 230K/300K ≈ 77%: pressure nudge injects (mark at 230K).
  branchEntries = [...bulk(), anchor(230_000)];
  const r1 = (await fire(handlers, branchEntries, 230_000)).messages;
  assert.equal(nudgeCount(r1), 1, "77% pressure nudge injects");

  // Event 2 — same turn, +2K growth (< 45K floor): suppressed.
  branchEntries = [...bulk(), anchor(232_000)];
  const r2 = (await fire(handlers, branchEntries, 232_000)).messages;
  assert.equal(nudgeCount(r2), 0, "small same-turn growth stays suppressed");

  // Event 3 — same turn, +46K growth (>= 45K floor, 92% < 95% emergency): re-injects.
  branchEntries = [...bulk(), anchor(276_000)];
  const r3 = (await fire(handlers, branchEntries, 276_000)).messages;
  assert.equal(nudgeCount(r3), 1, "growth past the re-inject floor re-shows within the turn");
});

test("drop re-anchor: post-compress regrowth into the pressure band re-injects without exceeding the old peak", async () => {
  stateFile = "/tmp/pai-acp-reinject-b.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: LIMIT })(api as any);

  // Inject at 240K, then a successful compress collapses the anchor scale.
  branchEntries = [...bulk(), anchor(240_000)];
  const r1 = (await fire(handlers, branchEntries, 240_000)).messages;
  assert.equal(nudgeCount(r1), 1, "80% pressure nudge injects");

  // Post-compress: the compress toolResult predates the fresh 130K anchor, so
  // the meter runs on the provider scale at 130K. 130K < 240K − 100K → the
  // baseline re-anchors to 130K (no nudge at 43% usage).
  branchEntries = [...bulk(), { type: "message", id: "c1", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "compress", toolCallId: "tc1", content: [{ type: "text", text: COMPRESS_PANEL }], timestamp: Date.now() } }, anchor(130_000)];
  const r2 = (await fire(handlers, branchEntries, 130_000)).messages;
  assert.equal(nudgeCount(r2), 0, "post-compress regrowth stays quiet below the pressure band");

  // Regrow to 230K (76.7%, pressure). Without the drop re-anchor the baseline
  // would still be the 240K peak (growth −10K < floor) and the nudge would be
  // suppressed straight into the emergency band — the exact #269 escalation.
  branchEntries = [...bulk(), { type: "message", id: "c1", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "compress", toolCallId: "tc1", content: [{ type: "text", text: COMPRESS_PANEL }], timestamp: Date.now() } }, anchor(230_000)];
  const r3 = (await fire(handlers, branchEntries, 230_000)).messages;
  assert.equal(nudgeCount(r3), 1, "re-anchored baseline lets the regrown pressure nudge through");
});

test("emergency bypass is unchanged (95% injects on every event)", async () => {
  stateFile = "/tmp/pai-acp-reinject-c.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: LIMIT })(api as any);

  branchEntries = [...bulk(), anchor(290_000)];
  const r1 = (await fire(handlers, branchEntries, 290_000)).messages;
  assert.equal(nudgeCount(r1), 1, "emergency injects");
  const r2 = (await fire(handlers, branchEntries, 290_000)).messages;
  assert.equal(nudgeCount(r2), 1, "emergency keeps injecting without a growth floor");
});
