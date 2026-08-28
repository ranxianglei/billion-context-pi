import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
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

test("compress beforeTokens at density=1 is uncalibrated estimateTokens", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-compress-density-a.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", ZH)];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx); // 只锚点，无样本 → density=1

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "compressed" }] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.equal(beforeTokensFrom(text), 324); // 3 + 300 (ZH) + <acp> tag chars (~21)
});

test("compress beforeTokens scales with calibrated density (Phase 2)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-compress-density-b.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", ZH)];
  const ctx = fakeCtx(entries, stateFile);

  // 轮1：锚点（real=100k, est=303）
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx);
  // 轮2：Δreal=240 / Δest=150 → instant 1.6, pending（追加 e3）
  entries.push(userMsg("e3", ZH2));
  ctx.__setUsage(100_240);
  await runContextRound(handlers, ctx);
  // 轮3：instant 1.6 → 确认采纳（追加 e4）
  entries.push(userMsg("e4", ZH2));
  ctx.__setUsage(100_480);
  await runContextRound(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "compressed" }] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  // estTotal = 3+300+150+150 = 603；×1.6 = 964.8 → 965
  // est 603 + tag overhead (4 msgs × ~21 chars / 4) ≈ 645 × 1.6 ≈ 1032 → 1.0K
  assert.match(text, /▣ ACP \| 1\.0K →/);
});

// afterTokens (and hence "reclaimed") must be measured on the SAME scale as
// beforeTokens — the post-processTurn sent view, which carries every active
// block's summary anchor plus ref-tag overhead. Regressing to the raw
// projection (no summaries, no tags) would over-claim reclaimed by the
// cumulative summary mass of all blocks, exactly in long sessions.
test("compress afterTokens is measured on the same sent-view scale as beforeTokens (multi-block)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-compress-scales.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", ZH), userMsg("e3", ZH2), userMsg("e4", ZH2)];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx); // density anchor at 1

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
