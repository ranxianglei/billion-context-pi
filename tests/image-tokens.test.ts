import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { estimateTokens, collectImageTokens, modelSupportsImages, IMAGE_TOKEN_COST } from "../src/tokens.js";
import { countImageBlocks } from "../src/messages.js";

// Image blocks were invisible to the sent-view estimate (extractText drops
// them), so usage under-counted image-heavy sessions and density calibration
// chased a phantom gap (real includes image tokens, estimate did not).
// dog/billion-context-pi#200.

const STATE_FILE = "/tmp/pai-acp-image-tokens-it.session.json";

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

// pi's injected nudge text: "⚠️ Context limit reached — compress now. …"
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
      getSessionId: () => "image-tokens-session",
      getSessionFile: () => STATE_FILE,
    },
  };
}

const imgEntry = (id: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "",
  message: { role: "user", content: [{ type: "image", data: `payload-${id}`, mimeType: "image/png" }], timestamp: Date.now() },
});

const textEntry = (id: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "",
  message: { role: "user", content: text, timestamp: Date.now() },
});

test("countImageBlocks counts only image blocks", () => {
  assert.equal(countImageBlocks([{ type: "text", text: "hi" }, { type: "image", data: "a", mimeType: "image/png" }]), 1);
  assert.equal(countImageBlocks([{ type: "image", data: "a", mimeType: "image/png" }, { type: "image", data: "b", mimeType: "image/jpeg" }]), 2);
  assert.equal(countImageBlocks("plain string"), 0);
  assert.equal(countImageBlocks(undefined), 0);
});

test("modelSupportsImages reads the model input capability", () => {
  assert.equal(modelSupportsImages({ input: ["text", "image"] }), true);
  assert.equal(modelSupportsImages({ input: ["text"] }), false);
  assert.equal(modelSupportsImages({}), false);
  assert.equal(modelSupportsImages(undefined), false);
});

test("collectImageTokens maps entry ids to per-image cost", () => {
  const entries = [
    { id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "x", mimeType: "image/png" }] } },
    { id: "e2", type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "image", data: "y", mimeType: "image/png" }] } },
    { id: "e3", type: "message", message: { role: "user", content: "no images" } },
    { id: "e4", type: "model_change" },
  ];
  const map = collectImageTokens(entries, true);
  assert.equal(map.get("e1"), IMAGE_TOKEN_COST);
  assert.equal(map.get("e2"), IMAGE_TOKEN_COST);
  assert.ok(!map.has("e3"));
  assert.ok(!map.has("e4"));
});

test("collectImageTokens is empty for non-vision models", () => {
  const entries = [imgEntry("e1")];
  assert.equal(collectImageTokens(entries, false).size, 0);
});

test("estimateTokens adds image tokens and skips covered ids", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "" },
    { id: "m2", role: "user", contentType: "text", text: "alpha beta gamma" },
  ];
  const imageTokens = new Map([["m1", IMAGE_TOKEN_COST]]);
  assert.equal(estimateTokens(msgs, undefined, imageTokens), IMAGE_TOKEN_COST + 4);
  assert.equal(estimateTokens(msgs, new Set(["m1"]), imageTokens), 4);
});

const lastTurnLine = async (logFile: string) => {
  const lines = (await readFile(logFile, "utf8")).split("\n").filter((l) => l.includes("[turn]"));
  return lines[lines.length - 1] ?? "";
};

test("sent-view token count includes image tokens (vision model)", async () => {
  const logFile = `${STATE_FILE}.vision.log`;
  await rm(logFile, { force: true });
  process.env.ACP_LOG_FILE = logFile;
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 10_000 })(api as any);
  const entries = Array.from({ length: 8 }, (_, i) => imgEntry(`e${i}`));
  const ctx = ctxWithModel(entries, 10_000, ["text", "image"]);
  await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  // 8 × 1600 = 12800 → 128% of the 10K window, despite empty visible text.
  assert.match(await lastTurnLine(logFile), /tokens=12800 pct=128 limit=10000/, "image tokens must land in the sent-view estimate");
  await rm(logFile, { force: true });
});

test("sent-view token count ignores images for non-vision models", async () => {
  const logFile = `${STATE_FILE}.novision.log`;
  await rm(logFile, { force: true });
  process.env.ACP_LOG_FILE = logFile;
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 10_000 })(api as any);
  const entries = Array.from({ length: 8 }, (_, i) => imgEntry(`e${i}`));
  const ctx = ctxWithModel(entries, 10_000, ["text"]);
  await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  // pi-ai silently drops image blocks for non-vision models — counting them
  // would fabricate 12.8K of phantom usage.
  const m = (await lastTurnLine(logFile)).match(/tokens=(\d+)/);
  assert.ok(m, "[turn] line present");
  assert.ok(Number(m[1]) < 1000, `non-vision model must not count image tokens, got ${m[1]}`);
  await rm(logFile, { force: true });
});

test("emergency nudge fires when images push the sent view past the window", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 10_000 })(api as any);
  const filler = "lorem ".repeat(300);
  const entries = [
    ...Array.from({ length: 30 }, (_, i) => ({
      type: "message",
      id: `f${i}`,
      parentId: null,
      timestamp: "",
      message: { role: i % 2 ? "assistant" : "user", content: `${i} ${filler}`, timestamp: Date.now() },
    })),
    ...Array.from({ length: 8 }, (_, i) => imgEntry(`e${i}`)),
  ];
  const ctx = ctxWithModel(entries, 10_000, ["text", "image"]);
  const r = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  // ~30 × 450 filler + 8 × 1600 images ≈ 26K vs 10K window; the older filler
  // sits outside the recent-protection window, so a compressible range exists.
  assert.ok(nudgeCount(r) >= 1, "filler + images must overflow the window and trip the nudge");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});

test("identical text-only session stays quiet (same window)", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 10_000 })(api as any);
  const entries = Array.from({ length: 8 }, (_, i) => textEntry(`e${i}`, "x"));
  const ctx = ctxWithModel(entries, 10_000, ["text", "image"]);
  const r = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  assert.equal(nudgeCount(r), 0, "eight one-char messages must not trip the nudge");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});

test("pi host: image-only user message survives the transform with its ref tag", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const entries = [imgEntry("e1")];
  const ctx = ctxWithModel(entries, 200_000, ["text", "image"]);
  const r = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  assert.ok(r, "handler must not throw on an image-only message");
  const content = r.messages[0].content;
  const imageBlocks = content.filter((b: { type?: string }) => b.type === "image");
  assert.equal(imageBlocks.length, 1, "the image block must survive");
  assert.equal(imageBlocks[0]!.data, "payload-e1");
  const textBlock = content.find((b: { type?: string }) => b.type === "text");
  assert.ok(textBlock, "a ref-tag text block must accompany the image");
  assert.match(textBlock.text, /m\d{5}/, "ref tag present on the image-only message");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});
