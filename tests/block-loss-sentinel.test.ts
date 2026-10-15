import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { BlockLossSentinel, classifyLoss, type ViewChurn } from "../src/block-loss-sentinel.js";

function msg(id: string, text?: string): CoreMessage {
  return { id, role: "user", contentType: "text", ...(text !== undefined ? { text } : {}) };
}

function churn(partial: Partial<ViewChurn>): ViewChurn {
  return { prevSize: 0, nowSize: 0, missingIds: 0, addedIds: 0, idChurnPct: 0, prevTexts: 0, missingTexts: 0, textLossPct: 0, ...partial };
}

describe("classifyLoss", () => {
  test("null (first sight) → no-prev-view", () => assert.equal(classifyLoss(null), "no-prev-view"));
  test("high id churn with low text loss → id-churn-suspected (#635 H1)", () =>
    assert.equal(classifyLoss(churn({ idChurnPct: 0.9, textLossPct: 0.1 })), "id-churn-suspected"));
  test("churn verdict flips to loss when text loss exceeds half the id churn", () =>
    assert.equal(classifyLoss(churn({ idChurnPct: 0.5, textLossPct: 0.3 })), "content-loss-suspected"));
  test("high text loss → content-loss-suspected (#635 H2)", () =>
    assert.equal(classifyLoss(churn({ idChurnPct: 0.4, textLossPct: 0.7 })), "content-loss-suspected"));
  test("low churn and low loss → unclassified", () =>
    assert.equal(classifyLoss(churn({ idChurnPct: 0.1, textLossPct: 0.1 })), "unclassified"));
});

describe("BlockLossSentinel", () => {
  test("first sight: null churn, no reset, prevActive 0", () => {
    const s = new BlockLossSentinel();
    const r = s.beginTurn("sid", [msg("a", "x")], ["b1"]);
    assert.deepEqual(r, { churn: null, resetSuspected: false, prevActive: 0 });
  });

  test("append-only growth reports zero churn", () => {
    const s = new BlockLossSentinel();
    s.beginTurn("sid", [msg("a", "x"), msg("b", "y")], []);
    const r = s.beginTurn("sid", [msg("a", "x"), msg("b", "y"), msg("c", "z")], []);
    assert.ok(r.churn);
    assert.equal(r.churn.prevSize, 2);
    assert.equal(r.churn.nowSize, 3);
    assert.equal(r.churn.missingIds, 0);
    assert.equal(r.churn.addedIds, 1);
    assert.equal(r.churn.idChurnPct, 0);
    assert.equal(r.churn.textLossPct, 0);
  });

  test("#635 H1 shape: ids re-minted, content intact → high id churn, zero text loss", () => {
    const s = new BlockLossSentinel();
    s.beginTurn("sid", [msg("a", "x"), msg("b", "y")], []);
    const r = s.beginTurn("sid", [msg("c", "x"), msg("d", "y")], []);
    assert.equal(r.churn!.idChurnPct, 1);
    assert.equal(r.churn!.missingTexts, 0);
    assert.equal(r.churn!.textLossPct, 0);
    assert.equal(classifyLoss(r.churn), "id-churn-suspected");
  });

  test("#635 H2 shape: content rewritten/folded by host → high text loss", () => {
    const s = new BlockLossSentinel();
    s.beginTurn("sid", [msg("a", "x"), msg("b", "y")], []);
    const r = s.beginTurn("sid", [msg("c", "completely new payload")], []);
    assert.equal(r.churn!.idChurnPct, 1);
    assert.equal(r.churn!.textLossPct, 1);
    assert.equal(classifyLoss(r.churn), "content-loss-suspected");
  });

  test("fragment ids share a base (baseIdOf normalization)", () => {
    const s = new BlockLossSentinel();
    s.beginTurn("sid", [msg("a#1", "x"), msg("b", "y")], []);
    const r = s.beginTurn("sid", [msg("a#9", "x"), msg("b", "y")], []);
    assert.equal(r.churn!.missingIds, 0);
    assert.equal(r.churn!.idChurnPct, 0);
  });

  test("duplicate texts are counted with multiplicity", () => {
    const s = new BlockLossSentinel();
    s.beginTurn("sid", [msg("a", "x"), msg("b", "x")], []);
    const r = s.beginTurn("sid", [msg("a", "x")], []);
    assert.equal(r.churn!.prevTexts, 2);
    assert.equal(r.churn!.missingTexts, 1);
    assert.equal(r.churn!.textLossPct, 0.5);
  });

  test("empty-text messages count toward ids but not text mass", () => {
    const s = new BlockLossSentinel();
    s.beginTurn("sid", [msg("a"), msg("b", "x")], []);
    const r = s.beginTurn("sid", [msg("a")], []);
    assert.equal(r.churn!.prevTexts, 1);
    assert.equal(r.churn!.missingTexts, 1);
    assert.equal(r.churn!.missingIds, 1);
  });

  test("settledLosses reports blocks deactivated during the turn", () => {
    const s = new BlockLossSentinel();
    s.beginTurn("sid", [msg("a", "x")], ["b1", "b2"]);
    assert.deepEqual(s.settledLosses("sid", ["b2"]), ["b1"]);
    assert.deepEqual(s.settledLosses("sid", ["b2"]), [], "settling the same post-set twice reports nothing");
  });

  test("#635 H3 shape: state comes back empty after holding active blocks → reset suspected", () => {
    const s = new BlockLossSentinel();
    s.beginTurn("sid", [msg("a", "x")], ["b1"]);
    s.settledLosses("sid", ["b1"]);
    const r = s.beginTurn("sid", [msg("a", "x"), msg("b", "y")], []);
    assert.equal(r.resetSuspected, true);
    assert.equal(r.prevActive, 1);
  });

  test("empty state on first sight is not a reset", () => {
    const s = new BlockLossSentinel();
    const r = s.beginTurn("sid", [msg("a", "x")], []);
    assert.equal(r.resetSuspected, false);
  });

  test("sessions are isolated from each other", () => {
    const s = new BlockLossSentinel();
    s.beginTurn("A", [msg("a", "x")], []);
    const rb = s.beginTurn("B", [msg("q", "w")], []);
    assert.equal(rb.churn, null, "B's first sight has no previous view");
    const ra = s.beginTurn("A", [msg("a", "x"), msg("c", "z")], []);
    assert.equal(ra.churn!.addedIds, 1, "A compares against A's own previous turn");
  });

  test("session cap evicts the oldest tracked session", () => {
    const s = new BlockLossSentinel();
    for (let i = 1; i <= 33; i++) s.beginTurn(`s${i}`, [msg(`m${i}`, `t${i}`)], []);
    const r = s.beginTurn("s1", [msg("m1", "t1")], []);
    assert.equal(r.churn, null, "s1's signature was evicted by the 33rd session");
  });
});
