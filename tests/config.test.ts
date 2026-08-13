import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, resolveDelegate, type AdapterConfig } from "../src/config.js";

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

test("resolveConfig defaults to kernel 0.0.21 thresholds when no compress overrides set", () => {
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
