import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { createRuntime } from "../src/runtime.js";
import { tmpPath } from "./tmp-path.js";

// #598 root fix: k̂ calibration between the local sent-view estimate and the
// provider's reported usage (borrowed from billion-context#1940 F1/F2/F4).
// The dead-band (PR #599) merely tolerates the two-rulers jitter; k̂ replaces
// the rulers with one learned continuous factor, so the equality-line crossing
// stops existing as a signal. Real transitions — model switch, a materially
// different k̂ publishing (>10% meter shift, mirroring the dead-band ratio) —
// still re-anchor growth baselines (#267 semantics).
//
// Two layers:
//  - unit: runtime.noteKhatUsage/khatFor/setKhatPending semantics directly
//    (admission bounds, ring, two-agree publish, deflate clamp, disagreement
//    clear, model switch, material-transition gate).
//  - integration: the full context transform — #598's jitter never re-anchors
//    once k̂ is published, while a materially deflating k̂ re-anchors.

const STATE_FILE = tmpPath("pai-acp-khat.session.json");

// ---------------------------------------------------------------------------
// unit layer
// ---------------------------------------------------------------------------

test("k̂ admission bounds, ring, and two-agree publish (unit)", async () => {
  const rt = createRuntime({});
  assert.equal(rt.khatFor("s", "m1"), null, "nothing published initially");
  assert.equal(rt.noteKhatUsage("s", "m1", 5000).khat, null, "usage with no pending settles nothing");

  // estimate below the admission floor never becomes a sample
  rt.setKhatPending("s", "m1", 1000);
  assert.equal(rt.noteKhatUsage("s", "m1", 900).khat, null, "pending < 2000 tokens rejected");

  // implausible ratios (outside [0.2, 5]) never become samples
  rt.setKhatPending("s", "m1", 10000);
  assert.equal(rt.noteKhatUsage("s", "m1", 900).khat, null, "ratio 0.09 < 0.2 rejected");
  rt.setKhatPending("s", "m1", 10000);
  assert.equal(rt.noteKhatUsage("s", "m1", 60000).khat, null, "ratio 6.0 > 5 rejected");

  // a single plausible sample does not publish
  rt.setKhatPending("s", "m1", 10000);
  const one = rt.noteKhatUsage("s", "m1", 8000);
  assert.equal(one.khat, null, "single sample does not publish");
  assert.equal(one.scaleChanged, false);

  // a second agreeing sample publishes the clamped mean: (0.8 + 0.82) / 2
  rt.setKhatPending("s", "m1", 10000);
  const two = rt.noteKhatUsage("s", "m1", 8200);
  assert.ok(two.khat !== null && Math.abs(two.khat - 0.81) < 1e-9, `published mean 0.81 (got ${two.khat})`);
  assert.equal(two.scaleChanged, true, "1 → 0.81 factor shift is material (>10%)");
  assert.equal(rt.khatFor("s", "m1"), two.khat, "khatFor exposes the published factor");

  // sticky: a fresh agreeing-ish sample changes nothing
  rt.setKhatPending("s", "m1", 10000);
  const sticky = rt.noteKhatUsage("s", "m1", 9000);
  assert.ok(sticky.khat !== null && Math.abs(sticky.khat - 0.81) < 1e-9, "in-window sample is sticky-ignored");
  assert.equal(sticky.scaleChanged, false);
});

test("k̂ is deflate-only (unit)", async () => {
  const rt = createRuntime({});
  rt.setKhatPending("s", "m1", 10000);
  rt.noteKhatUsage("s", "m1", 15000); // ratio 1.5 → clamped sample 1.0
  rt.setKhatPending("s", "m1", 10000);
  const r = rt.noteKhatUsage("s", "m1", 16000); // ratio 1.6 → clamped sample 1.0
  assert.ok(r.khat !== null && Math.abs(r.khat - 1) < 1e-9, `inflating ratios clamp to 1 (got ${r.khat})`);
  assert.equal(r.scaleChanged, false, "1 → 1 is not a scale change");
});

test("k̂ disagreement clears and relearns (unit)", async () => {
  const rt = createRuntime({});
  rt.setKhatPending("s", "m1", 10000);
  rt.noteKhatUsage("s", "m1", 8000); // 0.8
  rt.setKhatPending("s", "m1", 10000);
  rt.noteKhatUsage("s", "m1", 8100); // 0.81 → published 0.805

  // a settled sample ×2+ away from the published factor clears it
  rt.setKhatPending("s", "m1", 10000);
  const cleared = rt.noteKhatUsage("s", "m1", 3000); // ratio 0.3, 0.805/0.3 > 2
  assert.equal(cleared.khat, null, "disagreeing sample clears the published factor");
  assert.equal(cleared.scaleChanged, true, "0.805 → 1 fallback is material");
  assert.equal(rt.khatFor("s", "m1"), null);

  // relearn: the disagreement sample (0.3) seeds the new ring, and the next
  // sample (0.6) pairs with it (0.6/0.3 exactly at the ×2 edge) — publish 0.45
  rt.setKhatPending("s", "m1", 10000);
  const republished = rt.noteKhatUsage("s", "m1", 6000);
  assert.ok(republished.khat !== null && Math.abs(republished.khat - 0.45) < 1e-9, `relearned from the disagreement seed (got ${republished.khat})`);
  assert.equal(republished.scaleChanged, true, "1 → 0.45 relearn is material");

  // a further in-window sample is sticky again
  rt.setKhatPending("s", "m1", 10000);
  const settled = rt.noteKhatUsage("s", "m1", 6200);
  assert.ok(settled.khat !== null && Math.abs(settled.khat - 0.45) < 1e-9, "post-relearn samples are sticky");
});

test("k̂ model switch resets the state; only a material factor re-anchors (unit)", async () => {
  const rt = createRuntime({});
  rt.setKhatPending("s", "m1", 10000);
  rt.noteKhatUsage("s", "m1", 6000);
  rt.setKhatPending("s", "m1", 10000);
  rt.noteKhatUsage("s", "m1", 6200); // published 0.61

  rt.setKhatPending("s", "m1", 10000); // pending recorded under m1
  const switched = rt.noteKhatUsage("s", "m2", 6100);
  assert.equal(switched.khat, null, "switching model drops both the factor and the cross-model pending");
  assert.equal(switched.scaleChanged, true, "0.61 → 1 across a model switch is material");

  // a near-1 factor is NOT material across a switch
  const rt2 = createRuntime({});
  rt2.setKhatPending("s2", "m1", 10000);
  rt2.noteKhatUsage("s2", "m1", 9500);
  rt2.setKhatPending("s2", "m1", 10000);
  const nearOne = rt2.noteKhatUsage("s2", "m1", 9600); // published 0.955
  assert.equal(nearOne.scaleChanged, false, "1 → 0.955 is inside the material band");
  const switched2 = rt2.noteKhatUsage("s2", "m2", 9500);
  assert.equal(switched2.scaleChanged, false, "0.955 → 1 across a model switch is inside the material band");
  assert.equal(switched2.khat, null);
});

// ---------------------------------------------------------------------------
// integration layer (full context transform, same harness as #599's tests)
// ---------------------------------------------------------------------------

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

// Post-#601 a provider reading must ride the assistant message to count as a
// settlement: a context-only number is the raw session-tree sum, which the
// freshness guard (and the k̂ learner behind it) must not trust (#600). The
// integration scenarios below anchor every usage report on the message it
// belongs to, exactly as the pi host does.

const MID = "lorem ".repeat(3000);
let branchEntries: any[] = [];

function fakeCtx(sid: string, tokens: number) {
  return {
    mode: "rpc" as const,
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 180_000 },
    sessionManager: {
      getBranch: () => branchEntries as any[],
      getSessionId: () => sid,
      getSessionFile: () => STATE_FILE,
    },
    getContextUsage: () => ({ tokens, percent: tokens / 180_000, contextWindow: 180_000 }),
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, entries: any[], ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);

function bulkEntries(): any[] {
  const entries: any[] = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 18; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  return entries;
}

const readBaseline = async () =>
  (JSON.parse(await readFile(`${STATE_FILE}.acp.json`, "utf-8")) as { nudge: { lastPerMessageNudgeTokens: number } }).nudge.lastPerMessageNudgeTokens;

test("#598 regression: equality-line jitter never re-anchors once k̂ is published", async () => {
  const logFile = tmpPath("pai-acp-khat-jitter.log");
  await rm(logFile, { force: true });
  process.env.ACP_LOG_FILE = logFile;
  try {
    await rm(`${STATE_FILE}.acp.json`, { force: true });
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 180_000 })(api as any);

    // T1 — no provider usage yet: cold start stamps the baseline at the
    // estimate scale E (~85K).
    const t1 = bulkEntries();
    branchEntries = t1;
    await fire(handlers, t1, fakeCtx("khat-jitter", 0));
    const E = await readBaseline();
    assert.ok(E > 10_000, `estimate-scale baseline established (got ${E})`);

    // T2 + T3 — the provider consistently reports ~95% of the estimate: two
    // settled agreeing samples publish k̂ ≈ 0.95. The 1 → 0.95 factor shift is
    // inside the material band, so the baselines must NOT reset.
    const t2 = [...t1, msg("e19", "assistant", "ack-2", { input: Math.round(E * 0.95), cacheRead: 0, cacheWrite: 0 })];
    branchEntries = t2;
    await fire(handlers, t2, fakeCtx("khat-jitter", Math.round(E * 0.95)));
    assert.equal(await readBaseline(), E, "first settled sample does not re-anchor");
    const t3 = [...t2, msg("e20", "assistant", "ack-3", { input: Math.round(E * 0.96), cacheRead: 0, cacheWrite: 0 })];
    branchEntries = t3;
    await fire(handlers, t3, fakeCtx("khat-jitter", Math.round(E * 0.96)));
    assert.equal(await readBaseline(), E, "k̂ ≈ 0.95 publishing is not material — no re-anchor");

    // T4/T5/T6 — the exact #598 jitter: provider report crosses the estimate
    // line turn-to-turn (±3%). On the calibrated single ruler these are
    // sub-band wobbles; the baseline must keep accumulating real growth.
    const t4 = [...t3, msg("e21", "assistant", "ack-4", { input: Math.round(E * 1.03), cacheRead: 0, cacheWrite: 0 })];
    branchEntries = t4;
    await fire(handlers, t4, fakeCtx("khat-jitter", Math.round(E * 1.03)));
    assert.equal(await readBaseline(), E, "over-estimate micro-crossing does not re-anchor");
    const t5 = [...t4, msg("e22", "assistant", "ack-5", { input: Math.round(E * 0.97), cacheRead: 0, cacheWrite: 0 })];
    branchEntries = t5;
    await fire(handlers, t5, fakeCtx("khat-jitter", Math.round(E * 0.97)));
    assert.equal(await readBaseline(), E, "under-estimate micro-crossing does not re-anchor");
    const t6 = [...t5, msg("e23", "assistant", "ack-6", { input: Math.round(E * 1.02), cacheRead: 0, cacheWrite: 0 })];
    branchEntries = t6;
    await fire(handlers, t6, fakeCtx("khat-jitter", Math.round(E * 1.02)));
    assert.equal(await readBaseline(), E, "repeated jitter keeps the baseline accumulating");

    const log = await readFile(logFile, "utf-8");
    assert.ok(!log.includes("scale-flip-reanchor"), "no re-anchor fired during the whole jitter sequence");
    await rm(`${STATE_FILE}.acp.json`, { force: true });
  } finally {
    delete process.env.ACP_LOG_FILE;
  }
});

test("a materially deflating k̂ re-anchors the baseline onto the calibrated scale", async () => {
  const logFile = tmpPath("pai-acp-khat-deflate.log");
  await rm(logFile, { force: true });
  process.env.ACP_LOG_FILE = logFile;
  try {
    await rm(`${STATE_FILE}.acp.json`, { force: true });
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: 180_000 })(api as any);

    // T1 — estimate-scale cold start (~85K).
    const t1 = bulkEntries();
    branchEntries = t1;
    await fire(handlers, t1, fakeCtx("khat-deflate", 0));
    const E = await readBaseline();
    assert.ok(E > 10_000, `estimate-scale baseline established (got ${E})`);

    // T2 — provider reports ~60% of the estimate (the #267/#452 disease: the
    // local estimate carries ~1.6x phantom mass). First sample: no publish.
    const t2 = [...t1, msg("e19", "assistant", "ack-2", { input: Math.round(E * 0.6), cacheRead: 0, cacheWrite: 0 })];
    branchEntries = t2;
    await fire(handlers, t2, fakeCtx("khat-deflate", Math.round(E * 0.6)));
    assert.equal(await readBaseline(), E, "first deflating sample does not publish or re-anchor");

    // T3 — second agreeing sample publishes k̂ ≈ 0.6: a material transition.
    // The baseline must re-anchor onto the calibrated scale so the following
    // growth is not read as a huge fake drop.
    const t3 = [...t2, msg("e20", "assistant", "ack-3", { input: Math.round(E * 0.62), cacheRead: 0, cacheWrite: 0 })];
    branchEntries = t3;
    await fire(handlers, t3, fakeCtx("khat-deflate", Math.round(E * 0.62)));
    const B3 = await readBaseline();
    assert.ok(B3 < E * 0.8, `baseline re-anchored onto the deflated scale (was ${E}, now ${B3})`);
    assert.ok(B3 > E * 0.45, `re-anchored baseline is on the provider scale, not zeroed (got ${B3})`);

    const log = await readFile(logFile, "utf-8");
    assert.ok(log.includes("source=khat"), "the re-anchor is attributed to the k̂ transition");
    await rm(`${STATE_FILE}.acp.json`, { force: true });
  } finally {
    delete process.env.ACP_LOG_FILE;
  }
});
