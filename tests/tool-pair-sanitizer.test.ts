import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { sanitizeToolPairing } from "../src/tool-pair-sanitizer.js";

type AgentMessage = SessionMessageEntry["message"];

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function assistant(parts: unknown[]): AgentMessage {
  return { role: "assistant", content: parts, timestamp: 0 } as unknown as AgentMessage;
}

function textAssistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function strAssistant(text: string): AgentMessage {
  return { role: "assistant", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function call(id: string, name = "bash"): { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
  return { type: "toolCall", id, name, arguments: {} };
}

function toolResult(toolCallId: string): AgentMessage {
  return { role: "toolResult", toolName: "bash", toolCallId, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 } as unknown as AgentMessage;
}

function roles(msgs: AgentMessage[]): string[] {
  return msgs.map((m) => (m as { role?: string }).role ?? "?");
}

test("well-formed stream passes through byte-for-byte (same reference, nothing dropped)", () => {
  const input = [user("go"), assistant([call("c1")]), toolResult("c1")];
  const out = sanitizeToolPairing(input);
  assert.equal(out.messages, input, "unchanged input must keep its reference (prefix-cache stable)");
  assert.deepEqual(out.droppedResults, []);
});

test("orphan toolResult (no matching visible toolCall) is dropped", () => {
  const input = [user("go"), textAssistant("thinking..."), toolResult("ghost")];
  const out = sanitizeToolPairing(input);
  assert.deepEqual(roles(out.messages), ["user", "assistant"]);
  assert.deepEqual(out.droppedResults, ["ghost"]);
  assert.notEqual(out.messages, input, "a change must produce a new array");
});

test("only the orphan half is dropped; well-formed pairs stay in order", () => {
  const input = [
    user("go"),
    assistant([call("a")]), toolResult("a"),
    assistant([call("b")]), toolResult("b"),
    toolResult("ghost"),
  ];
  const out = sanitizeToolPairing(input);
  assert.deepEqual(roles(out.messages), ["user", "assistant", "toolResult", "assistant", "toolResult"]);
  assert.deepEqual((out.messages[2] as { toolCallId: string }).toolCallId, "a");
  assert.deepEqual((out.messages[4] as { toolCallId: string }).toolCallId, "b");
  assert.deepEqual(out.droppedResults, ["ghost"]);
});

test("orphan toolCall (in-flight, no result yet) is left untouched — one-directional invariant", () => {
  const input = [user("go"), assistant([call("pending")])];
  const out = sanitizeToolPairing(input);
  assert.equal(out.messages, input, "an in-flight call with no result must never be dropped");
  assert.deepEqual(out.droppedResults, []);
});

test("multi-call assistant message keeps its surviving calls when a sibling result is orphaned elsewhere", () => {
  const input = [user("go"), assistant([call("x"), call("y")]), toolResult("x"), toolResult("y"), toolResult("z")];
  const out = sanitizeToolPairing(input);
  assert.deepEqual(roles(out.messages), ["user", "assistant", "toolResult", "toolResult"]);
  assert.deepEqual((out.messages[1] as { content: Array<{ id?: string }> }).content.map((b) => b.id), ["x", "y"]);
  assert.deepEqual(out.droppedResults, ["z"]);
});

test("out-of-order pair still matches (global id set), so no false drop", () => {
  const input = [user("go"), toolResult("z"), assistant([call("z")])];
  const out = sanitizeToolPairing(input);
  assert.equal(out.messages, input);
  assert.deepEqual(out.droppedResults, []);
});

test("string-content assistant is untouched; an orphan result with no calls anywhere is dropped", () => {
  const input = [user("go"), strAssistant("hi there"), toolResult("nowhere")];
  const out = sanitizeToolPairing(input);
  assert.deepEqual(roles(out.messages), ["user", "assistant"]);
  assert.deepEqual((out.messages[1] as { content: unknown }).content, "hi there");
  assert.deepEqual(out.droppedResults, ["nowhere"]);
});

test("multiple orphan results are all dropped, listed in stream order", () => {
  const input = [user("go"), assistant([call("a")]), toolResult("a"), toolResult("g1"), toolResult("g2")];
  const out = sanitizeToolPairing(input);
  assert.deepEqual(roles(out.messages), ["user", "assistant", "toolResult"]);
  assert.deepEqual(out.droppedResults, ["g1", "g2"]);
});

test("empty input returns unchanged", () => {
  const input: AgentMessage[] = [];
  const out = sanitizeToolPairing(input);
  assert.equal(out.messages, input);
  assert.deepEqual(out.droppedResults, []);
});

test("idempotent: a second pass over cleaned output is a no-op (same reference)", () => {
  const dirty = [user("go"), assistant([call("a")]), toolResult("a"), toolResult("ghost")];
  const once = sanitizeToolPairing(dirty);
  const twice = sanitizeToolPairing(once.messages);
  assert.equal(twice.messages, once.messages, "already-cleaned stream must keep its reference");
  assert.deepEqual(twice.droppedResults, []);
});

function bareToolResult(toolCallId?: unknown): AgentMessage {
  const m: Record<string, unknown> = { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x" }], isError: false, timestamp: 0 };
  if (toolCallId !== undefined) m.toolCallId = toolCallId;
  return m as unknown as AgentMessage;
}

test("toolResult with no toolCallId field is dropped (invalid upstream on its own)", () => {
  const input = [user("go"), bareToolResult()];
  const out = sanitizeToolPairing(input);
  assert.deepEqual(roles(out.messages), ["user"]);
  assert.deepEqual(out.droppedResults, ["(missing toolCallId)"]);
});

test("non-string / empty toolCallId is dropped while a valid pair survives", () => {
  const input = [user("go"), assistant([call("a")]), toolResult("a"), bareToolResult(42), bareToolResult("")];
  const out = sanitizeToolPairing(input);
  assert.deepEqual(roles(out.messages), ["user", "assistant", "toolResult"]);
  assert.deepEqual((out.messages[2] as { toolCallId: string }).toolCallId, "a");
  assert.deepEqual(out.droppedResults, ["(missing toolCallId)", "(missing toolCallId)"]);
});
