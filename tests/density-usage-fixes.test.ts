import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { createRuntime } from "../src/runtime.js";

// Regression guards for the density-usage fixes:
//  1. post-compression detection must see blocks created OUT-OF-BAND by the
//     compress tool between context events (the within-processTurn comparison
//     in #155 could never see them — blocks are only created by
//     applyCompression, never by processTurn).
//  2. nudge usage/emergency arbitration must run on the CALIBRATED sent view
//     (raw estimate × density), not the raw estimate — otherwise CJK sessions
//     (real/estimate ≈ 1.2-1.6) trip the 75% forced nudge and the 95%
//     emergency truncate well past the real window.

// ─── 1. runtime-level detection (unit) ────────────────────────────────────

test("noteActiveBlocks detects out-of-band block creation per session", () => {
  const r = createRuntime({});
  assert.equal(r.noteActiveBlocks("s1", []), false, "first observation: no baseline yet");
  assert.equal(r.noteActiveBlocks("s1", []), false, "steady state: nothing new");
  assert.equal(r.noteActiveBlocks("s1", ["b1"]), true, "new active block since last round");
  assert.equal(r.noteActiveBlocks("s1", ["b1"]), false, "same block next round: not new");
  assert.equal(r.noteActiveBlocks("s1", ["b1", "b2"]), true, "second compress");
  assert.equal(r.noteActiveBlocks("s2", ["b1"]), false, "other session has its own baseline");
  r.clearSessionTracking("s1");
  assert.equal(r.noteActiveBlocks("s1", ["b1", "b2"]), false, "cleared session re-baselines");
});

// ─── 2. calibrated nudge arbitration (integration) ────────────────────────

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

function msg(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now() } };
}

// 400K ASCII chars = 100K tokens (chars/4, no CJK)
const BIG = "x".repeat(400_000);
// 4K chars = 1K tokens
const SMALL = "y".repeat(4_000);

const nudgeCount = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached|compress/i.test(JSON.stringify(m.content))).length;

async function runCalibratedScenario(realScale: number) {
  // realScale: provider usage per 1K estimated tokens (1.0 = uncalibrated control)
  const stateFile = `/tmp/pai-acp-calibrated-${realScale}.session.json`;
  await rm(`${stateFile}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ rollover: false, modelContextLimit: 200_000 })(api as any);

  let usage = 0;
  const ctx: any = {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "cal-test" },
    sessionManager: {
      getBranch: () => entries as any[],
      getSessionId: () => `cal-${realScale}`,
      getSessionFile: () => stateFile,
    },
    getContextUsage: () => ({ tokens: usage, percent: usage / 200_000, contextWindow: 200_000 }),
  };

  // 7 messages: 100K + 6×1K = 106K est. With preserveRecentMessages=5 the
  // first two (101K) sit OUTSIDE the protected zone from r7 onward, so a
  // forced nudge has a viable compressible range. Each round adds one message
  // (alternating roles, final round ends on a fresh user message → fresh
  // per-turn nudge key).
  const roles = ["user", "assistant", "user", "assistant", "user", "assistant", "user"] as const;
  const all = roles.map((role, i) => msg(`e${i}`, role, i === 0 ? BIG : SMALL));
  let entries: any[] = [];
  const fire = () => handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);

  let r: any;
  // r1: anchor (no sample yet)
  entries = [all[0]!];
  usage = 100_000 * realScale;
  r = await fire();
  assert.equal(nudgeCount(r), 0, "r1: anchored, no nudge");

  for (let i = 1; i <= 6; i++) {
    // r2..r7: +1K est per round → Δreal/Δest = realScale each round.
    // r2: sample 1 (pending); r3: sample 2 → ADOPT density = realScale.
    entries = all.slice(0, i + 1);
    usage += 1_000 * realScale;
    r = await fire();
  }

  // r7: raw sent view = 106K (53% of 200K — would stay idle); calibrated =
  // 106K × realScale. At 1.6 that is 169.6K (84.8%) → crosses the 75% forced
  // nudge threshold and must fire; at 1.0 it stays idle.
  await rm(`${stateFile}.acp.json`, { force: true });
  return nudgeCount(r);
}

test("forced nudge fires on the calibrated scale (density 1.6) but not on the raw scale", async () => {
  // Control: provider usage matches the raw estimate → density 1.0 →
  // 103K / 200K = 51.5% → no forced nudge.
  const control = await runCalibratedScenario(1.0);
  assert.equal(control, 0, "raw-scale session at 51.5% must not trip the forced nudge");

  // Calibrated: same message bytes, provider usage runs 1.6× the estimate
  // (a CJK-heavy session). Raw view reads 51.5%, real view reads ~82%.
  const calibrated = await runCalibratedScenario(1.6);
  assert.ok(calibrated >= 1, "calibrated 82.4% must cross the 75% forced-nudge threshold");
});
