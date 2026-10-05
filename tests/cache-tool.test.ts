import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";
import type { AdapterConfig } from "../src/config.js";
import { buildCacheReport, type CacheSample, type FoldEvent } from "acp-kernel";

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

function userMsg(id: string, text: string, ts?: number) {
  return { type: "message", id, parentId: null, timestamp: ts ? new Date(ts).toISOString() : "", message: { role: "user", content: text, timestamp: ts ?? Date.now() } };
}

function assistantMsg(id: string, text: string, usage: Record<string, number>, ts: number) {
  return { type: "message", id, parentId: null, timestamp: new Date(ts).toISOString(), message: { role: "assistant", content: text, timestamp: ts, usage } };
}

// Item rows look like `   1  16:42:03  8800 ...` — anchor on the HH:MM:SS
// column because seq is padded (width 4) and would not match \d{4}.
const ITEM_ROW = /^\s*\d+\s+\d{2}:\d{2}:\d{2}\s/;
function itemRows(text: string): string[] {
  return text.split("\n").filter((l) => ITEM_ROW.test(l));
}

function fakeCtx(entries: any[], stateFile: string, notifies: string[] = []) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: (t: string) => { notifies.push(t); }, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

async function setup(entries: any[], stateFile: string, notifies: string[] = [], adapter: AdapterConfig = { modelContextLimit: 200_000 }) {
  const { api, handlers } = captureApi();
  createAcpExtension(adapter)(api as any);
  await rm(`${stateFile}.acp.json`, { force: true });
  const ctx = fakeCtx(entries, stateFile, notifies);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  return { api, ctx, handlers, tool: api.tools.find((t: any) => t.name === "acp_cache") as any };
}

test("acp_cache reports grand ledger with closed identity (no folds)", async () => {
  const T0 = Date.now() - 60_000;
  const entries = [
    userMsg("e1", "hello world, let us start a conversation about caching.", T0 - 1000),
    assistantMsg("a1", "Sure.", { input: 400, output: 40, cacheRead: 0, cacheWrite: 4000 }, T0),
    userMsg("e2", "and another question to extend the context a bit here.", T0 - 500),
    assistantMsg("a2", "Here you go.", { input: 100, output: 30, cacheRead: 4300, cacheWrite: 0 }, T0 + 1000),
  ];
  const stateFile = tmpPath("pai-acp-cache-nofolds.session.json");
  const { tool } = await setup(entries, stateFile);
  const res = await tool.execute("tc1", {}, undefined, undefined, fakeCtx(entries, stateFile));
  const text = (res.content[0] as any).text as string;

  assert.match(text, /^ACP CACHE REPORT \(test-session\) — 2 requests/m, "header with request count");
  assert.match(text, /GRAND LEDGER/, "grand ledger section");
  assert.match(text, /total input    8800 tok/, "sum of billed prompt totals (writes count as fresh)");
  assert.match(text, /total cached   4300 tok  \(hit 48\.9% → INVESTIGATE\)/, "session hit rate + verdict");
  assert.match(text, /identity check\s+OK/, "identity closes");
  assert.doesNotMatch(text, /FOLD ECONOMICS/, "no folds → no economics section");
  // First request: everything is new content. Second: 100-tok miss with no
  // fold in the window → ttl/other bucket.
  const lines = itemRows(text);
  assert.equal(lines.length, 2, "one line item per sampled request");
  // Cold-start rule: the first sample has no prev, so its whole miss lands in
  // ttl/other (residual bucket), not new content.
  assert.match(lines[0], /4400\s+0\s+0\.0%\s+0\s+0\s+4400/, "req1: cold start → whole miss in ttl/other");
  assert.match(lines[1], /4400\s+4300\s+97\.7%\s+0\s+0\s+100/, "req2: 100 miss attributed to ttl/other");
});

test("acp_cache attributes post-fold re-pay to the fold and prices it", async () => {
  const T0 = Date.now() - 60_000;
  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const entries = [
    userMsg("e1", longText, T0 - 2000),
    // Fillers must be large enough that m00001 falls outside the kernel's
    // preserveRecentTokens (5000) soft-protection window, or compress fails.
    userMsg("e2", "filler two ".repeat(1200), T0 - 1900),
    assistantMsg("a1", "Got it.", { input: 400, output: 40, cacheRead: 0, cacheWrite: 4000 }, T0),
    userMsg("e3", "filler three ".repeat(1200), T0 - 1000),
    assistantMsg("a2", "Done.", { input: 100, output: 30, cacheRead: 4300, cacheWrite: 0 }, T0 + 1000),
    userMsg("e4", "filler four ".repeat(1200), T0 - 500),
  ];
  const stateFile = tmpPath("pai-acp-cache-folds.session.json");
  const { api, ctx, handlers } = await setup(entries, stateFile);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await compressTool.execute(
    "tc-c",
    { content: [{ startId: "m00001", endId: "m00001", summary: "Detailed initial context message for the cache-tool tests." }] },
    undefined, undefined, ctx,
  );

  const post = assistantMsg("a3", "After the fold.", { input: 1200, output: 50, cacheRead: 0, cacheWrite: 0 }, Date.now() + 5000);
  entries.push(post);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  const res = await api.tools.find((t: any) => t.name === "acp_cache")!.execute("tc2", {}, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, /— 3 requests/, "all three usage footers counted");
  assert.match(text, /identity check\s+OK/, "identity still closes after the fold");
  assert.match(text, /FOLD ECONOMICS \(1 folds @ w=1 r=0\.1 q=4\)/, "economics section with default profile");
  const foldLine = text.split("\n").find((l) => l.trim().startsWith("#1"))!;
  assert.ok(foldLine, "fold #1 line present");
  assert.match(foldLine, /T=1200/, "measured re-pay charged to the fold");
  assert.match(foldLine, /n\*=[\d.]+ k=— → \?/, "last fold: breakeven computed, cadence unobserved");
  assert.match(text, /verdict: 0 PAID BACK \/ 0 NOT PAID BACK \/ 1 unobserved/, "unobserved tally");
  const itemLines = itemRows(text);
  // Summary mode lists anomalies + the latest request: req1 (hit 0%) and the
  // post-fold request (hit 0%, also latest). The 97.7% request is omitted.
  assert.equal(itemLines.length, 2, "anomalous lines only in summary mode");
  assert.match(itemLines[1], /1200\s+0\s+0\.0%\s+0\s+1200\s+0\s+#1$/, "post-fold miss fully attributed to the fold");
  assert.match(text, /1 lines omitted/, "healthy line counted as omitted");

  const resFull = await api.tools.find((t: any) => t.name === "acp_cache")!.execute("tc2f", { detail: "full" }, undefined, undefined, ctx);
  const fullText = (resFull.content[0] as any).text as string;
  assert.equal(itemRows(fullText).length, 3, "detail:full lists every request");
  assert.match(fullText, /verdict: 0 paid back, 0 not paid back, 1 unobserved/, "full keeps legacy fold table wording");
});

test("/acp-cache command renders the same report via ui.notify fallback", async () => {
  const T0 = Date.now() - 60_000;
  const entries = [
    userMsg("e1", "hi there, starting a fresh thread to check the cache panel.", T0 - 1000),
    assistantMsg("a1", "Hello.", { input: 300, output: 20, cacheRead: 0, cacheWrite: 2700 }, T0),
  ];
  const stateFile = tmpPath("pai-acp-cache-cmd.session.json");
  const notifies: string[] = [];
  const { api, ctx } = await setup(entries, stateFile, notifies);

  const handler = api.commands.get("acp-cache") as { handler: (args: string, ctx: any) => Promise<void> } | undefined;
  assert.ok(handler, "acp-cache command registered");
  await handler.handler("", ctx);
  assert.equal(notifies.length, 1, "report delivered through notify fallback");
  assert.match(notifies[0], /^ACP CACHE REPORT \(test-session\) — 1 requests/, "same report text");
  assert.match(notifies[0], /identity check\s+OK/, "identity closes in command output");

  await handler.handler("full", ctx);
  assert.equal(notifies.length, 2, "second invocation delivered");
  assert.ok(!/\[summary/.test(notifies[1]), "args 'full' opts out of the summary header");
  assert.match(notifies[1], /^ACP CACHE REPORT \(test-session\) — 1 requests$/m, "full report header without summary marker");
});

// One compressed message + one post-fold request (the same shape as the
// re-pay test above) so the fold economics section is present and T > 0.
async function foldScenario(stateFile: string, adapter: AdapterConfig = { modelContextLimit: 200_000 }): Promise<string> {
  const T0 = Date.now() - 60_000;
  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const entries = [
    userMsg("e1", longText, T0 - 2000),
    userMsg("e2", "filler two ".repeat(1200), T0 - 1900),
    assistantMsg("a1", "Got it.", { input: 400, output: 40, cacheRead: 0, cacheWrite: 4000 }, T0),
    userMsg("e3", "filler three ".repeat(1200), T0 - 1000),
    assistantMsg("a2", "Done.", { input: 100, output: 30, cacheRead: 4300, cacheWrite: 0 }, T0 + 1000),
    userMsg("e4", "filler four ".repeat(1200), T0 - 500),
  ];
  const { api, ctx, handlers } = await setup(entries, stateFile, [], adapter);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await compressTool.execute(
    "tc-c",
    { content: [{ startId: "m00001", endId: "m00001", summary: "Detailed initial context message for the cache-tool tests." }] },
    undefined, undefined, ctx,
  );
  entries.push(assistantMsg("a3", "After the fold.", { input: 1200, output: 50, cacheRead: 0, cacheWrite: 0 }, Date.now() + 5000));
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const res = await api.tools.find((t: any) => t.name === "acp_cache")!.execute("tc-p", {}, undefined, undefined, ctx);
  return (res.content[0] as any).text as string;
}

test("acp_cache prices fold economics with the configured priceProfile", async () => {
  const base = await foldScenario(path.join(os.tmpdir(), "pai-acp-cache-price-base.session.json"));
  const deepseek = await foldScenario(path.join(os.tmpdir(), "pai-acp-cache-price-ds.session.json"), { modelContextLimit: 200_000, priceProfile: { w: 1, r: 0.1, q: 1.5 } });

  assert.match(base, /FOLD ECONOMICS \(1 folds @ w=1 r=0\.1 q=4\)/, "unset key keeps the built-in profile");
  assert.match(deepseek, /FOLD ECONOMICS \(1 folds @ w=1 r=0\.1 q=1\.5\)/, "configured profile reaches the report");
  const nStar = (t: string): number => Number(t.match(/n\*=([\d.]+)/)![1]);
  assert.ok(nStar(deepseek) < nStar(base), "lower output multiple moves the breakeven earlier");
});

test("buildCacheReport passthrough pins per-field fallback and provider-shifted economics", () => {
  // T = 0 by construction (no fresh-input growth after either fold), so
  // oneTimeCostUnits = q·σ − r·S exactly — clean formula check per profile.
  const samples: CacheSample[] = [
    { at: 0, input: 100_000, cached: 99_000, output: 100 },
    { at: 200, input: 96_000, cached: 96_000, output: 100 },
    { at: 400, input: 95_100, cached: 95_100, output: 100 },
  ];
  const folds: FoldEvent[] = [
    { at: 100, tokensCompressed: 5_000, summaryTokens: 1_000, firstFoldStartTokens: 100_000, viewAfter: 96_000 },
    { at: 300, tokensCompressed: 1_000, summaryTokens: 100, firstFoldStartTokens: 96_000, viewAfter: 95_100 },
  ];

  const def = buildCacheReport(samples, folds);
  assert.deepEqual(def.profile, { w: 1, r: 0.1, q: 4 }, "unset profile → kernel defaults");
  const f1 = def.folds[0]!;
  assert.equal(f1.oneTimeCostUnits, 3500, "q·σ − r·S = 4000 − 500");
  assert.equal(f1.perTurnSavingUnits, 400, "(S−σ)·r");
  assert.equal(f1.breakevenTurns, 8.75);
  assert.equal(f1.turnsToNextFold, 1, "one sample between f1.at and f2.at");
  assert.equal(f1.paidBack, false, "k=1 < 8.75");
  const f2 = def.folds[1]!;
  assert.equal(f2.turnsToNextFold, null, "last fold: cadence unobserved");
  assert.equal(f2.paidBack, null);
  assert.equal(f2.breakevenTurns, 300 / 90, "unrounded ratio kept verbatim");

  const ds = buildCacheReport(samples, folds, { priceProfile: { w: 1, r: 0.1, q: 1.5 } }).folds[0]!;
  assert.equal(ds.oneTimeCostUnits, 1000, "DeepSeek-class: 1500 − 500");
  assert.equal(ds.breakevenTurns, 2.5);
  assert.equal(ds.paidBack, false, "k=1 < 2.5");

  const partial = buildCacheReport(samples, folds, { priceProfile: { q: 2 } });
  assert.deepEqual(partial.profile, { w: 1, r: 0.1, q: 2 }, "per-field fallback fills w and r");
  assert.equal(partial.folds[0]!.oneTimeCostUnits, 1500, "2000 − 500");
});
