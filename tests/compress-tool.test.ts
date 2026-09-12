import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import type { CompressionBlock, CompressionState } from "acp-kernel";
import { createAcpExtension } from "../src/index.js";
import { blockSpanLabel, compressPanelBlocks, isCompressNoopText, isCompressSuccessText } from "../src/compress-tool.js";

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
// issue #378: every range must clear the kernel's minCompressRange gate
// (default 5000 chars) — the old sub-gate payloads were rejected outright and
// every scale assertion below passed vacuously on a no-op panel (646 → 646).
// Hence 6000-CJK-char entries + preserveRecentMessages:1 (#309/#322 pattern),
// plus explicit proof that compression really happened before the scale checks.
test("compress afterTokens is measured on the same sent-view scale as beforeTokens (multi-block)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, preserveRecentMessages: 1 })(api as any);
  const stateFile = "/tmp/pai-acp-compress-scales.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const big = "中".repeat(6000); // clears minCompressRange (default 5000 chars)
  const entries = [userMsg("e1", big), userMsg("e2", big), userMsg("e3", big), userMsg("e4", big)];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx); // prime the context round

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  async function doCompress(callId: string, range: { startId: string; endId: string; summary: string }) {
    const out = await compressTool.execute(callId, { content: [range] }, undefined, undefined, ctx);
    return typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  }

  const first = await doCompress("tc1", { startId: "m00001", endId: "m00001", summary: "中".repeat(300) });
  const text = await doCompress("tc2", { startId: "m00003", endId: "m00003", summary: "文".repeat(300) });

  assert.ok(first.includes("▣ ACP") && !first.includes("Errors:"), `tc1 not compressed — guard would be vacuous: ${first}`);
  assert.ok(text.includes("▣ ACP") && !text.includes("Errors:"), `tc2 not compressed — guard would be vacuous: ${text}`);
  const stored = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  const blocks = stored.blocks as any[];
  assert.equal(blocks.length, 2, "both compressions must have created stored blocks");
  for (const b of blocks) {
    assert.ok(typeof b.summary === "string" && b.summary.length > 0, `block ${b.blockId} missing stored summary`);
  }

  const m = /▣ ACP \| (\d+(?:\.\d+)?)(K?) → (\d+(?:\.\d+)?)(K?) tokens \(~(\d+(?:\.\d+)?)(K?) reclaimed/.exec(text);
  assert.ok(m, `no ACP line in output: ${text}`);
  const toTok = (n: string, k?: string) => (k === "K" ? Number(n) * 1000 : Number(n));
  const before = toTok(m![1]!, m![2]);
  const after = toTok(m![3]!, m![4]);
  const reclaimed = toTok(m![5]!, m![6]);

  // Visible-only (e2+e4) = 12000. The true sent view adds both blocks' summary
  // anchors (~300 each incl. tag overhead) → afterTokens ≈ 12600; a raw
  // projection regression reports 12000.
  assert.ok(after >= 12300, `afterTokens ${after} missing the summary-anchor scale (raw projection reports 12000): ${text}`);
  // True freed ≈ removed e3 (6000) − new summary anchor (~300) → ~5700; a raw
  // afterTokens over-claims by BOTH blocks' anchor mass (~6300).
  assert.ok(reclaimed <= 6000, `reclaimed ${reclaimed} over-claimed (raw afterTokens reports ~6300): ${text}`);
  // formatK rounds each figure into a 100-token bucket → allow combined slack.
  assert.ok(Math.abs(before - after - reclaimed) <= 150, `panel internally inconsistent: ${before} → ${after} (~${reclaimed} reclaimed)`);
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

// issue #322: in-memory subagent sessions (pi-subagents rememberAgents:false →
// SessionManager.inMemory()) have getSessionFile() === undefined. A successful
// compress must stay visible to the NEXT context round; before the fix save()
// returned before updating the in-process cache, so every turn reloaded the
// pristine initial state and the model re-compressed the same original context.
test("compress in an in-memory session (no session file) survives to the next context round", async () => {
  const { api, handlers } = captureApi();
  // minCompressRange gate needs ≥5000 chars per range; each entry carries 6000
  // CJK chars, and preserveRecentMessages:1 keeps both targets outside the
  // protected trailing zones (same pattern as the #309 test).
  createAcpExtension({ modelContextLimit: 200_000, preserveRecentMessages: 1 })(api as any);
  const BIG = "中".repeat(6000);
  const entries = [userMsg("e1", BIG), userMsg("e2", BIG), userMsg("e3", BIG), userMsg("e4", BIG)];
  const ctx = fakeCtx(entries, undefined);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx); // prime refs

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const statusTool = api.tools.find((t: any) => t.name === "acp_status")!;
  async function doCompress(callId: string, range: { startId: string; endId: string; summary: string }) {
    const out = await compressTool.execute(callId, { content: [range] }, undefined, undefined, ctx);
    return typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  }
  async function statusText() {
    const out = await statusTool.execute("st1", { scope: "compressed" }, undefined, undefined, ctx);
    return typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  }

  const first = await doCompress("tc1", { startId: "m00001", endId: "m00001", summary: "first block: initial context round compressed for the in-memory session test" });
  assert.ok(first.includes("▣ ACP"), `first compress failed: ${first}`);
  assert.ok(!first.includes("Errors:"), `first compress rejected: ${first}`);

  await runContextRound(handlers, ctx); // next turn — the bug lost state here

  let report = await statusText();
  assert.match(report, /b1 \(T1\)/, `next round must still show block b1: ${report}`);

  const second = await doCompress("tc2", { startId: "m00002", endId: "m00002", summary: "second block: follow-up context round compressed for the in-memory session test" });
  assert.ok(second.includes("▣ ACP"), `second compress failed: ${second}`);
  assert.ok(!second.includes("Errors:"), `second compress rejected: ${second}`);

  report = await statusText();
  assert.match(report, /b1 \(T1\)/, `b1 must survive after the second compress: ${report}`);
  assert.match(report, /b2 \(T1\)/, `second block must be numbered b2 (nextBlockId retained), not reset to b1: ${report}`);
});

// issue #376: the panel line must report each NEW block's id and its ACTUAL
// ref span (from effectiveMessageIds), so the model's block ledger matches
// reality instead of being inferred from the requested startId/endId.
test("compress panel lists every new block id with its actual ref span (#376)", async () => {
  const { api, handlers } = captureApi();
  // minCompressRange gate needs ≥5000 chars per range (same pattern as #309/#322).
  createAcpExtension({ modelContextLimit: 200_000, preserveRecentMessages: 1 })(api as any);
  const BIG = "中".repeat(6000);
  const stateFile = "/tmp/pai-acp-compress-spans.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", BIG), userMsg("e2", BIG), userMsg("e3", BIG), userMsg("e4", BIG)];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    { content: [
      { startId: "m00001", endId: "m00001", summary: "first range: span reporting test for issue 376 block ledger accuracy" },
      { startId: "m00003", endId: "m00003", summary: "third entry compressed for the span reporting test of issue 376" },
    ] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.ok(text.includes("▣ ACP"), `compress failed: ${text}`);
  assert.ok(!text.includes("Errors:"), `compress rejected: ${text}`);

  const m = /reclaimed, blocks: (.+)\)$/.exec(text.split("\n")[0]!);
  assert.ok(m, `panel missing per-block spans: ${text}`);
  const parts = m![1]!.split(", ");
  assert.equal(parts.length, 2, `expected two block entries: ${m![1]}`);
  assert.match(parts[0]!, /^b1=(?:m\d{5}(?:–m\d{5})?\*?)$/, `first entry must be b1 with a ref span: ${parts[0]}`);
  assert.match(parts[1]!, /^b2=(?:m\d{5}(?:–m\d{5})?\*?)$/, `second entry must be b2 with a ref span: ${parts[1]}`);
});

// issue #376 acceptance: on a PARTIAL run (one range rejected, one applied)
// the panel must still list exactly the blocks that were created.
test("partial compress panel lists only the created blocks accurately (#376)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, preserveRecentMessages: 1 })(api as any);
  const BIG = "中".repeat(6000);
  const stateFile = "/tmp/pai-acp-compress-partial-spans.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", BIG), userMsg("e2", BIG), userMsg("e3", BIG), userMsg("e4", BIG)];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  async function doCompress(callId: string, ranges: any[]) {
    const o = await compressTool.execute(callId, { content: ranges }, undefined, undefined, ctx);
    return typeof o === "string" ? o : o.content?.[0]?.text ?? String(o);
  }

  const first = await doCompress("tc1", [{ startId: "m00001", endId: "m00001", summary: "first range for the partial span reporting regression test" }]);
  assert.ok(first.includes("blocks: b1="), `first compress missing span clause: ${first}`);

  const partial = await doCompress("tc2", [
    { startId: "m00001", endId: "m00001", summary: "duplicate range that must be rejected because already compressed" },
    { startId: "m00002", endId: "m00002", summary: "second range for the partial span reporting regression test" },
  ]);
  assert.ok(partial.includes("Errors:"), `partial run must report the rejected range: ${partial}`);
  assert.match(partial, /already covered by active block/i, `expect already-covered rejection: ${partial}`);
  const m = /reclaimed, blocks: (b\d+(?:\(T\d\))?=(?:m\d{5}(?:–m\d{5})?\*?))\)$/.exec(partial.split("\n")[0]!);
  assert.ok(m, `partial panel missing per-block spans: ${partial}`);
  assert.equal(m![1]!.startsWith("b2="), true, `only the new block b2 may be listed: ${m![1]}`);
});

function makeBlock(over: Partial<CompressionBlock>): CompressionBlock {
  return {
    blockId: "b1", runId: "r1", tier: 1, summary: "s",
    directMessageIds: [], effectiveMessageIds: [], directBlockIds: [],
    compressedTokens: 0, createdAt: 0, survivedCount: 0, generation: "young", active: true,
    ...over,
  };
}

function makeState(byRaw: Record<string, string>): CompressionState {
  const byRef: Record<string, string> = {};
  for (const [raw, ref] of Object.entries(byRaw)) byRef[ref] = raw;
  return {
    blocks: [], messageRefs: { byRaw, byRef }, tokenSnapshot: {},
    nudge: { lastPerMessageNudgeTokens: 0, lastNudgeShownTokens: 0, baselineTokens: 0, anchors: {}, lastShownByTier: {} },
    stats: { tokensCompressed: 0, compressionCount: 0 }, nextBlockId: 2, nextRunId: 1,
  };
}

test("blockSpanLabel: contiguous span, no star", () => {
  const refs = { r1: "m00001", r2: "m00002", r3: "m00003", r4: "m00004", r5: "m00005" };
  const b = makeBlock({ effectiveMessageIds: ["r1", "r2", "r3", "r4", "r5"] });
  assert.equal(blockSpanLabel(b, makeState(refs)), "b1=m00001–m00005");
});

test("blockSpanLabel: interior exclusion marked with *", () => {
  const refs = { r1: "m00001", r2: "m00002", r3: "m00003", r4: "m00004", r5: "m00005" };
  const b = makeBlock({ effectiveMessageIds: ["r1", "r3", "r5"] });
  assert.equal(blockSpanLabel(b, makeState(refs)), "b1=m00001–m00005*");
});

test("blockSpanLabel: trailing exclusion is NOT a star (span itself is accurate)", () => {
  const refs = { r1: "m00001", r2: "m00002", r3: "m00003", r4: "m00004" };
  const b = makeBlock({ effectiveMessageIds: ["r1", "r2", "r3"] });
  assert.equal(blockSpanLabel(b, makeState(refs)), "b1=m00001–m00003");
});

test("blockSpanLabel: pre-existing numbering gap without byRef entry is not an exclusion", () => {
  const refs = { r1: "m00001", r2: "m00003" };
  const b = makeBlock({ effectiveMessageIds: ["r1", "r2"] });
  assert.equal(blockSpanLabel(b, makeState(refs)), "b1=m00001–m00003");
});

test("blockSpanLabel: single-message span renders bare; tier >= 2 marked", () => {
  const refs = { r3: "m00003" };
  assert.equal(blockSpanLabel(makeBlock({ effectiveMessageIds: ["r3"] }), makeState(refs)), "b1=m00003");
  const t2 = makeBlock({ blockId: "b6", tier: 2, effectiveMessageIds: ["r3"] });
  assert.equal(blockSpanLabel(t2, makeState(refs)), "b6(T2)=m00003");
});

test("blockSpanLabel: unresolvable ids fall back to the bare block id", () => {
  const b = makeBlock({ effectiveMessageIds: ["orphan-raw-id"] });
  assert.equal(blockSpanLabel(b, makeState({})), "b1");
});

test("panel parser accepts both legacy count form and #376 span form", () => {
  assert.equal(isCompressSuccessText("▣ ACP | 58.5K → 5.7K tokens (~52.8K reclaimed, 4 blocks)"), true);
  assert.equal(isCompressSuccessText("▣ ACP | 61.1K → 13.7K tokens (~47.4K reclaimed, blocks: b3=m00044–m00097*, b4=m00103–m00123*)"), true);
  assert.equal(isCompressNoopText("▣ ACP | 58.5K → 58.5K tokens (~0 reclaimed, 0 blocks)"), true);
  assert.equal(isCompressNoopText("▣ ACP | 61.1K → 13.7K tokens (~47.4K reclaimed, blocks: b3=m00044–m00097*, b4=m00103–m00123*)"), false);
  assert.equal(isCompressSuccessText("No ranges provided."), false);
  assert.equal(isCompressNoopText("No ranges provided."), false);
});

test("compressPanelBlocks counts tier labels correctly ((Tn) carries a paren)", () => {
  assert.equal(compressPanelBlocks("▣ ACP | 58.5K → 5.7K tokens (~52.8K reclaimed, 4 blocks)"), 4);
  assert.equal(compressPanelBlocks("▣ ACP | 58.5K → 5.7K tokens (~52.8K reclaimed, 1 block)"), 1);
  assert.equal(compressPanelBlocks("▣ ACP | 58.5K → 58.5K tokens (~0 reclaimed, 0 blocks)"), 0);
  assert.equal(compressPanelBlocks("▣ ACP | 61.1K → 13.7K tokens (~47.4K reclaimed, blocks: b3=m00044–m00097*)"), 1);
  assert.equal(compressPanelBlocks("▣ ACP | 61.1K → 13.7K tokens (~47.4K reclaimed, blocks: b3=m00044–m00097*, b4=m00103–m00123*)"), 2);
  assert.equal(compressPanelBlocks("▣ ACP | 61.1K → 13.7K tokens (~47.4K reclaimed, blocks: b3=m00044–m00097*, b4(T2)=m00103–m00123*)"), 2);
  // regression: FIRST listed block is tier >= 2 — a capture-to-next-")" parse returns 1 here
  assert.equal(compressPanelBlocks("▣ ACP | 61.1K → 13.7K tokens (~47.4K reclaimed, blocks: b3(T2)=m00044–m00097, b4(T2)=m00103–m00123*)"), 2);
  assert.equal(compressPanelBlocks("No ranges provided."), -1);
});
