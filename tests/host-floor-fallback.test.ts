import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

// issue #595: after a retry's context_edit the host abandons its provider-usage
// anchor and getContextUsage() returns a full-history fallback estimate that
// re-includes ACP-folded content — irreducibly larger than the compressed send
// view. The host floor must be capped at the measured anchor (+ trailing) so the
// fallback estimate cannot floor the meter into a false EMERGENCY.

const STATE_FILE = tmpPath("pai-acp-host-floor.session.json");
const LOG_FILE = tmpPath("pai-acp-host-floor.acp.log");

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

let branchEntries: any[] = [];

function fakeCtx(tokens: number) {
  return {
    mode: "rpc" as const,
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 180_000 },
    sessionManager: {
      getBranch: () => branchEntries as any[],
      getSessionId: () => "host-floor",
      getSessionFile: () => STATE_FILE,
    },
    getContextUsage: () => ({ tokens, percent: tokens / 180_000, contextWindow: 180_000 }),
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, entries: any[], ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);

async function seedState(file: string, block: Record<string, unknown>) {
  const state = { blocks: [block], nextBlockId: 2, messageRefs: { byRaw: {}, byRef: {}, nextRef: 0 }, nudge: {}, stats: {} };
  await writeFile(file, JSON.stringify(state), "utf8");
}

// 19 MID-sized messages (~4.5K each ≈ 85K) — folded into one active block so the
// compressed send view stays tiny while the raw history is large.
function bulkEntries(): any[] {
  const entries: any[] = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 18; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  return entries;
}

function lastTurnLog(): { tokens: number; nudge: string } | undefined {
  return readFile(LOG_FILE, "utf-8").then((text) => {
    const lines = text.split("\n").filter((l) => l.includes("[turn]") && l.includes(" nudge="));
    const line = lines[lines.length - 1];
    if (!line) return undefined;
    const tokens = Number(/ tokens=(\d+)/.exec(line)?.[1]);
    const nudge = / nudge=(\w+)/.exec(line)?.[1];
    return { tokens, nudge };
  });
}

test("issue #595: retry fallback estimate must not floor the compressed view into a false emergency", async () => {
  process.env.ACP_LOG_FILE = LOG_FILE;
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  await rm(LOG_FILE, { force: true });
  try {
    // Active block folds ALL bulk history → sent view is just the small tail.
    const bulkIds = Array.from({ length: 19 }, (_, i) => `e${i}`);
    await seedState(`${STATE_FILE}.acp.json`, {
      blockId: "b0", runId: 0, tier: 1, generation: "young", active: true,
      summary: "compressed early history", directMessageIds: bulkIds, effectiveMessageIds: bulkIds,
      directBlockIds: [], compressedTokens: 100_000, survivedCount: 3, createdAt: Date.now(), compressCallId: "c-none",
    });

    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 180_000 })(api as any);

    // Last VALID provider-usage anchor totals 78_173, then a FAILED assistant
    // (error, zero usage) whose hiding triggers the host's fallback estimate.
    const entries = [
      ...bulkEntries(),
      msg("e19", "assistant", "ok", { usage: { input: 3_631, output: 942, cacheRead: 73_600, cacheWrite: 0 } }),
      msg("e20", "toolResult", "x", { toolName: "read", toolCallId: "r1" }),
      msg("e21", "assistant", "", { stopReason: "error" }),
    ];
    branchEntries = entries;
    // Host abandons the anchor → full-history fallback (re-includes folded mass):
    await fire(handlers, entries, fakeCtx(326_774));

    const turn = await lastTurnLog();
    assert.ok(turn, "[turn] log line present");
    // Capped at the provider anchor (~78K), far under the bogus 326K fallback.
    assert.ok(turn!.tokens < 120_000, `host floor capped to anchor, not the fallback estimate (got ${turn!.tokens})`);
    assert.notEqual(turn!.nudge, "emergency", `no false emergency (got ${turn!.nudge} @ ${turn!.tokens})`);
  } finally {
    delete process.env.ACP_LOG_FILE;
    await rm(`${STATE_FILE}.acp.json`, { force: true });
    await rm(LOG_FILE, { force: true });
  }
});

// #601 union: the cap must also bind on FRESH turns — the #595 trace where the
// retry SUCCEEDS and carries usage (fresh anchor), yet the host's
// estimateProjectedContextTokens() still reports the full-history fallback
// because the retry's context_edit invalidated its anchor chain. The
// freshness guard (#601) cannot reject this reading (the anchor is fresh);
// only the trusted ceiling caps it.
test("issue #595 (fresh anchor): fallback estimate capped even when the retry succeeded", async () => {
  process.env.ACP_LOG_FILE = LOG_FILE;
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  await rm(LOG_FILE, { force: true });
  try {
    const bulkIds = Array.from({ length: 19 }, (_, i) => `e${i}`);
    await seedState(`${STATE_FILE}.acp.json`, {
      blockId: "b0", runId: 0, tier: 1, generation: "young", active: true,
      summary: "compressed early history", directMessageIds: bulkIds, effectiveMessageIds: bulkIds,
      directBlockIds: [], compressedTokens: 100_000, survivedCount: 3, createdAt: Date.now(), compressCallId: "c-none",
    });

    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 180_000 })(api as any);

    // e19 anchors at 78_173; the retry (e22) SUCCEEDS and carries usage —
    // fresh anchor — but the host still reports the abandoned-anchor fallback.
    const entries = [
      ...bulkEntries(),
      msg("e19", "assistant", "ok", { usage: { input: 3_631, output: 942, cacheRead: 73_600, cacheWrite: 0 } }),
      msg("e20", "toolResult", "x", { toolName: "read", toolCallId: "r1" }),
      msg("e21", "assistant", "", { stopReason: "error" }),
      msg("e22", "assistant", "retried ok", { usage: { input: 3_631, output: 942, cacheRead: 73_600, cacheWrite: 0 } }),
    ];
    branchEntries = entries;
    await fire(handlers, entries, fakeCtx(326_774));

    const turn = await lastTurnLog();
    assert.ok(turn, "[turn] log line present");
    assert.ok(turn!.tokens < 120_000, `fresh-anchor reading capped at the ceiling, not the fallback estimate (got ${turn!.tokens})`);
    assert.notEqual(turn!.nudge, "emergency", `no false emergency (got ${turn!.nudge} @ ${turn!.tokens})`);
    const log = await readFile(LOG_FILE, "utf-8");
    assert.ok(log.includes("host-floor-capped"), "the cap event attributes the correction");
    assert.ok(!log.includes("host-tree-sum-rejected"), "fresh anchor must not be treated as a tree-sum (#601 path inactive here)");
  } finally {
    delete process.env.ACP_LOG_FILE;
    await rm(`${STATE_FILE}.acp.json`, { force: true });
    await rm(LOG_FILE, { force: true });
  }
});
