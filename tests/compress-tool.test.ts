import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import type { CoreMessage } from "acp-kernel";
import { createAcpExtension } from "../src/index.js";
import { firstFoldStartTokens } from "../src/compress-tool.js";
import { estimateTokens } from "../src/tokens.js";

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

test("firstFoldStartTokens measures the pre-fold prefix on the beforeTokens scale (#359)", () => {
  const msgs = [
    { id: "a", role: "user", contentType: "text", text: "x".repeat(400) },
    { id: "b", role: "assistant", contentType: "text", text: "y".repeat(800) },
    { id: "c", role: "user", contentType: "text", text: "z".repeat(1200) },
  ] as unknown as CoreMessage[];
  const none = new Set<string>();
  const noImages = new Map<string, number>();
  // fold starts at c → prefix = a+b, exactly what estimateTokens gives for the slice
  assert.equal(firstFoldStartTokens(msgs, none, noImages, new Set(["c"])), estimateTokens(msgs.slice(0, 2), none, noImages));
  // fold at the very start → zero prefix
  assert.equal(firstFoldStartTokens(msgs, none, noImages, new Set(["a"])), 0);
  // middle fold → one-message prefix
  assert.equal(firstFoldStartTokens(msgs, none, noImages, new Set(["b"])), estimateTokens(msgs.slice(0, 1), none, noImages));
  // folded id absent from the view → nothing measurable
  assert.equal(firstFoldStartTokens(msgs, none, noImages, new Set(["zzz"])), null);
  // covered-id exclusion matches beforeTokens semantics
  const coveredA = new Set(["a"]);
  assert.equal(firstFoldStartTokens(msgs, coveredA, noImages, new Set(["c"])), estimateTokens(msgs.slice(0, 2), coveredA, noImages));
});

test("event=applied logs firstFoldStartPct + retainedPctUpperBound fold geometry (#359)", async () => {
  const logFile = "/tmp/pai-acp-compress-applied-geometry.log";
  const stateFile = "/tmp/pai-acp-compress-applied-geometry.session.json";
  await rm(logFile, { force: true });
  await rm(`${stateFile}.acp.json`, { force: true });
  process.env.ACP_LOG_FILE = logFile;
  try {
    const { api, handlers } = captureApi();
    // preserveRecentMessages:1 keeps only m00003 out of the protected zone so
    // the middle fold (m00002) is viable (same pattern as the #309 test).
    createAcpExtension({ modelContextLimit: 200_000, preserveRecentMessages: 1 })(api as any);
    const BIG = "中".repeat(6000);
    const entries = [userMsg("e1", BIG), userMsg("e2", BIG), userMsg("e3", BIG)];
    const ctx = fakeCtx(entries, stateFile);
    ctx.__setUsage(100_000);
    await runContextRound(handlers, ctx); // prime refs

    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    const out = await compressTool.execute(
      "tc1",
      { content: [{ startId: "m00002", endId: "m00002", summary: "Middle fold geometry test: second of three identical CJK message blocks compressed to verify the applied-event fields." }] },
      undefined, undefined, ctx,
    );
    const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
    assert.ok(text.includes("▣ ACP") && !text.includes("Errors:"), `compress failed: ${text}`);

    const lines = (await readFile(logFile, "utf8")).split("\n").filter((l) => l.includes("event=applied"));
    assert.equal(lines.length, 1, `exactly one applied line, got: ${lines.join(" | ")}`);
    const applied = lines[0]!;
    const start = Number(/firstFoldStartPct=(\d+(?:\.\d+)?)/.exec(applied)?.[1]);
    const retained = Number(/retainedPctUpperBound=(\d+(?:\.\d+)?)/.exec(applied)?.[1]);
    // m00002 is the middle of three equal messages → divergence ≈ 1/3 into the view
    assert.ok(start > 0.2 && start < 0.6, `firstFoldStartPct ≈ 1/3 for a middle fold, got ${start} (${applied})`);
    // ~2/3 of the view survives → upper bound in (0.4, 0.9)
    assert.ok(retained > 0.4 && retained < 0.9, `retainedPctUpperBound ≈ 2/3, got ${retained} (${applied})`);
    // invariant: longest common prefix ≤ surviving token fraction
    assert.ok(start <= retained, `prefix retention ≤ surviving fraction: ${start} ≤ ${retained}`);
  } finally {
    delete process.env.ACP_LOG_FILE;
  }
});
