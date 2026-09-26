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
function assistant(text: string, toolCallId?: string): object {
  return toolCallId ? { role: "assistant", content: text, toolCallId, timestamp: Date.now() } : { role: "assistant", content: text, timestamp: Date.now() };
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

test("aligned normal turn returns null tail AND null miss (silent happy path)", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("hello")), msgEntry("b", assistant("hi there"))];
  const live = [user("hello"), assistant("hi there")];
  const r = liveOnlyTail(entries, live);
  assert.equal(r.tail, null);
  assert.equal(r.miss, null);
});

test("identical arrays (fully aligned) return null tail AND null miss", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("q1")), msgEntry("b", assistant("r1"))];
  const live = [user("q1"), assistant("r1")];
  const r = liveOnlyTail(entries, live);
  assert.equal(r.tail, null);
  assert.equal(r.miss, null);
});

test("one appended trailing user message is returned, no miss", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("hello")), msgEntry("b", assistant("hi"))];
  const live = [user("hello"), assistant("hi"), user("Summarise this conversation in five words.")];
  const r = liveOnlyTail(entries, live);
  assert.ok(r.tail);
  assert.equal(r.miss, null);
  assert.equal(r.tail!.length, 1);
  assert.equal((r.tail![0] as Record<string, unknown>).role, "user");
  assert.equal(textOf(r.tail![0] as Record<string, unknown>), "Summarise this conversation in five words.");
});

test("two appended trailing messages are returned in order, no miss", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("first"))];
  const live = [user("first"), user("instruction one"), user("instruction two")];
  const r = liveOnlyTail(entries, live);
  assert.ok(r.tail);
  assert.equal(r.miss, null);
  assert.equal(r.tail!.length, 2);
  assert.equal(textOf(r.tail![0] as Record<string, unknown>), "instruction one");
  assert.equal(textOf(r.tail![1] as Record<string, unknown>), "instruction two");
});

test("tail longer than the cap returns null tail with a populated miss (over-cap)", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("seed"))];
  const live = [user("seed"), ...Array.from({ length: 9 }, (_, k) => user(`extra ${k}`))];
  const r = liveOnlyTail(entries, live);
  assert.equal(r.tail, null);
  assert.ok(r.miss);
  assert.equal(r.miss!.prefix, 1);
  assert.equal(r.miss!.gapLive, 9);
  assert.equal(r.miss!.gapPersisted, 0);
  assert.equal(r.miss!.atRole, "user");
  assert.equal(r.miss!.sameSig, false);
});

test("live shorter than persisted (clean prefix) returns null tail AND null miss (silent, no non-Pi spam)", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("1")), msgEntry("b", user("2")), msgEntry("c", user("3"))];
  const live = [user("1"), user("2")];
  const r = liveOnlyTail(entries, live);
  assert.equal(r.tail, null);
  assert.equal(r.miss, null);
});

test("middle divergence returns null tail with a populated miss describing WHERE/WHY", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("A")), msgEntry("b", user("B"))];
  const live = [user("A was rewritten"), user("B")];
  const r = liveOnlyTail(entries, live);
  assert.equal(r.tail, null);
  assert.ok(r.miss);
  assert.equal(r.miss!.prefix, 0);
  assert.equal(r.miss!.suffix, 1);
  assert.equal(r.miss!.gapPersisted, 1);
  assert.equal(r.miss!.gapLive, 1);
  assert.equal(r.miss!.atRole, "user");
  assert.equal(r.miss!.sameSig, false);
  assert.match(r.miss!.text ?? "", /start=true/);
});

// Mirrors the reporter's real sample (#471 floor 5): alignment breaks on toolCallId
// presence alone at a middle assistant message, live is shorter, texts are equal.
test("toolCallId-only divergence (reporter sample shape) -> miss with atTool set, text null", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("q")),
    msgEntry("b", assistant("thinking", "ccall_00_5nQG4z1AVJxKp9Qm2L")),
    msgEntry("c", user("next")),
    msgEntry("d", user("end")),
  ];
  const live = [user("q"), assistant("thinking")];
  const r = liveOnlyTail(entries, live);
  assert.equal(r.tail, null);
  assert.ok(r.miss);
  assert.equal(r.miss!.prefix, 1);
  assert.equal(r.miss!.atRole, "assistant");
  assert.equal(r.miss!.sameSig, false);
  assert.ok(r.miss!.atTool.startsWith("ccall_00"));
  assert.equal(r.miss!.text, null);
  assert.equal(r.miss!.gapPersisted, 3);
  assert.equal(r.miss!.gapLive, 1);
});

test("suffix appended into a non-final user message returns null tail with a miss", () => {
  const base = "Write a detailed report.";
  const suffix = "Generate a short title for this conversation.";
  const entries: SessionEntry[] = [msgEntry("a", user(base)), msgEntry("b", assistant("On it."))];
  // The modified user message is followed by an assistant reply, so it is NOT the
  // trailing-last element: only the trailing-last suffix case applies, reject here.
  const live = [user(`${base}\n\n${suffix}`), assistant("On it.")];
  const r = liveOnlyTail(entries, live);
  assert.equal(r.tail, null);
  assert.ok(r.miss);
});

test("suffix appended into the final user message returns only the added text, no miss", () => {
  const base = "Write a detailed report.";
  const suffix = "Generate a short title for this conversation.";
  const entries: SessionEntry[] = [msgEntry("c", user(base))];
  const live = [user(`${base}\n\n${suffix}`)];
  const r = liveOnlyTail(entries, live);
  assert.ok(r.tail);
  assert.equal(r.miss, null);
  assert.equal(r.tail!.length, 1);
  assert.equal((r.tail![0] as Record<string, unknown>).role, "user");
  assert.equal(textOf(r.tail![0] as Record<string, unknown>), suffix);
});

test("non-prefix text change on the final user message returns null tail with a miss", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("abc"))];
  const live = [user("xyz")];
  const r = liveOnlyTail(entries, live);
  assert.equal(r.tail, null);
  assert.ok(r.miss);
  assert.equal(r.miss!.sameSig, false);
  assert.match(r.miss!.text ?? "", /start=false/);
});

test("final-message modification that is not a user message returns null tail with a miss", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("q")), msgEntry("b", assistant("done"))];
  const live = [user("q"), assistant("done and some extra")];
  const r = liveOnlyTail(entries, live);
  assert.equal(r.tail, null);
  assert.ok(r.miss);
  assert.equal(r.miss!.prefix, 1);
  assert.equal(r.miss!.atRole, "assistant");
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
  const r = liveOnlyTail(entries, live);
  assert.ok(r.tail);
  assert.equal(r.miss, null);
  assert.equal(r.tail!.length, 1);
  assert.equal(textOf(r.tail![0] as Record<string, unknown>), "Give this conversation a title.");
});

test("empty live array returns null tail AND null miss", () => {
  const entries: SessionEntry[] = [msgEntry("a", user("hello"))];
  const r = liveOnlyTail(entries, []);
  assert.equal(r.tail, null);
  assert.equal(r.miss, null);
});
