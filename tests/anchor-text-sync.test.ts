import { test } from "node:test";
import assert from "node:assert/strict";
import { coreOutToAgentMessages } from "../src/messages.js";
import type { CoreMessage } from "acp-kernel";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

const LT = "\x3c";
const GT = "\x3e";
function acpRef(ref: string, tokens = "2", type = "text"): string {
  return LT + 'acp tokens="' + tokens + '" type="' + type + '"' + GT + ref + LT + "/acp" + GT;
}

function msgEntry(id: string, message: object): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: message as SessionMessageEntry["message"],
  };
}

function assistantMeta(): Record<string, unknown> {
  return {
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

const LONG_SUMMARY = "S".repeat(600);
const STUB_SUMMARY = "S".repeat(200) + "\u2026";

function compressArgs(): { content: unknown[] } {
  return {
    content: [
      { startId: "m00001", endId: "m00009", summary: LONG_SUMMARY },
      { startId: "m00020", endId: "m00022", summary: "dead range, block distilled away" },
    ],
  };
}

function kernelStubbedText(): string {
  return JSON.stringify({
    content: [{ startId: "m00001", endId: "m00009", summary: STUB_SUMMARY }],
  });
}

function callsOf(out: unknown): Array<{ type: string; id: string; name: string; arguments: unknown }> {
  const m = out as { content: Array<{ type: string; id: string; name: string; arguments: unknown }> };
  return m.content.filter((b) => b.type === "toolCall");
}

test("single-call compress anchor: kernel-stubbed text syncs into outbound arguments", () => {
  const original = msgEntry("a", {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "compress", arguments: compressArgs() }],
    ...assistantMeta(),
  }).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [
    { id: "a", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "tc1", text: kernelStubbedText() },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const call = callsOf(out[0])[0]!;
  const content = (call.arguments as { content: unknown[] }).content;
  assert.equal(content.length, 1, "dead range entry dropped");
  assert.equal((content[0] as { summary: string }).summary, STUB_SUMMARY, "stubbed summary synced");
  assert.ok(!JSON.stringify(call.arguments).includes("dead range"), "no dead-range residue");
});

test("string-form content (non-strict providers) is preserved and stubbed through sync", () => {
  const stringArgs = { content: JSON.stringify(compressArgs().content) };
  const original = msgEntry("a", {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "compress", arguments: stringArgs }],
    ...assistantMeta(),
  }).message;
  const originalById = new Map([["a", original]]);
  const kernelText = JSON.stringify({ content: JSON.stringify([{ startId: "m00001", endId: "m00009", summary: STUB_SUMMARY }]) });
  const coreOut: CoreMessage[] = [
    { id: "a", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "tc1", text: kernelText },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const args = callsOf(out[0])[0]!.arguments as { content: string };
  assert.equal(typeof args.content, "string", "string shape preserved");
  const inner = JSON.parse(args.content) as Array<{ summary: string }>;
  assert.equal(inner.length, 1);
  assert.equal(inner[0]!.summary, STUB_SUMMARY);
});

test("multi-call message: per-call sync via sub-id cores, untouched call keeps original args", () => {
  const bashArgs = { command: "ls" };
  const original = msgEntry("a", {
    role: "assistant",
    content: [
      { type: "text", text: "Running tools" },
      { type: "toolCall", id: "tcC", name: "compress", arguments: compressArgs() },
      { type: "toolCall", id: "tcB", name: "bash", arguments: bashArgs },
    ],
    ...assistantMeta(),
  }).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [
    { id: "a#tcC", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "tcC", text: kernelStubbedText() },
    { id: "a#tcB", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "tcB", text: JSON.stringify(bashArgs) },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const calls = callsOf(out[0]);
  assert.equal(calls.length, 2);
  const compress = calls.find((c) => c.name === "compress")!;
  const bash = calls.find((c) => c.name === "bash")!;
  assert.equal((compress.arguments as { content: unknown[] }).content.length, 1, "compress stubbed");
  assert.deepEqual(bash.arguments, bashArgs, "bash untouched");
});

test("no kernel diff: arguments object passes through unchanged (same reference)", () => {
  const args = compressArgs();
  const original = msgEntry("a", {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "compress", arguments: args }],
    ...assistantMeta(),
  }).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [
    { id: "a", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "tc1", text: JSON.stringify(args) },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(callsOf(out[0])[0]!.arguments, args, "identity preserved when kernel did not rewrite");
});

test("unparseable kernel text keeps original arguments", () => {
  const args = compressArgs();
  const original = msgEntry("a", {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "compress", arguments: args }],
    ...assistantMeta(),
  }).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [
    { id: "a", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "tc1", text: "no json here" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(callsOf(out[0])[0]!.arguments, args, "fail-safe: original args kept");
});

test("tag-prefixed kernel text still syncs (first-{ scan, prefix dropped from arguments)", () => {
  const original = msgEntry("a", {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "compress", arguments: compressArgs() }],
    ...assistantMeta(),
  }).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [
    { id: "a", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "tc1", text: acpRef("m00009") + "\n" + kernelStubbedText() },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const call = callsOf(out[0])[0]!;
  const content = (call.arguments as { content: unknown[] }).content;
  assert.equal(content.length, 1, "JSON after tag prefix synced");
  assert.equal((content[0] as { summary: string }).summary, STUB_SUMMARY);
});

test("tool-result cores must not overwrite call-args in multi-call reconstruction (#440)", () => {
  const bashArgs = { command: "ls -la" };
  const grepArgs = { pattern: "foo" };
  const original = msgEntry("a", {
    role: "assistant",
    content: [
      { type: "text", text: "Running tools" },
      { type: "toolCall", id: "tcA", name: "bash", arguments: bashArgs },
      { type: "toolCall", id: "tcB", name: "grep", arguments: grepArgs },
    ],
    ...assistantMeta(),
  }).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [
    { id: "a#tcA", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "tcA", text: JSON.stringify(bashArgs) },
    { id: "a#tcB", role: "assistant", contentType: "tool-call", toolName: "grep", toolCallId: "tcB", text: JSON.stringify(grepArgs) },
    // Tool-results share the same toolCallIds and carry JSON-object outputs.
    { id: "rA", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tcA", text: JSON.stringify({ total: 5, files: ["a.txt"] }) },
    { id: "rB", role: "tool", contentType: "tool-result", toolName: "grep", toolCallId: "tcB", text: JSON.stringify({ matches: ["line42: foo"] }) },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const calls = callsOf(out[0]);
  const bash = calls.find((c) => c.name === "bash")!;
  const grep = calls.find((c) => c.name === "grep")!;
  assert.deepEqual(bash.arguments, bashArgs, "bash args must not be replaced by its result output");
  assert.deepEqual(grep.arguments, grepArgs, "grep args must not be replaced by its result output");
});
