import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesToCoreMessages, EntryProjectionCache } from "../src/messages.js";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

let seq = 0;
function msgEntry(id: string, message: object): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: message as SessionMessageEntry["message"],
  };
}
function boundary(): SessionEntry {
  return { type: "turn_boundary", id: `tb-${seq++}`, parentId: null, timestamp: new Date().toISOString() };
}
function userMsg(text: string): object {
  return { role: "user", content: text, timestamp: Date.now() };
}
function assistantMsg(text: string, thinking = ""): object {
  const content: unknown[] = [{ type: "text", text }];
  if (thinking) content.unshift({ type: "thinking", text: thinking });
  return { role: "assistant", content, timestamp: Date.now() };
}
function toolResult(toolCallId: string, text: string): object {
  return { role: "toolResult", toolCallId, toolName: "bash", content: text, timestamp: Date.now() };
}
function assistantCall(callId: string, args: unknown): object {
  return { role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: args }], timestamp: Date.now() };
}
function customEntry(id: string, customType: string, text: string): SessionEntry {
  return { type: "custom_message", id, parentId: null, timestamp: new Date().toISOString(), customType, content: [{ type: "text", text }], display: true };
}

function buildHistory(count: number): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push(boundary());
    out.push(msgEntry(`u-${seq}`, userMsg(`question ${i}`)));
    out.push(msgEntry(`a-${seq++}`, assistantMsg(`answer ${i}`, "thinking...")));
    if (i % 3 === 0) {
      out.push(msgEntry(`c-${seq++}`, assistantCall(`call-${i}`, { cmd: `ls ${i}` })));
      out.push(msgEntry(`t-${seq++}`, toolResult(`call-${i}`, `output ${i}`)));
    }
    if (i % 5 === 0) out.push(customEntry(`x-${seq++}`, "acp-status", "status text"));
    if (i % 7 === 0) out.push(msgEntry(`e-${seq++}`, assistantMsg("   "))); // thinking-only → dropped
  }
  return out;
}

test("incremental projection equals full projection across a growth sequence", () => {
  const cache = new EntryProjectionCache();
  let entries = buildHistory(40);
  assert.deepEqual(cache.project(entries), entriesToCoreMessages(entries));
  // Append a few turns at a time, re-projecting every time (fresh array objects,
  // like a host rebuilding entries from the jsonl each turn).
  for (let round = 0; round < 5; round++) {
    entries = [...entries, ...buildHistory(3)];
    const incremental = cache.project(entries);
    const full = entriesToCoreMessages(entries);
    assert.deepEqual(incremental, full);
    assert.equal(incremental.length, full.length);
  }
});

test("rewind (entry count drop) falls back to full projection", () => {
  const cache = new EntryProjectionCache();
  const entries = buildHistory(10);
  cache.project(entries);
  const truncated = entries.slice(0, entries.length - 5);
  assert.deepEqual(cache.project(truncated), entriesToCoreMessages(truncated));
});

test("in-place last-entry rewrite (canary mismatch) falls back to full projection", () => {
  const cache = new EntryProjectionCache();
  const entries = buildHistory(10);
  cache.project(entries);
  // Same count, but the last entry's id changed — as if a host rewrote the tail
  // without truncating (defensive: count checks alone cannot see this).
  const rewritten = [...entries.slice(0, -1), msgEntry(`u-${seq++}`, userMsg("rewritten"))];
  assert.deepEqual(cache.project(rewritten), entriesToCoreMessages(rewritten));
});

test("append burst over the cap falls back to full projection", () => {
  const cache = new EntryProjectionCache();
  const entries = buildHistory(5);
  cache.project(entries);
  const burst = [...entries, ...buildHistory(50)]; // 50 > MAX_INCREMENTAL_ENTRIES (64)? no — under: force over instead
  cache.project(burst);
  const huge = [...burst, ...buildHistory(40)]; // > 64 new entries in one turn
  assert.deepEqual(cache.project(huge), entriesToCoreMessages(huge));
});

test("equal-length replay (no new entries) reuses the cache and stays correct", () => {
  const cache = new EntryProjectionCache();
  const entries = buildHistory(6);
  cache.project(entries);
  const again = [...entries]; // fresh array, same ids
  assert.deepEqual(cache.project(again), entriesToCoreMessages(again));
});

test("returned arrays are defensive copies — caller mutation cannot corrupt the cache", () => {
  const cache = new EntryProjectionCache();
  const entries = buildHistory(6);
  const first = cache.project(entries);
  first.pop();
  first.reverse();
  const grown = [...entries, ...buildHistory(1)];
  assert.deepEqual(cache.project(grown), entriesToCoreMessages(grown));
});

test("reset() drops the cache", () => {
  const cache = new EntryProjectionCache();
  const entries = buildHistory(4);
  cache.project(entries);
  cache.reset();
  const grown = [...entries, ...buildHistory(1)];
  assert.deepEqual(cache.project(grown), entriesToCoreMessages(grown));
});
