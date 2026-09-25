import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { createCore, createInitialState, defaultConfig, defaultCountTokens, type CoreMessage } from "acp-kernel";
import { sentViewTokenCount, estimateTokens } from "../src/tokens.js";
import { entriesToCoreMessages } from "../src/messages.js";
import { tmpPath } from "./tmp-path.js";

const L = 100_000;
const MID = "lorem ".repeat(3000);
const STATE_FILE = tmpPath("pai-acp-view-recount.session.json");

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

// Realize the #289 straddle directly in the persisted state: a well-formed
// block whose coverage includes c1's split core ("multi#c1") but NOT its huge
// result r1. Kernel #684's turn-integrity gate forbids producing this by
// compressing c1 alone (a fold may no longer strand a visible tool-call from
// its result), so the fixture seeds the state instead of issuing an illegal
// split-compress. On the next pass prune() strips the uncovered r1 from the
// sent view every turn while the raw estimate keeps counting it — exactly the
// raw-inflated / sent-honest divergence #289 fixed. Seeded before the first
// context event so the (fresh-per-test) store's initial load picks it up.
async function seedStraddle(): Promise<void> {
  const base = createInitialState();
  const coreId = "multi#c1";
  base.blocks.push({
    blockId: "b0",
    runId: "seed-run",
    tier: 1,
    topic: "#289 seed",
    summary: "s".repeat(300),
    directMessageIds: [coreId],
    effectiveMessageIds: [coreId],
    directBlockIds: [],
    compressedTokens: 0,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
  });
  await writeFile(`${STATE_FILE}.acp.json`, JSON.stringify(base), "utf8");
}

// #289 Fix A discriminator. The raw-view estimate (core minus block coverage)
// counts messages that prune strips from the sent view every turn: an
// uncovered tool-result whose paired call is covered by a block. The seeded
// straddle makes exactly that happen — c1's split core is folded into a block
// while its huge result r1 stays visible. The raw view then reads ~97% (>=
// emergency band) while the honest sent view reads ~72%: a raw-driven meter
// keeps firing EMERGENCY, the sent-view recount stays below the band. Kernel
// #684 gates out the old way of building this (an illegal split-compress), so
// the scenario is realized through state instead.
test("#289 Fix A: sent-view recount suppresses spurious emergency", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: L })(api as any);
    const ctx = fakeCtx();

    const entries: any[] = [];
    for (let i = 0; i < 16; i++) entries.push(msg(`b${i}`, i % 2 ? "assistant" : "user", `bulk ${i} ${MID}`));
    const calls: any[] = [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x".repeat(30_000) } }];
    for (let i = 2; i <= 21; i++) calls.push({ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "ls" } });
    entries.push(msg("multi", "assistant", calls));
    entries.push(msg("r1", "toolResult", [{ type: "text", text: "y".repeat(100_000) }], { toolName: "bash", toolCallId: "c1" }));
    for (let i = 2; i <= 21; i++) entries.push(msg(`r${i}`, "toolResult", [{ type: "text", text: "ok" }], { toolName: "bash", toolCallId: `c${i}` }));
    branchEntries = entries;

    // Non-vacuity guard: the full projection presses the limit hard, so a
    // raw-driven meter sits in the emergency band and would fire.
    assert.ok(estimateTokens(entriesToCoreMessages(branchEntries)) >= 0.9 * L, "layout must keep the raw estimate near the limit");

    await seedStraddle();
    const r = await fire(handlers, ctx);
    assert.equal(emergencyCount(r), 0, "no emergency nudge once the sent view is measured honestly (#289 discriminator)");
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
// transform. In the seeded straddle below the raw-view estimate sits in the
// growth band (~88%) while the honest sent view is well under it (~58%): a
// raw-driven meter shows "Nudge: ACTIVE", the sent-view recount shows
// "Nudge: idle".
test("#289 Fix B: acp_status nudge follows the sent view, not the raw estimate", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  try {
    const { api, handlers } = captureApi();
    createAcpExtension({ modelContextLimit: L })(api as any);
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

    await seedStraddle();
    await fire(handlers, ctx);

    const out: any = await statusTool.execute("st1", {}, undefined, undefined, ctx);
    const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
    assert.match(text, /Nudge: idle/, `acp_status should read the sent view (~58%), got:\n${text.slice(0, 500)}`);
  } finally {
    await rm(`${STATE_FILE}.acp.json`, { force: true });
  }
});
