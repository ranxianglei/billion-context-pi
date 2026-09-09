import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { entriesToCoreMessages, coreOutToAgentMessages } from "../src/messages.ts";
import { resolveConfig } from "../src/config.ts";
import type { AgentMessage, SessionEntry } from "../src/types.ts";

const countTokens = (text: string) => Math.ceil(text.length / 4);

function msgEntry(id: string, message: object): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: message as AgentMessage,
  } as SessionEntry;
}

function userEntry(id: string, text: string): SessionEntry {
  return msgEntry(id, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

function thinkingAssistantEntry(id: string, thinking: string, text: string): SessionEntry {
  return msgEntry(id, {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
    timestamp: Date.now(),
  });
}

function rebuiltView(entries: SessionEntry[], reasoningReplay: "always" | "open-round" | "never") {
  const core = createCore({ countTokens });
  const config = { ...defaultConfig(262144, { limit: 212992 }), reasoningReplay };
  const turn = core.processTurn({
    messages: entriesToCoreMessages(entries),
    state: createInitialState(),
    config,
    tokenCount: 1000,
  });
  const byId = new Map(entries.map((e) => [e.id, (e as { message: AgentMessage }).message]));
  return coreOutToAgentMessages(turn.messages, byId);
}

function thinkingBlocksOf(message: AgentMessage | undefined): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; thinking?: string } => (b as { type?: string }).type === "thinking")
    .map((b) => b.thinking ?? "");
}

test("open-round strips closed-turn thinking but keeps the open round's", () => {
  const entries = [
    userEntry("u1", "first question"),
    thinkingAssistantEntry("a1", "stale reasoning about question one", "answer one"),
    userEntry("u2", "second question"),
    thinkingAssistantEntry("a2", "fresh reasoning about question two", "answer two"),
  ];
  const view = rebuiltView(entries, "open-round");
  const a1 = view.find((m) => (m as { id?: string }).id === undefined && JSON.stringify((m as { content?: unknown }).content).includes("answer one"));
  const a2 = view.find((m) => JSON.stringify((m as { content?: unknown }).content).includes("answer two"));
  assert.deepEqual(thinkingBlocksOf(a1), [], "closed-turn thinking stripped from rebuilt view");
  assert.deepEqual(thinkingBlocksOf(a2), ["fresh reasoning about question two"], "open-round thinking kept");
});

test("always keeps every thinking block in the rebuilt view", () => {
  const entries = [
    userEntry("u1", "q"),
    thinkingAssistantEntry("a1", "keep me", "answer"),
  ];
  const view = rebuiltView(entries, "always");
  assert.deepEqual(thinkingBlocksOf(view[1]), ["keep me"]);
});

test("never strips thinking from the open round too", () => {
  const entries = [
    userEntry("u1", "q"),
    thinkingAssistantEntry("a1", "drop me", "answer"),
  ];
  const view = rebuiltView(entries, "never");
  assert.deepEqual(thinkingBlocksOf(view[1]), []);
});

test("reasoning core text is never inlined into the rebuilt text block", () => {
  const entries = [
    userEntry("u1", "q"),
    thinkingAssistantEntry("a1", "secret chain", "answer"),
  ];
  const view = rebuiltView(entries, "always");
  const texts = JSON.stringify(view.map((m) => (m as { content?: unknown }).content));
  assert.ok(texts.includes("answer"));
  assert.ok(texts.includes("secret chain"));
  const a1 = view[1] as unknown as { content: { type: string; text?: string; thinking?: string }[] };
  const textBlock = a1.content.find((b) => b.type === "text");
  assert.equal(textBlock?.text, "answer");
});

test("resolveConfig defaults reasoningReplay to open-round and honors overrides", () => {
  const def = resolveConfig({}, 262144);
  assert.equal(def.reasoningReplay, "open-round");
  const off = resolveConfig({ reasoningReplay: "always" }, 262144);
  assert.equal(off.reasoningReplay, "always");
  const viaCore = resolveConfig({ coreOverrides: { reasoningReplay: "never" } }, 262144);
  assert.equal(viaCore.reasoningReplay, "never");
});
