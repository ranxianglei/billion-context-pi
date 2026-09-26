import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesToCoreMessages } from "../src/messages.js";
import { EntryProjectionCache, PROJECTION_CACHE_MAX_ENTRIES } from "../src/projection-cache.js";

function msg(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content, timestamp: Date.now(), ...extra } };
}

function fixture(n: number) {
  const entries: any[] = [];
  for (let i = 1; i <= n; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `body ${i} lorem ipsum dolor sit amet`));
  return entries;
}

test("cache: first projection is a miss equal to full re-projection", () => {
  const cache = new EntryProjectionCache();
  const entries = fixture(10);
  const r = cache.project(entries);
  assert.equal(r.hit, false);
  assert.deepEqual(r.coreMessages, entriesToCoreMessages(entries));
  assert.equal(cache.size, 10);
});

test("cache: append-only extension is a hit sharing the cached prefix", () => {
  const cache = new EntryProjectionCache();
  const head = fixture(8);
  const first = cache.project(head);
  const extended = [...head, msg("e9", "user", "new turn"), msg("e10", "assistant", "reply")];
  const r = cache.project(extended);
  assert.equal(r.hit, true);
  assert.deepEqual(r.coreMessages, entriesToCoreMessages(extended));
  assert.equal(r.coreMessages[0], first.coreMessages[0], "prefix elements shared by reference, not re-projected");
  assert.equal(cache.size, 8, "size tracks the cached prefix length");
});

test("cache: repeated identical input stays a hit", () => {
  const cache = new EntryProjectionCache();
  const entries = fixture(5);
  cache.project(entries);
  const r = cache.project(entries);
  assert.equal(r.hit, true);
  assert.deepEqual(r.coreMessages, entriesToCoreMessages(entries));
});

test("cache: shrink is a miss with full re-projection", () => {
  const cache = new EntryProjectionCache();
  const entries = fixture(6);
  cache.project(entries);
  const shorter = entries.slice(0, 4);
  const r = cache.project(shorter);
  assert.equal(r.hit, false);
  assert.deepEqual(r.coreMessages, entriesToCoreMessages(shorter));
  assert.equal(cache.size, 4, "cache re-anchored to the shorter prefix");
});

test("cache: branch switch (same length, different tail id) is a miss", () => {
  const cache = new EntryProjectionCache();
  const entries = fixture(5);
  cache.project(entries);
  const branched = [...entries.slice(0, 4), msg("e5-branch", "user", "rewound")];
  const r = cache.project(branched);
  assert.equal(r.hit, false);
  assert.deepEqual(r.coreMessages, entriesToCoreMessages(branched));
});

test("cache: empty input misses; reset clears the base", () => {
  const cache = new EntryProjectionCache();
  assert.equal(cache.project([]).hit, false);
  const entries = fixture(4);
  cache.project(entries);
  cache.reset();
  assert.equal(cache.size, 0);
  assert.equal(cache.project(entries).hit, false);
});

test("cache: over-cap input falls back to full projection and resets", () => {
  const cache = new EntryProjectionCache(3);
  const five = fixture(5);
  const r = cache.project(five);
  assert.equal(r.hit, false);
  assert.deepEqual(r.coreMessages, entriesToCoreMessages(five));
  assert.equal(cache.size, 0, "no prefix pinned beyond the cap");
  const three = fixture(3);
  assert.equal(cache.project(three).hit, false, "fresh anchor after reset");
  assert.equal(PROJECTION_CACHE_MAX_ENTRIES, 50_000, "default cap unchanged");
});
