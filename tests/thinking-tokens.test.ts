import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { defaultCountTokens } from "acp-kernel";
import { createAcpExtension } from "../src/index.js";
import { estimateTokens } from "../src/tokens.js";
import { entriesToCoreMessages, thinkingTokenCount } from "../src/messages.js";

// Thinking blocks are resent with every request but were invisible to the
// projection (extractText collects text blocks only), so every ACP meter
// under-counted reasoning sessions by the cumulative thinking volume
// (billion-context-pi#353). Thinking now rides on CoreMessage.thinkingTokens,
// attached to exactly one core per assistant turn.

const STATE_FILE = "/tmp/pai-acp-thinking-tokens-it.session.json";

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

const nudgeCount = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached|compress/i.test(JSON.stringify(m.content))).length;

function ctxWithModel(entries: any[], limit: number, input: string[]) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: limit, input },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "thinking-tokens-session",
      getSessionFile: () => STATE_FILE,
    },
  };
}

const entry = (id: string, content: unknown): SessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "",
  message: { role: "assistant", content, timestamp: Date.now() },
}) as SessionEntry;

const thinkingContent = (chars: number, text = "ok") => [
  { type: "thinking", thinking: "t".repeat(chars) },
  { type: "text", text },
];

test("thinkingTokenCount counts only thinking blocks", () => {
  assert.equal(thinkingTokenCount([{ type: "text", text: "hi" }]), 0);
  assert.equal(thinkingTokenCount("plain string"), 0);
  assert.equal(thinkingTokenCount(undefined), 0);
  const t = "ab ".repeat(50);
  assert.equal(thinkingTokenCount([{ type: "thinking", thinking: t }, { type: "text", text: "x" }]), defaultCountTokens(t));
  const joined = "a".repeat(40) + "\n" + "b".repeat(40);
  assert.equal(thinkingTokenCount([{ type: "thinking", thinking: "a".repeat(40) }, { type: "thinking", thinking: "b".repeat(40) }]), defaultCountTokens(joined));
});

test("entriesToCoreMessages attaches thinkingTokens to exactly one core per turn", () => {
  const expected = defaultCountTokens("t".repeat(100));
  const textTurn = entriesToCoreMessages([entry("a1", thinkingContent(100))] as SessionEntry[]);
  assert.deepEqual(textTurn.map((c) => c.thinkingTokens), [expected]);

  const singleCall = entry("a2", [
    { type: "thinking", thinking: "t".repeat(100) },
    { type: "text", text: "working" },
    { type: "toolCall", name: "read", id: "c1", arguments: { path: "/x" } },
  ]);
  const cores2 = entriesToCoreMessages([singleCall] as SessionEntry[]);
  assert.equal(cores2.length, 1);
  assert.equal(cores2[0]!.id, "a2");
  assert.equal(cores2[0]!.thinkingTokens, expected);

  const multiCall = entry("a3", [
    { type: "thinking", thinking: "t".repeat(100) },
    { type: "toolCall", name: "read", id: "c1", arguments: {} },
    { type: "toolCall", name: "write", id: "c2", arguments: {} },
  ]);
  const cores3 = entriesToCoreMessages([multiCall] as SessionEntry[]);
  assert.deepEqual(cores3.map((c) => c.id), ["a3#c1", "a3#c2"]);
  assert.deepEqual(cores3.map((c) => c.thinkingTokens), [expected, undefined], "split cores must not repeat the thinking volume");

  const plain = entriesToCoreMessages([entry("a4", [{ type: "text", text: "no thinking" }])] as SessionEntry[]);
  assert.equal(plain[0]!.thinkingTokens, undefined);
});

test("estimateTokens includes thinkingTokens and skips covered ids", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "alpha beta gamma" },
    { id: "m2", role: "assistant", contentType: "text", text: "", thinkingTokens: 777 },
  ];
  assert.equal(estimateTokens(msgs), 4 + 777);
  assert.equal(estimateTokens(msgs, new Set(["m2"])), 4);
});

const lastTurnLine = async (logFile: string) => {
  const lines = (await readFile(logFile, "utf8")).split("\n").filter((l) => l.includes("[turn]"));
  return lines[lines.length - 1] ?? "";
};

test("sent-view token count includes thinking tokens", async () => {
  const logFile = `${STATE_FILE}.think.log`;
  await rm(logFile, { force: true });
  process.env.ACP_LOG_FILE = logFile;
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 10_000 })(api as any);
  const entries = Array.from({ length: 8 }, (_, i) => entry(`e${i}`, thinkingContent(400)));
  const ctx = ctxWithModel(entries, 10_000, ["text"]);
  await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  // 8 × ceil(400/4) = 800 thinking tokens must land in the sent-view estimate
  // even though the visible text is eight tiny "ok" blocks.
  const m = (await lastTurnLine(logFile)).match(/tokens=(\d+)/);
  assert.ok(m, "[turn] line present");
  assert.ok(Number(m[1]) >= 800, `thinking tokens missing from the sent-view estimate, got ${m[1]}`);
  await rm(logFile, { force: true });
});

test("nudge fires when thinking pushes the sent view past the window", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 10_000 })(api as any);
  const filler = "lorem ".repeat(200);
  const entries = [
    ...Array.from({ length: 8 }, (_, i) => ({
      type: "message",
      id: `f${i}`,
      parentId: null,
      timestamp: "",
      message: { role: i % 2 ? "assistant" : "user", content: `${i} ${filler}`, timestamp: Date.now() },
    })),
    // Old thinking-heavy turns sit outside the recent-protection window, so
    // their (now-metered) volume is compressible pending for the benefit floor.
    ...Array.from({ length: 40 }, (_, i) => entry(`t${i}`, thinkingContent(800))),
    { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "continue", timestamp: Date.now() } },
    { type: "message", id: "a1", parentId: null, timestamp: "", message: { role: "assistant", content: "ok", timestamp: Date.now() } },
  ];
  const ctx = ctxWithModel(entries, 10_000, ["text"]);
  const r = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  // ~2.4K filler + 40 × 200 thinking ≈ 10.4K (104% of the 10K window); the
  // recent-5K-token protection leaves ≈ 5.4K compressible pending ≥ the 5K
  // min-benefit floor; without metered thinking the session reads ~24%.
  assert.ok(nudgeCount(r) >= 1, "metered thinking must push the session into the nudge band");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});

test("identical session without thinking stays quiet (control)", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 10_000 })(api as any);
  const filler = "lorem ".repeat(200);
  const entries = [
    ...Array.from({ length: 8 }, (_, i) => ({
      type: "message",
      id: `f${i}`,
      parentId: null,
      timestamp: "",
      message: { role: i % 2 ? "assistant" : "user", content: `${i} ${filler}`, timestamp: Date.now() },
    })),
    ...Array.from({ length: 40 }, (_, i) => ({
      type: "message",
      id: `t${i}`,
      parentId: null,
      timestamp: "",
      message: { role: "assistant", content: "ok", timestamp: Date.now() },
    })),
    { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "continue", timestamp: Date.now() } },
    { type: "message", id: "a1", parentId: null, timestamp: "", message: { role: "assistant", content: "ok", timestamp: Date.now() } },
  ];
  const ctx = ctxWithModel(entries, 10_000, ["text"]);
  const r = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  assert.equal(nudgeCount(r), 0, "~2.4K of filler at 24% of the window must stay quiet");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});
