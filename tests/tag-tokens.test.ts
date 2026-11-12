import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatTokens,
  stableTagTokens,
  rewriteTagTokens,
} from "../src/tag-tokens.js";
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

function user(text: string): object {
  return { role: "user", content: text, timestamp: Date.now() };
}

function collectOriginals(entries: SessionEntry[]): Map<string, SessionMessageEntry["message"]> {
  const originalById = new Map<string, SessionMessageEntry["message"]>();
  for (const entry of entries) {
    if (entry.type === "message") originalById.set(entry.id, entry.message);
  }
  return originalById;
}

function simulateTurn(entries: SessionEntry[], coreOut: CoreMessage[]): SessionMessageEntry["message"][] {
  return coreOutToAgentMessages(coreOut, collectOriginals(entries));
}

function textOf(msg: SessionMessageEntry["message"]): string {
  const m = msg as { content?: unknown };
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((b) => {
        const block = b as { type?: string; text?: string };
        return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
      })
      .join("\n");
  }
  return "";
}

test("formatTokens mirrors kernel formatting rules", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0K");
  assert.equal(formatTokens(2500), "2.5K");
  assert.equal(formatTokens(9999), "10.0K");
  assert.equal(formatTokens(10000), "10K");
  assert.equal(formatTokens(12345), "12K");
});

test("stableTagTokens equals raw defaultCountTokens formatting", () => {
  assert.equal(stableTagTokens(""), "0");
  assert.equal(stableTagTokens("hello world foo bar baz"), "6");
  assert.equal(stableTagTokens("这是一个中文测试"), "8");
  assert.equal(stableTagTokens("hello世界"), "4");
});

test("rewriteTagTokens replaces tokens= but preserves ref and type", () => {
  const tag = acpRef("m00042", "5.0K", "bash");
  const body = "hello world foo bar baz";
  const out = rewriteTagTokens(tag, body);
  assert.equal(out, acpRef("m00042", "6", "bash"));
});

test("tag tokens in output are raw-counted (stale tag values are rewritten)", () => {
  const body = "a".repeat(1000);
  const entries: SessionEntry[] = [msgEntry("mid", user(body))];
  const coreOut: CoreMessage[] = [
    { id: "mid", role: "user", contentType: "text", text: `${acpRef("m00001", "2.5K")}\n${body}` },
  ];
  const out = simulateTurn(entries, coreOut);
  const text = textOf(out[0]);
  assert.ok(text.includes(acpRef("m00001", "250")), `expected raw 250 tag, got: ${text.slice(-60)}`);
  assert.ok(!text.includes('tokens="2.5K"'), "stale tag value must not reach the model");
});

test("tag token value is deterministic across re-renders with different stale tag values", () => {
  const body = "这是一个测试。a".repeat(8);
  const entries: SessionEntry[] = [msgEntry("mid", user(body))];
  const render = (staleTag: string): string => {
    const coreOut: CoreMessage[] = [
      { id: "mid", role: "user", contentType: "text", text: `${acpRef("m00001", staleTag)}\n${body}` },
    ];
    const out = simulateTurn(entries, coreOut);
    return textOf(out[0]);
  };
  const atTag1 = render("1.0K");
  const atTag25 = render("2.5K");
  assert.equal(atTag1, atTag25, "rendered bytes must not depend on the stale tag value");
});

test("rebuild path (truncated core body) tags the kernel body with raw tokens", () => {
  const originalBody = "original body that will be replaced";
  const coreBody = "x".repeat(800);
  const entries: SessionEntry[] = [msgEntry("mid", user(originalBody))];
  const coreOut: CoreMessage[] = [
    { id: "mid", role: "user", contentType: "text", text: `${acpRef("m00001", "2.5K")}\n${coreBody}` },
  ];
  const out = simulateTurn(entries, coreOut);
  const text = textOf(out[0]);
  assert.ok(text.startsWith(coreBody), "kernel body must win over the original");
  assert.ok(text.trimEnd().endsWith(acpRef("m00001", "200")), `expected raw 200 tag at end, got: ${text.slice(-60)}`);
});

test("tool-result tags keep their type while tokens become raw", () => {
  const body = "a".repeat(400);
  const toolMsg = {
    role: "toolResult",
    toolName: "bash",
    toolCallId: "call1",
    content: body,
    timestamp: Date.now(),
  };
  const entries: SessionEntry[] = [msgEntry("mid", toolMsg)];
  const coreOut: CoreMessage[] = [
    { id: "mid", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "call1", text: `${acpRef("m00001", "2.0K", "bash")}\n${body}` },
  ];
  const out = simulateTurn(entries, coreOut);
  const content = (out[0] as { content: Array<{ type: string; text: string }> }).content;
  const texts = content.filter((b) => b.type === "text").map((b) => b.text);
  assert.ok(texts.some((t) => t.includes(acpRef("m00001", "100", "bash"))), "tool tag type preserved, tokens raw");
});