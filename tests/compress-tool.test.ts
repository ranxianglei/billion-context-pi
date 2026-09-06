import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

// ─── helpers (mirror decompress-tool.test.ts) ──────────────────────────────

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

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function fakeCtx(entries: any[], stateFile: string) {
  let usage: { tokens: number; percent: number } | null = null;
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => usage,
    __setUsage(t: number) { usage = { tokens: t, percent: t / 200_000 }; },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const ZH = "中".repeat(300);   // 300 CJK tokens
const ZH2 = "中".repeat(150);  // 150 CJK tokens

function beforeTokensFrom(out: string): number {
  // Panel renders ≥1000 compactly ("1.0K") — normalize to tokens.
  const m = /▣ ACP \| ([\d.]+)(K?) →/.exec(out);
  assert.ok(m, `no beforeTokens in output: ${out}`);
  const n = Number(m![1]!);
  return m![2] === "K" ? Math.round(n * 1000) : n;
}

async function runContextRound(handlers: Map<string, any[]>, ctx: any) {
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
}

// ─── tests ─────────────────────────────────────────────────────────────────

test("compress beforeTokens is the raw CJK-aware estimate", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-compress-density-a.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", ZH)];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx); // prime the context round

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "compressed" }] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.equal(beforeTokensFrom(text), 324); // 3 + 300 (ZH) + <acp> tag chars (~21)
});

// afterTokens (and hence "reclaimed") must be measured on the SAME scale as
// beforeTokens — the post-processTurn sent view, which carries every active
// block's summary anchor plus ref-tag overhead. Regressing to the raw
// projection (no summaries, no tags) would over-claim reclaimed by the
// cumulative summary mass of all blocks, exactly in long sessions.
test("compress afterTokens is measured on the same sent-view scale as beforeTokens (multi-block)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-compress-scales.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", ZH), userMsg("e3", ZH2), userMsg("e4", ZH2)];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx); // prime the context round

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  async function doCompress(callId: string, range: { startId: string; endId: string; summary: string }) {
    const out = await compressTool.execute(callId, { content: [range] }, undefined, undefined, ctx);
    return typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  }

  await doCompress("tc1", { startId: "m00001", endId: "m00001", summary: "first block" });
  const text = await doCompress("tc2", { startId: "m00003", endId: "m00003", summary: "second block" });

  const m = /▣ ACP \| (\d+(?:\.\d+)?)(K?) → (\d+(?:\.\d+)?)(K?) tokens \(~(\d+(?:\.\d+)?)(K?) reclaimed/.exec(text);
  assert.ok(m, `no ACP line in output: ${text}`);
  const toTok = (n: string, k?: string) => (k === "K" ? Number(n) * 1000 : Number(n));
  const before = toTok(m![1]!, m![2]);
  const after = toTok(m![3]!, m![4]);
  const reclaimed = toTok(m![5]!, m![6]);

  // Visible-only (e2+e4) = 450. The true post-compression sent view adds the
  // two summary anchors + tag overhead (~60) → afterTokens ≥ 480; a raw
  // projection regression would report ~450.
  assert.ok(after >= 480, `afterTokens ${after} missing the summary-anchor scale (raw projection would be ~450): ${text}`);
  // True freed ≈ removed e3 (150) + tag delta − new summary (~170); a raw
  // afterTokens would over-claim by block-1 summary + tags (~220).
  assert.ok(reclaimed <= 180, `reclaimed ${reclaimed} over-claimed (raw afterTokens would be ~220): ${text}`);
  assert.equal(before - after, reclaimed, "reclaimed consistent with the arrow");
});

// issue #309: a model that emits double-escaped summaries (literal \uXXXX runs
// in the parsed string) must not have that corruption stored — the kernel
// renders summaries verbatim into every future prompt.
test("compress normalizes double-escaped \\uXXXX summaries before storage", async () => {
  const { api, handlers } = captureApi();
  // minCompressRange gate needs ≥5000 chars in the range; the kernel's
  // unconfigurable preserveRecentTokens (5000) protects any trailing window,
  // so e2 carries ≥5000 tokens of its own and preserveRecentMessages:1 makes
  // e1 (the compress target) fall outside every protected zone.
  createAcpExtension({ modelContextLimit: 200_000, preserveRecentMessages: 1 })(api as any);
  const stateFile = "/tmp/pai-acp-compress-unescape.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "中".repeat(6000)), userMsg("e2", "中".repeat(6000))];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx); // prime the context round

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  // Padded so the DECODED form clears minSummaryLength (50): 4 + 25 + 25.
  const escapedSummary = "摘要: " + "\\u5408".repeat(25) + " 结束。" + "尾".repeat(25);
  assert.ok(escapedSummary.includes("\\u5408"), "precondition: literal escape runs in input");
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: escapedSummary }] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.ok(text.includes("▣ ACP"), `compress failed: ${text}`);
  assert.ok(!text.includes("Errors:"), `compress was rejected: ${text}`);

  const raw = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  const block = (raw.blocks as any[]).find((b) => typeof b.summary === "string" && b.summary.length > 0);
  assert.ok(block, "no block stored in acp state");
  assert.ok(block.summary.includes("合".repeat(25)), "stored summary must contain decoded CJK");
  assert.ok(!block.summary.includes("\\u5408"), "stored summary must not contain literal \\uXXXX runs");
});
