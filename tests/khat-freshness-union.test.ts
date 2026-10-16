import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

// Union regression for #601 × #605: on a NON-fRESH turn (errored model turn,
// #600) realPromptTokens is the REPLAYED lastRealTokens, not a new settlement.
// Feeding that replay into the k̂ learner pairs stale usage with the current
// request's estimate — here a ~0.27 sample that disagrees with the published
// ~0.8 factor beyond KHAT_AGREE_FACTOR (2), clearing the learned ruler and
// re-anchoring the nudge baselines at the raw estimate scale. The learner must
// stay gated on fresh: baseline keeps accumulating on the calibrated ruler.
// Red against the naive text-union (k̂ block ungated), green with the gate.

const STATE_FILE = tmpPath("pai-acp-khat-union.session.json");

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

function msg(id: string, role: string, text: string, usage?: any) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now(), ...(usage ? { usage } : {}) } };
}

// ~3K tokens per message; 7 messages ≈ 21K estimate — above KHAT_MIN_ESTIMATE
// (2000), below the flat 50K first-sight-mass nudge floor, and sized so the
// gated T4 growth (calibrated ~2.9E minus 0.8E baseline ≈ 44K) stays under 50K.
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
      getSessionId: () => "khat-union",
      getSessionFile: () => STATE_FILE,
    },
    getContextUsage: () => ({ tokens, percent: tokens / 180_000, contextWindow: 180_000 }),
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, entries: any[], ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);

const nudgeCount = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached|compress/i.test(JSON.stringify(m.content))).length;

const readBaseline = async () =>
  (JSON.parse(await readFile(`${STATE_FILE}.acp.json`, "utf-8")) as { nudge: { lastPerMessageNudgeTokens: number } }).nudge.lastPerMessageNudgeTokens;

const bulkEntries = (): any[] => {
  const entries = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 6; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  return entries;
};

test("union: errored turn must not feed the k̂ learner (stale replay keeps the calibrated ruler)", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);

  // T1 — cold start, no provider usage: baseline stamps at the estimate scale E.
  const t1 = bulkEntries();
  branchEntries = t1;
  await fire(handlers, t1, fakeCtx(0));
  const E = await readBaseline();
  assert.ok(E > 10_000 && E < 50_000, `estimate-scale baseline in band (got ${E})`);

  // T2 + T3 — provider consistently reports 80% of the estimate: two agreeing
  // settled samples publish k̂ ≈ 0.8 (a material 1 → 0.8 shift, so the
  // baselines re-anchor once onto the calibrated ruler: B1 ≈ 0.8·E).
  const t2 = [...t1, msg("e7", "assistant", "ack-2", { input: Math.round(E * 0.8), cacheRead: 0, cacheWrite: 0 })];
  branchEntries = t2;
  await fire(handlers, t2, fakeCtx(Math.round(E * 0.8)));
  const t3 = [...t2, msg("e8", "assistant", "ack-3", { input: Math.round(E * 0.8), cacheRead: 0, cacheWrite: 0 })];
  branchEntries = t3;
  await fire(handlers, t3, fakeCtx(Math.round(E * 0.8)));
  const B1 = await readBaseline();
  assert.ok(B1 > 0 && B1 < E, `published k̂ re-anchored the baseline onto the calibrated scale (got ${B1} vs E=${E})`);

  // T4 — errored turn (#600): latest assistant carries no usage; the host
  // reports the raw tree-sum (rejected, floor at lastRealTokens = 0.8E). The
  // session grows to ~2.9E and setKhatPending records that grown estimate for
  // the request being built — it stays pending because this turn settles
  // nothing (gated). Ungated, the replayed 0.8E double-settles T3's pending
  // (agreeing sample, harmless) — the corruption lands one turn later.
  const t4 = [...t3, msg("e9", "user", "q4 " + MID)];
  for (let i = 10; i <= 22; i++) t4.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `g${i} ` + MID));
  t4.push({ type: "message", id: "e23", parentId: null, timestamp: "", message: { role: "assistant", content: "g23", timestamp: Date.now(), stopReason: "error", errorMessage: "Error: fetch failed" } });
  branchEntries = t4;
  const r4 = await fire(handlers, t4, fakeCtx(Math.round(E * 2.9)));
  assert.equal(nudgeCount(r4), 0, "calibrated growth stays under the 50K cadence floor — no nudge");
  assert.equal(await readBaseline(), B1, "first errored turn must not perturb the calibrated ruler");

  // T5 — the network is STILL down (repeated fetch failures, the real #600
  // recipe): another errored turn. Ungated, the replayed 0.8E now pairs with
  // the ~2.9E pending estimate → a ~0.27 sample outside the publish window
  // (0.8 / 0.27 > KHAT_AGREE_FACTOR 2) → k̂ cleared, baselines re-anchored at
  // the RAW estimate scale. Gated, the ruler survives and the baseline keeps
  // accumulating on the calibrated scale.
  const t5 = [...t4, { type: "message", id: "e24", parentId: null, timestamp: "", message: { role: "assistant", content: "g24", timestamp: Date.now(), stopReason: "error", errorMessage: "Error: fetch failed" } }];
  branchEntries = t5;
  const r5 = await fire(handlers, t5, fakeCtx(Math.round(E * 2.9)));
  assert.equal(nudgeCount(r5), 0, "still no spurious nudge on repeated errored turns");
  assert.equal(await readBaseline(), B1, "stale replay must not clear k̂ / re-anchor the baselines (union gate)");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});
