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

// SDK ≥1.x context_edit entry (absent from the pinned 0.83.0 types → cast).
function editEntry(id: string, targetId: string, replacement: { content: unknown } | null): SessionEntry {
  return { type: "context_edit", id, parentId: null, timestamp: new Date().toISOString(), targetId, replacement } as SessionEntry;
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
  const grown = [...entries, ...buildHistory(1)];
  assert.deepEqual(cache.project(grown), entriesToCoreMessages(grown));
});

test("appended context_edit targeting the cached prefix invalidates and re-projects (#662)", () => {
  const cache = new EntryProjectionCache();
  const hiddenId = `hidden-${seq++}`;
  let entries: SessionEntry[] = [boundary(), customEntry(hiddenId, "assistant_partial", "#")];

  // Turn 1: the hidden entry is cached with its initial content.
  assert.deepEqual(cache.project(entries), entriesToCoreMessages(entries));
  assert.equal(cache.project(entries)[0]?.text, "#");

  // Turn 2: Pidian grows the hidden response in place via an appended edit.
  // The count/canary checks cannot see this — the cache must invalidate itself.
  entries = [...entries, editEntry(`e-${seq++}`, hiddenId, { content: "#Hel" })];
  assert.deepEqual(cache.project(entries), entriesToCoreMessages(entries));
  assert.equal(cache.project(entries)[0]?.text, "#Hel");

  // Turn 3: another growth step plus a fresh user turn in the same batch.
  const full = "#The full partial response.";
  entries = [...entries, editEntry(`e-${seq++}`, hiddenId, { content: full }), boundary(), msgEntry(`u-${seq++}`, userMsg("next question"))];
  const projected = cache.project(entries);
  assert.deepEqual(projected, entriesToCoreMessages(entries));
  assert.equal(projected[0]?.text, full, "full partial response visible after # → growth sequence");
  assert.equal(projected[projected.length - 1]!.text, "next question");
});

test("incremental append applies an edit targeting a tail entry without invalidating the prefix", () => {
  const cache = new EntryProjectionCache();
  const hiddenId = `hidden-${seq++}`;
  let entries: SessionEntry[] = [boundary(), msgEntry(`u-${seq++}`, userMsg("q"))];
  cache.project(entries);

  // Target and edit arrive together in the new tail: no cached-prefix entry is
  // re-targeted, so the incremental path stays valid and still applies the edit.
  entries = [...entries, customEntry(hiddenId, "assistant_partial", ""), editEntry(`e-${seq++}`, hiddenId, { content: "grown" })];
  const projected = cache.project(entries);
  assert.deepEqual(projected, entriesToCoreMessages(entries));
  assert.equal(projected[1]?.text, "grown", "tail-targeting edit applied on the incremental path");
});

test("edit preceding its target (position-independent resolution) applies when the target lands in the tail", () => {
  const cache = new EntryProjectionCache();
  const targetId = `t-${seq++}`;
  let entries: SessionEntry[] = [boundary(), msgEntry(`u-${seq++}`, userMsg("q"))];
  cache.project(entries);

  // The edit was appended while its target was not yet persisted; the host now
  // replays both. The SDK resolves edits position-independently — the cached
  // (inert) edit must govern the new tail entry.
  entries = [...entries, customEntry(targetId, "assistant_partial", "original"), editEntry(`e-${seq++}`, targetId, { content: "edited" })];
  // Reorder so the edit precedes its target, as a replay might deliver it.
  entries = [entries[0]!, entries[1]!, entries[3]!, entries[2]!];
  const projected = cache.project(entries);
  assert.deepEqual(projected, entriesToCoreMessages(entries));
  assert.equal(projected[1]?.text, "edited");
});
