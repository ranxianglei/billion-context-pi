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
  assert.deepEqual(tailShape(liveOnlyTailCached("s1", entries, live)), tailShape(liveOnlyTail(entries, live)));
  for (let round = 0; round < 6; round++) {
    entries = [...entries, ...grow(1).entries.map((e, i) => (e.type === "message" ? msgEntry(`u${round}-x${i}`, (e as SessionMessageEntry).message) : e))];
    live = [...live, user(`extra ${round}`)];
    const cached = tailShape(liveOnlyTailCached("s1", entries, live));
    const plain = tailShape(liveOnlyTail(entries, live));
    assert.deepEqual(cached, plain);
  }
});

test("host history rewrite past the boundary falls back to the full walk", () => {
  dropLiveOnlyTailCache("s2");
  const { entries, live } = grow(10);
  liveOnlyTailCached("s2", entries, live); // prime cache
  // Same live array, but persisted history rewritten in the middle (same count).
  const rewritten = entries.map((e, i) => (i === 2 && e.type === "message" ? msgEntry(e.id, user("REWRITTEN")) : e));
  const cached = tailShape(liveOnlyTailCached("s2", rewritten, live));
  const plain = tailShape(liveOnlyTail(rewritten, live));
  assert.deepEqual(cached, plain);
});

test("rewind (persisted count drop) falls back and stays consistent", () => {
  dropLiveOnlyTailCache("s3");
  const { entries, live } = grow(8);
  liveOnlyTailCached("s3", entries, live);
  const truncated = entries.slice(0, 10);
  const truncatedLive = live.slice(0, 10);
  const cached = tailShape(liveOnlyTailCached("s3", truncated, truncatedLive));
  const plain = tailShape(liveOnlyTail(truncated, truncatedLive));
  assert.deepEqual(cached, plain);
});

test("oversized live-only tail returns null exactly like the plain walk", () => {
  dropLiveOnlyTailCache("s4");
  const { entries } = grow(5);
  const bigTail = Array.from({ length: 20 }, (_, i) => user(`tail ${i}`));
  const live = [...entries.filter((e) => e.type === "message").map((e) => (e as SessionMessageEntry).message), ...bigTail];
  assert.equal(liveOnlyTailCached("s4", entries, live), null);
  assert.equal(liveOnlyTail(entries, live), null);
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
  assert.deepEqual(tailShape(liveOnlyTailCached("s7", entries, live)), tailShape(liveOnlyTail(entries, live)));
  assert.deepEqual(tailShape(liveOnlyTailCached("s7", entries, live)), tailShape(liveOnlyTail(entries, live)));
});

test("sessions are isolated by sid", () => {
  dropLiveOnlyTailCache("s5");
  dropLiveOnlyTailCache("s6");
  const a = grow(4);
  const b = grow(3);
  liveOnlyTailCached("s5", a.entries, a.live);
  const bCached = tailShape(liveOnlyTailCached("s6", b.entries, b.live));
  assert.deepEqual(bCached, tailShape(liveOnlyTail(b.entries, b.live)));
  // s5's cache must not have been clobbered: same inputs, same answer.
  const aCached = tailShape(liveOnlyTailCached("s5", a.entries, a.live));
  assert.deepEqual(aCached, tailShape(liveOnlyTail(a.entries, a.live)));
});
