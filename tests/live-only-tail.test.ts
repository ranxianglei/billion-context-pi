import { test } from "node:test";
import assert from "node:assert/strict";
import { liveOnlyTail } from "../src/live-only-tail.js";
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
// A persisted custom_message entry and its live-array counterpart, exactly as pi
// projects them (createCustomMessage -> role:"custom").
function customEntry(id: string, customType: string, text: string): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    content: [{ type: "text", text }],
    display: true,
  };
}
function customLive(customType: string, text: string): object {
  return { role: "custom", customType, content: [{ type: "text", text }], display: true, timestamp: Date.now() };
}

function textOf(m: Record<string, unknown>): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      const x = b as { text?: unknown };
      return typeof x.text === "string" ? x.text : "";
    }).join("\n");
  }
  return "";
}

test("aligned normal turn returns null (byte-for-byte unchanged)", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("hello")), msgEntry("b", assistant("hi there"))];
  const live = [user("hello"), assistant("hi there")];
  assert.equal(liveOnlyTail(entries, live), null);
});

test("identical arrays (live length == persisted length, fully aligned) return null", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("q1")), msgEntry("b", assistant("r1"))];
  const live = [user("q1"), assistant("r1")];
  assert.equal(liveOnlyTail(entries, live), null);
});

test("one appended trailing user message is returned", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("hello")), msgEntry("b", assistant("hi"))];
  const instr = user("Summarise this conversation in five words.");
  const live = [user("hello"), assistant("hi"), instr];
  const tail = liveOnlyTail(entries, live);
  assert.ok(tail);
  assert.equal(tail!.length, 1);
  assert.equal((tail![0] as Record<string, unknown>).role, "user");
  assert.equal(textOf(tail![0] as Record<string, unknown>), "Summarise this conversation in five words.");
});

test("two appended trailing messages are returned in order", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("first"))];
  const x = user("instruction one");
  const y = user("instruction two");
  const live = [user("first"), x, y];
  const tail = liveOnlyTail(entries, live);
  assert.ok(tail);
  assert.equal(tail!.length, 2);
  assert.equal(textOf(tail![0] as Record<string, unknown>), "instruction one");
  assert.equal(textOf(tail![1] as Record<string, unknown>), "instruction two");
});

test("tail longer than the cap is rejected (null)", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("seed"))];
  const live = [user("seed"), ...Array.from({ length: 9 }, (_, k) => user(`extra ${k}`))];
  assert.equal(liveOnlyTail(entries, live), null);
});

test("live shorter than persisted returns null", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("1")), msgEntry("b", user("2")), msgEntry("c", user("3"))];
  const live = [user("1"), user("2")];
  assert.equal(liveOnlyTail(entries, live), null);
});

test("middle divergence returns null", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("A")), msgEntry("b", user("B"))];
  const live = [user("A was rewritten"), user("B")];
  assert.equal(liveOnlyTail(entries, live), null);
});

test("suffix appended into the final user message returns only the added text", () => {
  const base = "Write a detailed report.";
  const suffix = "Generate a short title for this conversation.";
  const entries: SessionEntry[] = [msgEntry("a", user(base)), msgEntry("b", assistant("On it."))];
  // pi-web appends the instruction INTO the last user message; here that message
  // is followed by an assistant reply, so the modified user message is NOT last:
  // this path must therefore be rejected (only the trailing-last case applies).
  const midModified = [user(`${base}\n\n${suffix}`), assistant("On it.")];
  assert.equal(liveOnlyTail(entries, midModified), null);

  // When the final user message is genuinely the last element, recover the suffix.
  const entries2: SessionEntry[] = [msgEntry("c", user(base))];
  const live2 = [user(`${base}\n\n${suffix}`)];
  const tail = liveOnlyTail(entries2, live2);
  assert.ok(tail);
  assert.equal(tail!.length, 1);
  assert.equal((tail![0] as Record<string, unknown>).role, "user");
  assert.equal(textOf(tail![0] as Record<string, unknown>), suffix);
});

test("non-prefix text change on the final user message returns null", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("abc"))];
  const live = [user("xyz")];
  assert.equal(liveOnlyTail(entries, live), null);
});

test("final-message modification that is not a user message returns null", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("q")), msgEntry("b", assistant("done"))];
  const live = [user("q"), assistant("done and some extra")];
  assert.equal(liveOnlyTail(entries, live), null);
});

test("trap #1: a custom_message session stays aligned and still detects the appended tail", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("start the job")),
    customEntry("c", "background-task-notification", "job finished"),
    msgEntry("d", assistant("All done.")),
  ];
  const live = [
    user("start the job"),
    customLive("background-task-notification", "job finished"),
    assistant("All done."),
    user("Give this conversation a title."),
  ];
  const tail = liveOnlyTail(entries, live);
  assert.ok(tail);
  assert.equal(tail!.length, 1);
  assert.equal(textOf(tail![0] as Record<string, unknown>), "Give this conversation a title.");
});

test("empty live array returns null", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("hello"))];
  assert.equal(liveOnlyTail(entries, []), null);
});
