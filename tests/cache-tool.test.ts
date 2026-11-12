import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { tmpPath } from "./tmp-path.js";

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

async function setup(entries: any[], stateFile: string, notifies: string[] = []) {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
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
  const { tool } = await setup(entries, tmpPath("pai-acp-cache-nofolds.session.json"));
  const res = await tool.execute("tc1", {}, undefined, undefined, fakeCtx(entries, tmpPath("pai-acp-cache-nofolds.session.json")));
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
