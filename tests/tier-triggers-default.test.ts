import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type Config, type CoreMessage, type CompressionState } from "acp-kernel";
import { resolveConfig } from "../src/config.js";

// issue #628: under the kernel framework defaults (acp-kernel#379: count path
// off at tier2Trigger 1000 / tier3Trigger 2000) the tier-2 nudge is
// unreachable — the mass paths need >=1.5x growthFloor of summary tokens AND
// > T1 effective, so tier-1 blocks accumulate without bound (observed: 22
// blocks x ~26K -> 256K window overflow on every request). The Pi adapter
// applies its own effective defaults (10 / 20); these tests pin both the
// config surface and the behavioral consequence through the real pipeline.

const LIMIT = 200_000;
const TOKEN_COUNT = 60_000;

test("resolveConfig applies Pi effective tier trigger defaults (#628)", () => {
  const cfg = resolveConfig({}, LIMIT);
  assert.equal(cfg.tiers.enabled, true);
  assert.equal(cfg.tiers.tier2Trigger, 10, "tier2Trigger effective default");
  assert.equal(cfg.tiers.tier3Trigger, 20, "tier3Trigger effective default");
});

test("explicit coreOverrides.tiers.* win over the Pi effective defaults", () => {
  const off = resolveConfig({ coreOverrides: { tiers: { tier2Trigger: 1000 } } }, LIMIT);
  assert.equal(off.tiers.tier2Trigger, 1000, "explicit tier2Trigger preserved");
  assert.equal(off.tiers.tier3Trigger, 20, "unspecified tier3Trigger still gets the Pi default");
  const custom = resolveConfig({ coreOverrides: { tiers: { enabled: true, tier2Trigger: 7, tier3Trigger: 14 } } }, LIMIT);
  assert.equal(custom.tiers.tier2Trigger, 7);
  assert.equal(custom.tiers.tier3Trigger, 14);
});

function oldMessages(): CoreMessage[] {
  const msgs: CoreMessage[] = [];
  for (let i = 0; i < 20; i++) {
    msgs.push({ id: `h_${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hist ${i} ` + "x".repeat(4000) });
  }
  return msgs;
}

// 20 old messages -> one processTurn pass (assigns m00001..m00020) -> ten
// real applyCompression calls pairing them up: exactly ten ACTIVE tier-1
// blocks, no shortcuts around the pipeline. preserveRecentMessages/Tokens: 0
// keeps every range compressible; both knobs are orthogonal to the
// tier-trigger path under test.
function buildTenT1Blocks(config: Config): CompressionState {
  const core = createCore();
  const messages = oldMessages();
  let state = core.processTurn({ messages, state: createInitialState(), config, tokenCount: 40_000 }).state;
  for (let i = 0; i < 10; i++) {
    const startRef = `m${String(i * 2 + 1).padStart(5, "0")}`;
    const endRef = `m${String(i * 2 + 2).padStart(5, "0")}`;
    const res = core.applyCompression({
      ranges: [{ startRef, endRef, summary: `summary ${i}: condensed historical detail for message pair number ${i} of ten` }],
      messages,
      state,
      config,
    });
    assert.equal(res.result.errors.length, 0, `applyCompression pair ${i} rejected: ${JSON.stringify(res.result.errors)}`);
    state = res.state;
  }
  return state;
}

function seedGrowth(state: CompressionState): void {
  // Simulate 30K tokens of growth since the last nudge baseline (>= the 22.5K
  // internal growth floor) without having to replay turns.
  state.nudge.lastPerMessageNudgeTokens = TOKEN_COUNT - 30_000;
}

test("ten active tier-1 blocks fire the T2 distillation nudge under Pi defaults (#628 repro)", () => {
  const core = createCore();
  const config = resolveConfig({ preserveRecentMessages: 0, coreOverrides: { preserveRecentTokens: 0 } }, LIMIT);
  const state = buildTenT1Blocks(config);
  assert.equal(state.blocks.filter((b) => b.active && b.tier === 1).length, 10, "fixture: ten active tier-1 blocks");
  seedGrowth(state);
  const tail = [...oldMessages(), { id: "t_1", role: "user", contentType: "text", text: "continue with the next step" }];
  const turn = core.processTurn({ messages: tail, state, config, tokenCount: TOKEN_COUNT });
  assert.ok(turn.nudge?.shouldInject, "T2 nudge must inject — was unreachable before the fix");
  assert.equal(turn.nudge?.tier, 2, "nudge targets tier-2 distillation");
  assert.match(turn.nudge?.reason ?? "", /T2 distill ready: 10 tier-1 blocks >= tier2Trigger 10/);
});

test("same session state stays silent under kernel framework defaults (original defect)", () => {
  const core = createCore();
  const config = defaultConfig(LIMIT, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
  assert.equal(config.tiers.tier2Trigger, 1000, "kernel framework default is count-off");
  const state = buildTenT1Blocks(config);
  seedGrowth(state);
  const tail = [...oldMessages(), { id: "t_1", role: "user", contentType: "text", text: "continue with the next step" }];
  const turn = core.processTurn({ messages: tail, state, config, tokenCount: TOKEN_COUNT });
  assert.ok(!turn.nudge?.shouldInject, "kernel defaults must NOT fire T2 — reproduces #628");
});
