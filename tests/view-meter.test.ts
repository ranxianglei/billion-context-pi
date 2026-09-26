import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, defaultConfig, type CompressionBlock, type CompressionState } from "acp-kernel";
import { entriesToCoreMessages } from "../src/messages.js";
import { estimateTokens } from "../src/tokens.js";
import { truncateCap } from "../src/tokens.js";
import { SentViewMeter, VIEW_METER_RESYNC_EVERY, exactBandFloor, viewMeterFingerprint } from "../src/view-meter.js";

const L = 200_000;

function msg(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content, timestamp: Date.now(), ...extra } };
}

function seedBlock(state: CompressionState, blockId: string, ids: string[], summary = "s".repeat(200)): void {
  const block: CompressionBlock = {
    blockId,
    runId: `run-${blockId}`,
    tier: 1,
    topic: undefined,
    summary,
    directMessageIds: ids,
    effectiveMessageIds: ids,
    directBlockIds: [],
    compressedTokens: 0,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
  };
  state.blocks.push(block);
}

test("truncateCap: exact upper bound under the emergency-truncate edge", () => {
  assert.equal(truncateCap(defaultConfig(200_000)), 189_999); // floor(0.95*200k)-1
  assert.equal(truncateCap({ modelContextLimit: 1000, truncate: { threshold: 0.5, terminalEscapeAfter: 3 } }), 499);
  assert.equal(truncateCap({ modelContextLimit: 0, truncate: { threshold: 0.95, terminalEscapeAfter: 3 } }), Number.MAX_SAFE_INTEGER);
  assert.equal(truncateCap({ modelContextLimit: -1, truncate: { threshold: 0.95, terminalEscapeAfter: 3 } }), Number.MAX_SAFE_INTEGER);
});

test("exactBandFloor: margin below the cap; degenerate limits stay honest", () => {
  const cfg = defaultConfig(200_000);
  assert.equal(exactBandFloor(cfg), truncateCap(cfg) - Math.max(2000, Math.round(200_000 * 0.02)));
  assert.equal(exactBandFloor(cfg), 185_999);
  assert.equal(exactBandFloor({ modelContextLimit: 0, truncate: { threshold: 0.95, terminalEscapeAfter: 3 } }), Number.MAX_SAFE_INTEGER);
  // Margin exceeds the cap entirely → floor clamps at 0 (probe always wins).
  assert.equal(exactBandFloor({ modelContextLimit: 1000, truncate: { threshold: 0.5, terminalEscapeAfter: 3 } }), 0);
});

test("fingerprint: stable across per-turn ref/snapshot growth (the #561 invalidation bug)", () => {
  const state = createInitialState();
  seedBlock(state, "b0", ["m1", "m2", "m3"]);
  const before = viewMeterFingerprint(state, 1234);
  // assignRefs grows both maps every turn; refs are never re-issued.
  state.messageRefs.byRaw["m4"] = { ref: "m00004", assignedAt: Date.now() };
  state.messageRefs.byRef["m00004"] = "m4";
  state.tokenSnapshot = { tokens: 999_999, at: Date.now(), source: "estimate" };
  assert.equal(viewMeterFingerprint(state, 1234), before, "ref growth must not invalidate the meter base");
});

test("fingerprint: sensitive to every structural change that alters the sent view", () => {
  const mk = () => {
    const s = createInitialState();
    seedBlock(s, "b0", ["m1", "m2", "m3"]);
    return s;
  };
  const base = viewMeterFingerprint(mk(), 1234);

  const s2 = mk();
  seedBlock(s2, "b1", ["m9"]);
  assert.notEqual(viewMeterFingerprint(s2, 1234), base, "new active block");

  const s3 = mk();
  s3.blocks[0].active = false;
  assert.notEqual(viewMeterFingerprint(s3, 1234), base, "block deactivated");

  const s4 = mk();
  s4.blocks[0].effectiveMessageIds = ["m1", "m2"];
  assert.notEqual(viewMeterFingerprint(s4, 1234), base, "coverage shrunk");

  const s5 = mk();
  s5.blocks[0].summary = "different summary";
  assert.notEqual(viewMeterFingerprint(s5, 1234), base, "summary changed");

  const s6 = mk();
  s6.absorbed?.push({ rawId: "x", absorbedInto: "b0", at: Date.now() });
  assert.notEqual(viewMeterFingerprint(s6, 1234), base, "absorb record added");

  const s7 = mk();
  s7.rules?.push({ id: 1, kind: "keep", pattern: "p", enabled: true });
  assert.notEqual(viewMeterFingerprint(s7, 1234), base, "rule added");

  assert.notEqual(viewMeterFingerprint(mk(), 9999), base, "system prompt tokens changed");

  const s8 = mk();
  s8.blocks.push({ ...mk().blocks[0], blockId: "bz", active: false });
  assert.notEqual(viewMeterFingerprint(s8, 1234), base, "inactive block still counts toward blocks.length");
});

test("meter: no-base until seeded, null on clean append-only extension", () => {
  const cfg = defaultConfig(L);
  const meter = new SentViewMeter();
  const entries = [msg("e1", "user", "hi"), msg("e2", "assistant", "hello")];
  const fp = "fp";
  assert.equal(meter.hasBase, false);
  assert.equal(meter.resyncReason({ entries, fingerprint: fp, prelim: 100, config: cfg }), "no-base");

  meter.resync(120, entries, fp);
  assert.equal(meter.hasBase, true);
  const extended = [...entries, msg("e3", "user", "more")];
  assert.equal(meter.resyncReason({ entries: extended, fingerprint: fp, prelim: 130, config: cfg }), null);
});

test("meter: resync reasons cover shrink, tail mismatch, structure change, band, drift bound", () => {
  const cfg = defaultConfig(L);
  const meter = new SentViewMeter();
  const entries = [msg("e1", "user", "a"), msg("e2", "user", "b"), msg("e3", "user", "c")];
  const fp = "fp";
  meter.resync(100, entries, fp);

  assert.equal(meter.resyncReason({ entries: entries.slice(0, 2), fingerprint: fp, prelim: 90, config: cfg }), "shrink");
  const rewound = [msg("e1", "user", "a"), msg("e2", "user", "b"), msg("X", "user", "c")];
  assert.equal(meter.resyncReason({ entries: rewound, fingerprint: fp, prelim: 90, config: cfg }), "tail-mismatch");
  assert.equal(meter.resyncReason({ entries, fingerprint: "other", prelim: 90, config: cfg }), "structure-change");
  assert.equal(meter.resyncReason({ entries, fingerprint: fp, prelim: exactBandFloor(cfg), config: cfg }), "truncate-band");
  assert.equal(meter.resyncReason({ entries, fingerprint: fp, prelim: exactBandFloor(cfg) - 1, config: cfg }), null);

  for (let i = 0; i < VIEW_METER_RESYNC_EVERY; i++) meter.extrapolate(entries);
  assert.equal(meter.resyncReason({ entries, fingerprint: fp, prelim: 90, config: cfg }), "drift-bound");
  meter.resync(100, entries, fp);
  assert.equal(meter.resyncReason({ entries, fingerprint: fp, prelim: 90, config: cfg }), null, "resync resets the drift counter");
});

test("meter: extrapolate adds only the appended tail; stable with no appends", () => {
  const cfg = defaultConfig(L);
  const meter = new SentViewMeter();
  const head = [msg("h1", "user", "head ".repeat(50)), msg("h2", "assistant", "ok")];
  const fp = "fp";
  meter.resync(1000, head, fp);

  const appended = [msg("a1", "user", "tail ".repeat(100)), msg("a2", "assistant", "done")];
  const full = [...head, ...appended];
  const expectedDelta = estimateTokens(entriesToCoreMessages(full.slice(head.length)));
  const out = meter.extrapolate(full);
  assert.equal(out, 1000 + expectedDelta, "base + projected tail cost");
  assert.ok(expectedDelta > 0, "fixture tail must carry tokens");
  assert.equal(meter.extrapolate(full), 1000 + expectedDelta, "re-extrapolation without new appends is stable");
});
