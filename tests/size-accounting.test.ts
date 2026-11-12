import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

// issue #455: the internal meter ran 1.5-2x above provider truth for a whole
// session because floors are raise-only — nothing pulled the estimate down —
// and the scale-flip reset zeroed the nudge references twice per compress
// cycle, re-arming the kernel's one-shot first-sight-mass bypass every time.
// Calibration caps the estimate at measured x 1.2 while the FRESH provider
// anchor is stable; flips re-anchor (not zero) the references; a persistent
// >2x disagreement warns once per episode.

const MID = "lorem ".repeat(3000);
const COMPRESS_PANEL = "▣ ACP | 42.3K → 18.9K tokens (~23.4K reclaimed, 3 blocks)";

let branchEntries: any[] = [];

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

function usageAssistant(id: string, text: string, input: number) {
  return msg(id, "assistant", text, { usage: { input, cacheRead: 0, cacheWrite: 0 } });
}

function compressPanel(id: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "toolResult", toolName: "compress", toolCallId: id + "-call", content: [{ type: "text", text: COMPRESS_PANEL }], timestamp: Date.now() } };
}

function bulkMessages(n: number): any[] {
  const entries: any[] = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i < n; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  return entries;
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

function setup(stateFile: string, logFile: string, sid: string, limit: number) {
  delete process.env.ACP_DEBUG;
  process.env.ACP_LOG_FILE = logFile;
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: limit })(api as any);
  const fire = async (entries: any[], tokens: number) => {
    branchEntries = entries;
    const ctx = {
      mode: "rpc" as const,
      hasUI: false,
      ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
      model: { contextWindow: limit },
      sessionManager: { getBranch: () => branchEntries as any[], getSessionId: () => sid, getSessionFile: () => stateFile },
      getContextUsage: () => ({ tokens, percent: tokens / limit, contextWindow: limit }),
    };
    await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  };
  const logText = () => readFile(logFile, "utf-8");
  const turnTokens = async (n: number) => {
    const lines = (await logText()).split("\n").filter((l) => l.includes(" [turn] ") && l.includes("inMsgs="));
    const m = lines[n - 1]?.match(/\btokens=(\d+)/);
    return m ? Number(m[1]) : NaN;
  };
  const state = async () => JSON.parse(await readFile(`${stateFile}.acp.json`, "utf-8"));
  return { fire, logText, turnTokens, state, cleanup: async () => { await rm(`${stateFile}.acp.json`, { force: true }); await rm(logFile, { force: true }); } };
}

test("#455 first-sight-mass bypass fires once: scale flips re-anchor instead of re-arming", async () => {
  const STATE = tmpPath("pai-acp-size-a.session.json");
  const LOG = tmpPath("pai-acp-size-a.log");
  await rm(`${STATE}.acp.json`, { force: true });
  await rm(LOG, { force: true });
  const t = setup(STATE, LOG, "size-a", 120_000);
  const bulk = bulkMessages(40);

  // Turn 1 — fresh cold start anchored at 175K (145% of 120K): a genuine first
  // sight of a massive over-limit context — the one-shot suffix belongs here.
  const turn1 = [...bulk, usageAssistant("a40", "ok", 175_000)];
  await t.fire(turn1, 175_000);
  let st = await t.state();
  assert.ok(st.nudge.lastNudgeShownTokens >= 170_000, `turn 1 stamped on provider scale (got ${st.nudge.lastNudgeShownTokens})`);
  assert.equal(count(await t.logText(), "first-sight mass"), 1, "cold-start inject carries the one-shot suffix");

  // Turn 2 — stale flip (a successful compress lands after the anchor). The old
  // zeroing reset re-armed the mass bypass right here; re-anchoring must keep it
  // consumed while still resetting cross-scale growth to zero.
  const turn2 = [...turn1, compressPanel("pa")];
  await t.fire(turn2, 175_000);
  st = await t.state();
  assert.ok(st.nudge.lastNudgeShownTokens > 0, `references survive the stale flip (got ${st.nudge.lastNudgeShownTokens})`);
  assert.equal(count(await t.logText(), "first-sight mass"), 1, "stale flip must not re-arm the mass bypass");

  // Turn 3 — fresh flip-back (new provider usage after the compress): same
  // requirement in the other direction. Old code zeroed again → suffix re-fired.
  const turn3 = [...turn2, usageAssistant("a41", "ok", 175_000)];
  await t.fire(turn3, 175_000);
  st = await t.state();
  assert.ok(st.nudge.lastNudgeShownTokens >= 170_000, `re-stamped on provider scale after flip-back (got ${st.nudge.lastNudgeShownTokens})`);
  assert.equal(count(await t.logText(), "first-sight mass"), 1, "fresh flip-back must not re-arm the mass bypass");
  await t.cleanup();
});

test("#455 calibration anchors the estimate to stable fresh provider usage", async () => {
  const STATE = tmpPath("pai-acp-size-b.session.json");
  const LOG = tmpPath("pai-acp-size-b.log");
  await rm(`${STATE}.acp.json`, { force: true });
  await rm(LOG, { force: true });
  const t = setup(STATE, LOG, "size-b", 180_000);
  const bulk = bulkMessages(46);

  // Estimate ~172K (95%+) vs a ~100K provider measurement: without calibration
  // the meter would sit in the emergency band while the host sees 55%.
  const turn1 = [...bulk, usageAssistant("b46", "ok", 100_000)];
  await t.fire(turn1, 100_000);
  assert.ok(await t.turnTokens(1) >= 170_000, `turn 1 uncapped with a single sample (got ${await t.turnTokens(1)})`);

  const turn2 = [...turn1, msg("u2", "user", "more " + MID), usageAssistant("b47", "ok", 101_000)];
  await t.fire(turn2, 101_000);
  assert.ok(await t.turnTokens(2) >= 170_000, `turn 2 uncapped with two samples (got ${await t.turnTokens(2)})`);

  // Third agreeing sample → window stable → cap at measured x 1.2. The capped
  // value is exact regardless of estimator noise (estimate far exceeds the cap).
  const turn3 = [...turn2, msg("u3", "user", "more " + MID), usageAssistant("b48", "ok", 102_000)];
  await t.fire(turn3, 102_000);
  assert.equal(await t.turnTokens(3), Math.ceil(102_000 * 1.2), "turn 3 capped at measured x 1.2");
  assert.equal(count(await t.logText(), "size-divergence"), 0, "calibration resolves the divergence — no warn");

  // Stale anchor (compress postdates the last usage): calibration disengages
  // even though the sample history is still stable — a pre-compress measurement
  // does not describe the post-compress view.
  const turn4 = [...turn3, compressPanel("pb")];
  await t.fire(turn4, 103_000);
  assert.ok(await t.turnTokens(4) >= 175_000, `turn 4 back on raw estimate while stale (got ${await t.turnTokens(4)})`);
  await t.cleanup();
});

test("#455 jittering provider usage refuses calibration and warns once past 2x", async () => {
  const STATE = tmpPath("pai-acp-size-c.session.json");
  const LOG = tmpPath("pai-acp-size-c.log");
  await rm(`${STATE}.acp.json`, { force: true });
  await rm(LOG, { force: true });
  const t = setup(STATE, LOG, "size-c", 180_000);
  const bulk = bulkMessages(60);

  // Estimate ~225K vs a measurement swinging 100K↔130K (30% spread > 25%
  // tolerance): the window never stabilizes, so the raw estimate stands and the
  // >2x disagreement persists straight through three turns.
  const turn1 = [...bulk, usageAssistant("c60", "ok", 100_000)];
  await t.fire(turn1, 100_000);
  const turn2 = [...turn1, msg("u2", "user", "more " + MID), usageAssistant("c61", "ok", 130_000)];
  await t.fire(turn2, 130_000);
  const turn3 = [...turn2, msg("u3", "user", "more " + MID), usageAssistant("c62", "ok", 100_000)];
  await t.fire(turn3, 100_000);
  assert.ok(await t.turnTokens(3) >= 230_000, `jitter refused: turn 3 still on raw estimate (got ${await t.turnTokens(3)})`);
  assert.equal(count(await t.logText(), "size-divergence"), 1, "one warn per divergence episode");

  const turn4 = [...turn3, msg("u4", "user", "more " + MID), usageAssistant("c63", "ok", 130_000)];
  await t.fire(turn4, 130_000);
  assert.equal(count(await t.logText(), "size-divergence"), 1, "episode continues: no second warn");
  await t.cleanup();
});
