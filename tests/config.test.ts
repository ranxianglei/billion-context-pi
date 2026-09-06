import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, resolveCompress, mergeCompress, resolveDelegate, resolveRepetitionGuard, REPETITION_GUARD_DEFAULTS, type AdapterConfig } from "../src/config.js";

const EMPTY: AdapterConfig = {};

test("resolveConfig uses the live model context window as-is (no cap on large windows)", () => {
  const cfg = resolveConfig(EMPTY, 1_000_000);
  assert.equal(cfg.modelContextLimit, 1_000_000, "1M window must NOT be capped to 150K");
});

test("resolveConfig passes small windows through unchanged too", () => {
  assert.equal(resolveConfig(EMPTY, 32_000).modelContextLimit, 32_000);
  assert.equal(resolveConfig(EMPTY, 200_000).modelContextLimit, 200_000);
});

test("resolveConfig falls back to 150K only when the live window is unavailable", () => {
  assert.equal(resolveConfig(EMPTY, 0).modelContextLimit, 150_000);
});

test("resolveConfig prefers adapter.modelContextLimit over the live window", () => {
  const cfg = resolveConfig({ modelContextLimit: 500_000 }, 1_000_000);
  assert.equal(cfg.modelContextLimit, 500_000);
});

test("resolveConfig prefers ACP_MODEL_CONTEXT_LIMIT env var over everything", () => {
  const prev = process.env.ACP_MODEL_CONTEXT_LIMIT;
  process.env.ACP_MODEL_CONTEXT_LIMIT = "999999";
  try {
    const cfg = resolveConfig({ modelContextLimit: 500_000 }, 1_000_000);
    assert.equal(cfg.modelContextLimit, 999_999);
  } finally {
    if (prev === undefined) delete process.env.ACP_MODEL_CONTEXT_LIMIT;
    else process.env.ACP_MODEL_CONTEXT_LIMIT = prev;
  }
});

test("resolveConfig ignores a non-positive ACP_MODEL_CONTEXT_LIMIT and falls through", () => {
  const prev = process.env.ACP_MODEL_CONTEXT_LIMIT;
  process.env.ACP_MODEL_CONTEXT_LIMIT = "0";
  try {
    const cfg = resolveConfig(EMPTY, 1_000_000);
    assert.equal(cfg.modelContextLimit, 1_000_000, "env=0 must fall through to live window, not 0");
  } finally {
    if (prev === undefined) delete process.env.ACP_MODEL_CONTEXT_LIMIT;
    else process.env.ACP_MODEL_CONTEXT_LIMIT = prev;
  }
});

test("resolveConfig defaults to kernel 0.0.20 thresholds when no compress overrides set", () => {
  const cfg = resolveConfig(EMPTY, 1_000_000);
  assert.equal(cfg.nudge.maxContextLimitPct, 0.75);
  assert.equal(cfg.nudge.emergencyThresholdPct, 0.95);
  assert.equal(cfg.truncate.threshold, 0.95);
});

test("resolveConfig maps compress.maxContextLimit (number) to nudge.maxContextLimitPct", () => {
  const cfg = resolveConfig({ compress: { maxContextLimit: 0.8 } }, 1_000_000);
  assert.equal(cfg.nudge.maxContextLimitPct, 0.8);
});

test("resolveConfig maps compress.maxContextLimit (percent string) to nudge.maxContextLimitPct", () => {
  const cfg = resolveConfig({ compress: { maxContextLimit: "80%" } }, 1_000_000);
  assert.equal(cfg.nudge.maxContextLimitPct, 0.8);
});

test("resolveConfig maps compress.emergencyThresholdPercent to both nudge.emergencyThresholdPct and truncate.threshold", () => {
  const cfg = resolveConfig({ compress: { emergencyThresholdPercent: "90%" } }, 1_000_000);
  assert.equal(cfg.nudge.emergencyThresholdPct, 0.9);
  assert.equal(cfg.truncate.threshold, 0.9);
});

test("resolveConfig maps compress.nudgeGrowthTokens to both growthFloor and growthCap", () => {
  const cfg = resolveConfig({ compress: { nudgeGrowthTokens: 30000 } }, 1_000_000);
  assert.equal(cfg.nudge.growthFloor, 30000);
  assert.equal(cfg.nudge.growthCap, 30000);
});

test("resolveConfig leaves growthFloor/growthCap at kernel defaults when compress.nudgeGrowthTokens omitted", () => {
  const cfg = resolveConfig(EMPTY, 1_000_000);
  assert.equal(cfg.nudge.growthFloor, 50000);
  assert.equal(cfg.nudge.growthCap, 50000);
});

test("resolveConfig handles all three compress fields together", () => {
  const cfg = resolveConfig({ compress: { maxContextLimit: "70%", emergencyThresholdPercent: 0.9, nudgeGrowthTokens: 40000 } }, 1_000_000);
  assert.equal(cfg.nudge.maxContextLimitPct, 0.7);
  assert.equal(cfg.nudge.emergencyThresholdPct, 0.9);
  assert.equal(cfg.truncate.threshold, 0.9);
  assert.equal(cfg.nudge.growthFloor, 40000);
  assert.equal(cfg.nudge.growthCap, 40000);
});

test("resolveDelegate: undefined delegate defaults to enabled + separate", () => {
  const r = resolveDelegate({});
  assert.equal(r.enabled, true);
  assert.equal(r.displayUsage, "separate");
});

test("resolveDelegate: boolean true shorthand", () => {
  const r = resolveDelegate({ delegate: true });
  assert.equal(r.enabled, true);
  assert.equal(r.displayUsage, "separate");
});

test("resolveDelegate: boolean false shorthand", () => {
  const r = resolveDelegate({ delegate: false });
  assert.equal(r.enabled, false);
  assert.equal(r.displayUsage, "separate");
});

test("resolveDelegate: object with enabled + displayUsage", () => {
  const r = resolveDelegate({ delegate: { enabled: false, displayUsage: "merged" } });
  assert.equal(r.enabled, false);
  assert.equal(r.displayUsage, "merged");
});

test("resolveDelegate: object with only enabled (displayUsage defaults)", () => {
  const r = resolveDelegate({ delegate: { enabled: true } });
  assert.equal(r.enabled, true);
  assert.equal(r.displayUsage, "separate");
});

test("resolveDelegate: legacy flat displayUsage still works with boolean delegate", () => {
  const r = resolveDelegate({ delegate: true, displayUsage: "merged" });
  assert.equal(r.enabled, true);
  assert.equal(r.displayUsage, "merged");
});

test("resolveDelegate: legacy flat displayUsage still works with undefined delegate", () => {
  const r = resolveDelegate({ displayUsage: "merged" });
  assert.equal(r.enabled, true);
  assert.equal(r.displayUsage, "merged");
});

test("resolveDelegate: object displayUsage takes priority over legacy flat", () => {
  const r = resolveDelegate({ delegate: { displayUsage: "separate" }, displayUsage: "merged" });
  assert.equal(r.displayUsage, "separate");
});

test("resolveCompress returns {} when no compress configured", () => {
  assert.deepEqual(resolveCompress(undefined, "anthropic", "claude"), {});
});

test("resolveCompress falls back to global when provider/model unknown", () => {
  const c = resolveCompress({ maxContextLimit: "75%" }, "unknown", "unknown");
  assert.equal(c.maxContextLimit, "75%");
});

test("resolveCompress provider override wins over global", () => {
  const compress = { maxContextLimit: "75%", providers: { anthropic: { maxContextLimit: "80%" } } };
  assert.equal(resolveCompress(compress, "anthropic", undefined).maxContextLimit, "80%");
  assert.equal(resolveCompress(compress, "openai", undefined).maxContextLimit, "75%");
});

test("resolveCompress model override wins over provider and global", () => {
  const compress = {
    maxContextLimit: "75%",
    providers: { anthropic: { maxContextLimit: "80%", models: { "claude-sonnet-4": { maxContextLimit: "70%" } } } },
  };
  const c = resolveCompress(compress, "anthropic", "claude-sonnet-4");
  assert.equal(c.maxContextLimit, "70%");
});

test("resolveCompress merges per-field (global/provider/model each set a different field)", () => {
  const compress = {
    maxContextLimit: "75%",
    emergencyThresholdPercent: "95%",
    providers: { anthropic: { emergencyThresholdPercent: "90%", models: { "claude-sonnet-4": { nudgeGrowthTokens: 30000 } } } },
  };
  const c = resolveCompress(compress, "anthropic", "claude-sonnet-4");
  assert.equal(c.maxContextLimit, "75%", "global field inherited");
  assert.equal(c.emergencyThresholdPercent, "90%", "provider field inherited");
  assert.equal(c.nudgeGrowthTokens, 30000, "model field applied");
});

test("mergeCompress: undefined deeper field does not clear shallower value", () => {
  const merged = mergeCompress({ maxContextLimit: "75%", nudgeGrowthTokens: 50000 }, { emergencyThresholdPercent: "90%" }, {});
  assert.equal(merged.maxContextLimit, "75%");
  assert.equal(merged.emergencyThresholdPercent, "90%");
  assert.equal(merged.nudgeGrowthTokens, 50000);
});

test("resolveConfig applies provider/model cascade to kernel config", () => {
  const adapter: AdapterConfig = {
    compress: {
      maxContextLimit: "75%",
      providers: { anthropic: { models: { "claude-sonnet-4": { maxContextLimit: "70%", nudgeGrowthTokens: 30000 } } } },
    },
  };
  const cfg = resolveConfig(adapter, 1_000_000, "anthropic", "claude-sonnet-4");
  assert.equal(cfg.nudge.maxContextLimitPct, 0.7, "model-level maxContextLimit wins");
  assert.equal(cfg.nudge.growthFloor, 30000);
  assert.equal(cfg.nudge.growthCap, 30000);
  assert.equal(cfg.nudge.emergencyThresholdPct, 0.95, "unset field inherits kernel default");
});

test("resolveConfig without provider/modelId behaves as before (global only)", () => {
  const cfg = resolveConfig({ compress: { maxContextLimit: "80%" } }, 1_000_000);
  assert.equal(cfg.nudge.maxContextLimitPct, 0.8);
});

test("resolveRepetitionGuard defaults to enabled with warn=3 abort=5", () => {
  const r = resolveRepetitionGuard(EMPTY);
  assert.equal(r.enabled, true);
  assert.equal(r.warn, 3);
  assert.equal(r.abort, 5);
});

test("resolveRepetitionGuard defaults match the exported defaults constant", () => {
  const r = resolveRepetitionGuard(EMPTY);
  assert.equal(r.warn, REPETITION_GUARD_DEFAULTS.warn);
  assert.equal(r.abort, REPETITION_GUARD_DEFAULTS.abort);
});

test("resolveRepetitionGuard boolean false shorthand disables the guard", () => {
  const r = resolveRepetitionGuard({ repetitionGuard: false });
  assert.equal(r.enabled, false);
});

test("resolveRepetitionGuard object with explicit warn/abort", () => {
  const r = resolveRepetitionGuard({ repetitionGuard: { warn: 4, abort: 8 } });
  assert.equal(r.enabled, true);
  assert.equal(r.warn, 4);
  assert.equal(r.abort, 8);
});

test("resolveRepetitionGuard clamps abort to at least warn+1 when misconfigured", () => {
  const r = resolveRepetitionGuard({ repetitionGuard: { warn: 5, abort: 2 } });
  assert.ok(r.abort > r.warn, "abort must be strictly greater than warn");
  assert.equal(r.abort, 6);
});

test("resolveRepetitionGuard falls back for non-positive thresholds", () => {
  const r = resolveRepetitionGuard({ repetitionGuard: { warn: 0, abort: -1 } });
  assert.equal(r.warn, 3);
  assert.equal(r.abort, 5);
});

test("resolveRepetitionGuard keeps custom thresholds while honoring enabled:false", () => {
  const r = resolveRepetitionGuard({ repetitionGuard: { enabled: false, warn: 4, abort: 9 } });
  assert.equal(r.enabled, false);
  assert.equal(r.warn, 4);
  assert.equal(r.abort, 9);
});
