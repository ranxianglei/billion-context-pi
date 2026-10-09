import { test } from "node:test";
import assert from "node:assert/strict";
import { liveOnlyTail, liveOnlyTailCached, dropLiveOnlyTailCache } from "../src/live-only-tail.js";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

function msgEntry(id: string, message: object): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: message as SessionMessageEntry["message"],
  };
}
function user(text: string): object {
  return { role: "user", content: text, timestamp: Date.now() };
}
function assistant(text: string): object {
  return { role: "assistant", content: text, timestamp: Date.now() };
}
// An aborted/errored turn persists an assistant message with NO content blocks.
function emptyAssistant(): object {
  return { role: "assistant", content: [], timestamp: Date.now() };
}

// Structural comparison: the plain function returns live-slice references, the
// cached one returns a fresh slice — compare shapes, not identity.
function tailShape(tail: object[] | null): unknown {
  if (tail === null) return null;
  return tail.map((m) => {
    const r = m as Record<string, unknown>;
    const c = r.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? (c as { text?: unknown }[]).map((b) => (typeof b.text === "string" ? b.text : "")).join("\n") : "";
    return { role: r.role, text };
  });
}

// #559: the cached path must reach the SAME verdict as the plain walk, including
// the miss diagnostic — the pre-fix fast path returned a bare tail/null with no way
// to tell "aligned, nothing to add" from "diverged, dropped".
function outcome(r: { tail: object[] | null; miss: unknown }): unknown {
  return { tail: tailShape(r.tail), miss: r.miss };
}

function grow(base: number): { entries: SessionEntry[]; live: object[] } {
  const entries: SessionEntry[] = [];
  const live: object[] = [];
  for (let i = 0; i < base; i++) {
    entries.push(msgEntry(`u${i}`, user(`q${i}`)));
    entries.push(msgEntry(`a${i}`, assistant(`r${i}`)));
    live.push(user(`q${i}`), assistant(`r${i}`));
  }
  return { entries, live };
}

test("cached variant matches plain variant across a steady growth sequence", () => {
  dropLiveOnlyTailCache("s1");
  let { entries, live } = grow(30);
  assert.deepEqual(outcome(liveOnlyTailCached("s1", entries, live)), outcome(liveOnlyTail(entries, live)));
  for (let round = 0; round < 6; round++) {
    entries = [...entries, ...grow(1).entries.map((e, i) => (e.type === "message" ? msgEntry(`u${round}-x${i}`, (e as SessionMessageEntry).message) : e))];
    live = [...live, user(`extra ${round}`)];
    assert.deepEqual(outcome(liveOnlyTailCached("s1", entries, live)), outcome(liveOnlyTail(entries, live)));
  }
});

test("host history rewrite below the proven prefix keeps the tail verdict (prefix is trusted by design)", () => {
  dropLiveOnlyTailCache("s2");
  const { entries, live } = grow(10);
  liveOnlyTailCached("s2", entries, live); // prime cache: proves [0, 20)
  // Same live array, but persisted history rewritten in the middle (same count).
  // The #561 append-only argument trusts the proven prefix (pi's jsonl only grows;
  // a same-length in-place rewrite is out-of-model), so the fast path does not
  // re-diagnose it — tail verdicts must still agree, which they do (both null).
  const rewritten = entries.map((e, i) => (i === 2 && e.type === "message" ? msgEntry(e.id, user("REWRITTEN")) : e));
  assert.deepEqual(tailShape(liveOnlyTailCached("s2", rewritten, live).tail), tailShape(liveOnlyTail(rewritten, live).tail));
});

test("rewind (persisted count drop) falls back and stays consistent", () => {
  dropLiveOnlyTailCache("s3");
  const { entries, live } = grow(8);
  liveOnlyTailCached("s3", entries, live);
  const truncated = entries.slice(0, 10);
  const truncatedLive = live.slice(0, 10);
  assert.deepEqual(outcome(liveOnlyTailCached("s3", truncated, truncatedLive)), outcome(liveOnlyTail(truncated, truncatedLive)));
});

test("oversized live-only tail returns null with the same miss as the plain walk (cold and warm)", () => {
  dropLiveOnlyTailCache("s4");
  const { entries } = grow(5);
  const bigTail = Array.from({ length: 20 }, (_, i) => user(`tail ${i}`));
  const live = [...entries.filter((e) => e.type === "message").map((e) => (e as SessionMessageEntry).message), ...bigTail];
  const cold = liveOnlyTailCached("s4", entries, live);
  assert.equal(cold.tail, null);
  assert.ok(cold.miss);
  assert.equal(cold.miss!.gapLive, 20);
  assert.deepEqual(outcome(cold), outcome(liveOnlyTail(entries, live)));
  // Warm: the fast path decides over-cap itself and must emit the same diagnostic.
  const warm = liveOnlyTailCached("s4", entries, live);
  assert.deepEqual(outcome(warm), outcome(liveOnlyTail(entries, live)));
});

test("new-pair divergence falls back to the full walk with an identical miss", () => {
  dropLiveOnlyTailCache("s4b");
  const { entries, live } = grow(10);
  liveOnlyTailCached("s4b", entries, live); // prime: proves [0, 20)
  // Grow one pair, but the NEW assistant reply differs from what was persisted:
  // the fast path walks the new pairs, sees the divergence, and must fall through
  // to the full walk — same miss as the uncached variant.
  const grownEntries = [...entries, msgEntry("u10", user("q10")), msgEntry("a10", assistant("r10"))];
  const grownLive = [...live, user("q10"), assistant("r10 CHANGED")];
  assert.deepEqual(outcome(liveOnlyTailCached("s4b", grownEntries, grownLive)), outcome(liveOnlyTail(grownEntries, grownLive)));
  assert.ok(liveOnlyTail(grownEntries, grownLive).miss);
});

test("suffix-recovery repeated across turns still returns the suffix (cached ≡ plain)", () => {
  dropLiveOnlyTailCache("s7");
  const entries: SessionEntry[] = [];
  const live: object[] = [];
  for (let i = 0; i < 5; i++) {
    entries.push(msgEntry(`u${i}`, user(`q${i}`)));
    entries.push(msgEntry(`a${i}`, assistant(`r${i}`)));
    live.push(user(`q${i}`), assistant(`r${i}`));
  }
  // Host appended a text suffix INTO the final user message without persisting an
  // entry (pi-web auto-name shape, #471): persisted ends at "base prompt", live
  // ends at "base prompt" + suffix. Turn 1 primes the cache through the recovery
  // branch; turn 2 repeats the SAME inputs (host still hasn't persisted) — the
  // cached path must not treat the recovered final pair as proven-aligned, or it
  // skips re-walking it and drops the suffix.
  entries.push(msgEntry("u5", user("base prompt")));
  live.push(user("base prompt\n\nGenerate a title"));
  assert.deepEqual(outcome(liveOnlyTailCached("s7", entries, live)), outcome(liveOnlyTail(entries, live)));
  assert.deepEqual(outcome(liveOnlyTailCached("s7", entries, live)), outcome(liveOnlyTail(entries, live)));
});

test("sessions are isolated by sid", () => {
  dropLiveOnlyTailCache("s5");
  dropLiveOnlyTailCache("s6");
  const a = grow(4);
  const b = grow(3);
  liveOnlyTailCached("s5", a.entries, a.live);
  assert.deepEqual(outcome(liveOnlyTailCached("s6", b.entries, b.live)), outcome(liveOnlyTail(b.entries, b.live)));
  // s5's cache must not have been clobbered: same inputs, same answer.
  assert.deepEqual(outcome(liveOnlyTailCached("s5", a.entries, a.live)), outcome(liveOnlyTail(a.entries, a.live)));
});

test("aborted-turn empty entry: host-pruned live stays aligned and the instruction is recovered via the fast path (#565)", () => {
  dropLiveOnlyTailCache("s8");
  // t0: one aligned turn primes the cache.
  const t0 = grow(1);
  assert.deepEqual(outcome(liveOnlyTailCached("s8", t0.entries, t0.live)), outcome(liveOnlyTail(t0.entries, t0.live)));
  // t1: an aborted turn appends an EMPTY assistant entry; the host prunes it from
  // its context array. Non-empty count and canary are unchanged -> fast path,
  // which must skip the empty entry instead of desyncing by one forever.
  const t1Entries = [...t0.entries, msgEntry("aborted", emptyAssistant())];
  const t1Live = [...t0.live];
  assert.deepEqual(outcome(liveOnlyTailCached("s8", t1Entries, t1Live)), outcome(liveOnlyTail(t1Entries, t1Live)));
  // t2: the user continues; the empty entry persists, the host still prunes.
  const t2Entries = [...t1Entries, msgEntry("u1", user("next"))];
  const t2Live = [...t1Live, user("next")];
  assert.deepEqual(outcome(liveOnlyTailCached("s8", t2Entries, t2Live)), outcome(liveOnlyTail(t2Entries, t2Live)));
  // t3: pi-web auto-name fires — the instruction exists only in the live array.
  // Pre-fix this returned null forever (off-by-one from the empty entry onward);
  // now the fast path recovers it.
  const t3Live = [...t2Live, user("Create a concise title for this conversation.")];
  const r = liveOnlyTailCached("s8", t2Entries, t3Live);
  assert.ok(r.tail);
  assert.equal(r.miss, null);
  assert.deepEqual(tailShape(r.tail), [{ role: "user", text: "Create a concise title for this conversation." }]);
  assert.deepEqual(outcome(r), outcome(liveOnlyTail(t2Entries, t3Live)));
});
