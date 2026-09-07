import { test } from "node:test";
import assert from "node:assert/strict";
import type { AcpRuntime } from "../src/runtime.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// tsup defines CURRENT_VERSION at build time; under the node test runner it
// is bare, so stub it before the module graph reads it.
(globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";
const { makeCommands } = await import("../src/commands.js");

function fakeRuntime(): AcpRuntime {
  return {
    configFor: () => ({ modelContextLimit: 1_000_000 }),
    stateFor: async () => ({
      state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
      coreMessages: [],
    }),
    // Stub processTurn: we only exercise the panel's rendering of the
    // breakdown, not the kernel's classification logic.
    core: {
      processTurn: () => ({
        state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
        nudge: {
          contextUsage: 0.43,
          reason: "idle — max compressible 8106 < threshold 50000",
          contextBreakdown: { tool: 20_000, system: 0, text: 4_000, code: 0, summaries: 0, growth: 6_100 },
        },
      }),
    },
  } as unknown as AcpRuntime;
}

test("/acp panel (kit-rendered) separates session accounting from sent view", async () => {
  const notified: string[] = [];
  const ctx = {
    ui: { notify: (t: string) => notified.push(t) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "s", getSessionFile: () => "/tmp/s.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(fakeRuntime()).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  assert.match(text, /Context \(session accounting, host footer scale\): 43% \(430k \/ 1\.0M\) — includes compressed originals; shrinks slower than the sent view/, text);
  assert.match(text, /Sent to LLM \(after compression, est\.\): 24k \(2% of limit\)/, text);
  // unprunedTokens is passed from the same projection — Session-only derives
  // on the estimation scale (issue #18), never 430k − 24k cross-scale.
  assert.doesNotMatch(text, /406k/, "cross-scale subtraction must not appear");
  assert.match(text, /Token Breakdown \(sent view\):/, text);
  assert.doesNotMatch(text, /Framework/, "fake Framework bucket must be gone");
  const toolLine = text.split("\n").find((l) => l.trim().startsWith("Tool"))!;
  assert.match(toolLine, / 83%/, `bar percentages must use the sent view: ${toolLine}`);
});

test("/acp panel Session-only derives on the estimation scale (positive assertion)", async () => {
  // Non-empty projection: 440K chars ≈ 110K tokens (chars/4) unpruned vs the
  // stubbed 24K sent view → Session-only must read 86k — estimate minus
  // estimate, never 430k − 24k (provider scale minus estimate).
  const runtime = fakeRuntime();
  (runtime.stateFor as () => Promise<unknown>) = async () => ({
    state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
    coreMessages: [{ id: "p1", role: "user", contentType: "text", text: "a".repeat(440_000) }],
  });
  const notified: string[] = [];
  const ctx = {
    ui: { notify: (t: string) => notified.push(t) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "s2", getSessionFile: () => "/tmp/s2.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  assert.match(text, /Session-only \(compressed originals, est\.\): 86k — pruned from every request/, text);
  assert.doesNotMatch(text, /406k/, "cross-scale subtraction must not appear");
});

test("/acp panel renders prompt cache hit rate from stateFor entries", async () => {
  const runtime = fakeRuntime();
  (runtime.stateFor as () => Promise<unknown>) = async () => ({
    state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
    coreMessages: [],
    entries: [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      // request 1: 1k fresh + 99k cache-served → 99% of 100k billed
      { type: "message", message: { role: "assistant", content: [], usage: { input: 1_000, output: 50, cacheRead: 99_000, cacheWrite: 0, totalTokens: 100_050 } } },
      // no cache signal (cache-less provider) → excluded
      { type: "message", message: { role: "assistant", content: [], usage: { input: 5_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 5_010 } } },
      // request 2 (last): 180k served + 20k written → 90% of 200k billed
      { type: "message", message: { role: "assistant", content: [], usage: { input: 0, output: 80, cacheRead: 180_000, cacheWrite: 20_000, totalTokens: 200_080 } } },
    ],
  });
  const notified: string[] = [];
  const ctx = {
    ui: { notify: (t: string) => notified.push(t) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "s3", getSessionFile: () => "/tmp/s3.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  // session = (99k + 180k) / (100k + 200k) = 93.0%; last = 180k/200k = 90.0%
  assert.match(text, /Prompt cache \(provider-reported\): 90\.0% last · 93\.0% session avg — 279k of 300k billed prompt tokens served from cache \(2 req\)/, text);
});

test("/acp panel omits prompt cache section when entries carry no usage", async () => {
  const runtime = fakeRuntime();
  (runtime.stateFor as () => Promise<unknown>) = async () => ({
    state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
    coreMessages: [],
    entries: [{ type: "message", message: { role: "assistant", content: [] } }],
  });
  const notified: string[] = [];
  const ctx = {
    ui: { notify: (t: string) => notified.push(t) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "s4", getSessionFile: () => "/tmp/s4.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  assert.ok(text, "panel rendered");
  assert.doesNotMatch(text, /Prompt cache/, `cache section must be omitted without cache-reported requests:\n${text}`);
});

test("/acp and /acp-status emit a persistent custom message via pi.sendMessage (issue #255)", async () => {
  const sent: Array<{ customType: string; content: string; display: boolean }> = [];
  const pi = { sendMessage: (m: { customType: string; content: string; display: boolean }) => sent.push(m) } as unknown as ExtensionAPI;
  const notified: string[] = [];
  const ctx = {
    ui: { notify: (t: string) => notified.push(t) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "s5", getSessionFile: () => "/tmp/s5.json" },
  } as unknown as ExtensionCommandContext;

  for (const name of ["acp", "acp-status"]) {
    const cmd = makeCommands(fakeRuntime(), pi).find((c) => c.name === name)!;
    await cmd.options.handler!("", ctx);
  }

  assert.equal(sent.length, 2, "one custom message per command");
  assert.equal(notified.length, 0, "notify must not fire when sendMessage is available");
  for (const m of sent) {
    assert.equal(m.customType, "acp-status");
    assert.equal(m.display, true, "display:true renders persistently in TUI and web hosts");
    assert.match(m.content, /Context \(session accounting, host footer scale\): 43%/, "panel text is the custom message content");
  }
});

test("/acp falls back to notify when pi lacks sendMessage", async () => {
  const pi = {} as unknown as ExtensionAPI;
  const notified: string[] = [];
  const ctx = {
    ui: { notify: (t: string) => notified.push(t) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "s6", getSessionFile: () => "/tmp/s6.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(fakeRuntime(), pi).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  assert.equal(notified.length, 1, "fallback notify fires");
  assert.match(notified[0]!, /Token Breakdown \(sent view\):/, "panel text via notify");
});
