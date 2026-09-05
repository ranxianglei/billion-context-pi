import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { createCore, createInitialState, defaultConfig, defaultCountTokens, type CoreMessage } from "acp-kernel";
import { sentViewTokenCount, estimateTokens } from "../src/tokens.js";

const L = 100_000;
const MID = "lorem ".repeat(3000);
const STATE_FILE = "/tmp/pai-acp-view-recount.session.json";

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

function msg(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content, timestamp: Date.now(), ...extra } };
}

let branchEntries: any[] = [];

function fakeCtx() {
  return {
    mode: "rpc" as const,
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: L, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      getBranch: () => branchEntries as any[],
      getSessionId: () => "view-recount",
      getSessionFile: () => STATE_FILE,
    },
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: branchEntries.map((e) => e.message) }, ctx);

// Only EMERGENCY nudges carry this phrase (kernel nudge-text.ts); gentle
// growth nudges do not, so it discriminates the #289 failure mode precisely.
const emergencyCount = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached/.test(JSON.stringify(m.content))).length;

const anyNudgeCount = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached|compress/i.test(JSON.stringify(m.content))).length;

// #289 Fix A discriminator. The raw-view estimate (core minus block coverage)
// counts messages that prune strips from the sent view every turn: an
// uncovered tool-result whose paired call got compressed. Layout below makes
// exactly that happen — c1's result sits 21 positions past c1's split core,
// beyond adjustBoundariesForToolPairs' maxScan=20, so compressing c1 alone
// orphans r1. Raw view then reads ~97% (>= emergency band 0.95) while the
// honest sent view reads ~72%: OLD code keeps firing EMERGENCY, NEW code's
// sent-view recount drops below the band.
test("#289 Fix A: sent-view recount suppresses spurious emergency", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: L })(api as any);
    const compressTool = api.tools.find((t: any) => t.name === "compress");
    assert.ok(compressTool, "compress tool registered");
    const ctx = fakeCtx();

    const entries: any[] = [];
    for (let i = 0; i < 16; i++) entries.push(msg(`b${i}`, i % 2 ? "assistant" : "user", `bulk ${i} ${MID}`));
    const calls: any[] = [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x".repeat(30_000) } }];
    for (let i = 2; i <= 21; i++) calls.push({ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "ls" } });
    entries.push(msg("multi", "assistant", calls));
    entries.push(msg("r1", "toolResult", [{ type: "text", text: "y".repeat(100_000) }], { toolName: "bash", toolCallId: "c1" }));
    for (let i = 2; i <= 21; i++) entries.push(msg(`r${i}`, "toolResult", [{ type: "text", text: "ok" }], { toolName: "bash", toolCallId: `c${i}` }));
    branchEntries = entries;

    // Round 1 primes the session (~104.5% raw — emergency expected on both
    // old and new code).
    const r1 = await fire(handlers, ctx);
    assert.ok(anyNudgeCount(r1) >= 1, "round 1 primes the emergency band");

    // Resolve c1's split-core ref from the persisted refmap instead of assuming
    // numbering (assignRefs may skip/protect messages).
    const st = JSON.parse(await readFileSync(`${STATE_FILE}.acp.json`, "utf8"));
    const byRef: Record<string, string> = st.messageRefs?.byRef ?? {};
    const refC1 = Object.keys(byRef).find((k) => byRef[k] === "multi#c1");
    assert.ok(refC1, `ref for multi#c1 found in ${Object.keys(byRef).length} refs`);

    const out: any = await compressTool.execute("tc1", { content: [{ startId: refC1, endId: refC1, summary: "s".repeat(300) }] }, undefined, undefined, ctx);
    const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
    assert.match(text, /1 block/, `expected successful compress, got: ${text}`);

    // Session realism: the compress toolResult lands in the transcript.
    branchEntries.push(msg("cr1", "toolResult", [{ type: "text", text: "▣ ACP | 81.7K → 72.2K tokens (~9.5K reclaimed, 1 block)" }], { toolName: "compress", toolCallId: "tc1" }));

    // Round 2: raw estimate ~97% (orphaned r1 counted forever) vs honest sent
    // view ~72%. OLD: EMERGENCY fires. NEW: recount stays below the band.
    const r2 = await fire(handlers, ctx);
    assert.equal(emergencyCount(r2), 0, "no emergency nudge once the sent view is measured honestly (#289 discriminator)");
  } finally {
    await rm(`${STATE_FILE}.acp.json`, { force: true });
  }
});

// Helper sanity: with zero blocks the probe view equals the raw view (only
// ref-tag overhead differs) — no drift, no systematic offset.
test("#289 helper: zero-block state does not drift", () => {
  const core = createCore({ countTokens: defaultCountTokens });
  const state = createInitialState();
  const msgs: CoreMessage[] = [
    { id: "e1", role: "user", contentType: "text", text: "hello world" },
    { id: "e2", role: "assistant", contentType: "text", text: "hi" },
  ];
  const prelim = estimateTokens(msgs);
  const r = sentViewTokenCount(core, msgs, state, defaultConfig(L), prelim);
  assert.equal(r.drifted, false);
  assert.ok(r.viewTokens >= prelim, `viewTokens ${r.viewTokens} should include ref-tag overhead over prelim ${prelim}`);
});

// #289 Fix A′: the probe must measure the PRE-truncation sent view. Passing
// prelim straight into processTurn lets emergencyTruncateNode fire inside the
// probe whenever prelim sits in the truncate band (>= threshold*limit), so the
// measurement would depend on prelim and under-report the honest view. With
// the clamp, two prelims both at/above the band edge yield identical counts,
// and the count covers the full untruncated view (+ ref-tag overhead).
test("#289 Fix A': probe measurement is invariant to prelim inside the truncate band", () => {
  const core = createCore({ countTokens: defaultCountTokens });
  const state = createInitialState();
  const config = defaultConfig(L);
  // r1's truncation savings (~11.5k tok) sit between the two cutoffs
  // (prelim - 0.9*threshold*limit): at `lo` the old code stops after r1, at
  // `hi` it also truncates r2 — so old-code measurements differ, new-code
  // measurements are identical. Six trailing messages keep r1/r2 outside the
  // preserveRecentMessages=5 protection window; no toolCallId means prune
  // keeps both results.
  const msgs: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "start" },
    { id: "r1", role: "tool", contentType: "tool-result", text: "x".repeat(50_000) },
    { id: "r2", role: "tool", contentType: "tool-result", text: "y".repeat(16_000) },
    { id: "a1", role: "assistant", contentType: "text", text: "ok" },
    { id: "u2", role: "user", contentType: "text", text: "q1" },
    { id: "a2", role: "assistant", contentType: "text", text: "ok" },
    { id: "u3", role: "user", contentType: "text", text: "q2" },
    { id: "a3", role: "assistant", contentType: "text", text: "ok" },
    { id: "u4", role: "user", contentType: "text", text: "next" },
  ];
  const lo = Math.floor(config.truncate.threshold * L); // exactly at the band edge
  const hi = L - 1; // deep in the band
  const a = sentViewTokenCount(core, msgs, state, config, lo);
  const b = sentViewTokenCount(core, msgs, state, config, hi);
  assert.equal(a.viewTokens, b.viewTokens, "probe must not self-truncate: measurement independent of prelim inside the band");
  const raw = estimateTokens(msgs);
  assert.ok(a.viewTokens >= raw, `pre-truncation view ${a.viewTokens} should cover the raw estimate ${raw} (+ ref-tag overhead)`);
});

// #289 Fix B: acp_status arbitrates on the sent view like the context
// transform. In the orphan layout below the raw-view estimate sits in the
// growth band (~88%) while the honest sent view is well under it (~58%):
// OLD code shows "Nudge: ACTIVE", fixed code shows "Nudge: idle".
test("#289 Fix B: acp_status nudge follows the sent view, not the raw estimate", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: L })(api as any);
    const compressTool = api.tools.find((t: any) => t.name === "compress");
    const statusTool = api.tools.find((t: any) => t.name === "acp_status");
    assert.ok(statusTool, "acp_status tool registered");
    const ctx = fakeCtx();

    const MIDB = "lorem ".repeat(2200); // ~3.3k tokens each × 16 ≈ 53k
    const entries: any[] = [];
    for (let i = 0; i < 16; i++) entries.push(msg(`b${i}`, i % 2 ? "assistant" : "user", `bulk ${i} ${MIDB}`));
    const calls: any[] = [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x".repeat(30_000) } }];
    for (let i = 2; i <= 21; i++) calls.push({ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "ls" } });
    entries.push(msg("multi", "assistant", calls));
    entries.push(msg("r1", "toolResult", [{ type: "text", text: "y".repeat(120_000) }], { toolName: "bash", toolCallId: "c1" }));
    for (let i = 2; i <= 21; i++) entries.push(msg(`r${i}`, "toolResult", [{ type: "text", text: "ok" }], { toolName: "bash", toolCallId: `c${i}` }));
    branchEntries = entries;

    await fire(handlers, ctx);
    const st = JSON.parse(await readFileSync(`${STATE_FILE}.acp.json`, "utf8"));
    const byRef: Record<string, string> = st.messageRefs?.byRef ?? {};
    const refC1 = Object.keys(byRef).find((k) => byRef[k] === "multi#c1");
    assert.ok(refC1, `ref for multi#c1 found in ${Object.keys(byRef).length} refs`);
    await compressTool.execute("tc1", { content: [{ startId: refC1, endId: refC1, summary: "s".repeat(300) }] }, undefined, undefined, ctx);
    branchEntries.push(msg("cr1", "toolResult", [{ type: "text", text: "▣ ACP | done" }], { toolName: "compress", toolCallId: "tc1" }));

    const out: any = await statusTool.execute("st1", {}, undefined, undefined, ctx);
    const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
    assert.match(text, /Nudge: idle/, `acp_status should read the sent view (~58%), got:\n${text.slice(0, 500)}`);
  } finally {
    await rm(`${STATE_FILE}.acp.json`, { force: true });
  }
});
