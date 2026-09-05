import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, resolveCompress, mergeCompress, resolveDelegate, type AdapterConfig } from "../src/config.js";

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

test("resolveDelegate: maxConcurrent resolves from object form", () => {
  const r = resolveDelegate({ delegate: { enabled: true, maxConcurrent: 3 } });
  assert.equal(r.enabled, true);
  assert.equal(r.maxConcurrent, 3);
});

test("resolveDelegate: maxConcurrent absent resolves to unlimited", () => {
  const r = resolveDelegate({ delegate: { enabled: true } });
  assert.equal(r.maxConcurrent, Infinity);
});

test("resolveDelegate: boolean shorthand leaves maxConcurrent unlimited", () => {
  const r = resolveDelegate({ delegate: true });
  assert.equal(r.maxConcurrent, Infinity);
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

// ─── #279: configurable maxDepth + timeouts ─────────────────────────────────

test("resolveDelegate: maxDepth + timeouts default to 2 / 5m / 5m / 30m", () => {
  const r = resolveDelegate({});
  assert.equal(r.maxDepth, 2);
  assert.equal(r.syncTimeoutMs, 5 * 60_000);
  assert.equal(r.idleMs, 5 * 60_000);
  assert.equal(r.asyncTimeoutMs, 30 * 60_000);
});

test("resolveDelegate: custom maxDepth + timeouts (minutes → ms)", () => {
  const r = resolveDelegate({ delegate: { maxDepth: 1, syncTimeoutMinutes: 10, idleTimeoutMinutes: 7.5, asyncTimeoutMinutes: 120 } });
  assert.equal(r.maxDepth, 1);
  assert.equal(r.syncTimeoutMs, 10 * 60_000);
  assert.equal(r.idleMs, 450_000);
  assert.equal(r.asyncTimeoutMs, 120 * 60_000);
});

test("resolveDelegate: 0/null disables a timeout, others keep defaults", () => {
  const r = resolveDelegate({ delegate: { syncTimeoutMinutes: 0, idleTimeoutMinutes: null, asyncTimeoutMinutes: 90 } });
  assert.equal(r.syncTimeoutMs, null);
  assert.equal(r.idleMs, null);
  assert.equal(r.asyncTimeoutMs, 90 * 60_000);
});

test("resolveDelegate: invalid numeric values fall back to defaults", () => {
  const r = resolveDelegate({ delegate: { maxDepth: 0, syncTimeoutMinutes: -5, idleTimeoutMinutes: Number.NaN } });
  assert.equal(r.maxDepth, 2);
  assert.equal(r.syncTimeoutMs, 5 * 60_000);
  assert.equal(r.idleMs, 5 * 60_000);
});

const DELEGATE_ENV_KEYS = [
  "PI_ACP_DELEGATE_MAX_DEPTH",
  "PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES",
  "PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES",
  "PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES",
  "PI_ACP_DELEGATE_MAX_CONCURRENT",
] as const;

function withDelegateEnv(mutate: (env: NodeJS.ProcessEnv) => void, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of DELEGATE_ENV_KEYS) saved[k] = process.env[k];
  try {
    mutate(process.env);
    fn();
  } finally {
    for (const k of DELEGATE_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

test("resolveDelegate: env overrides acp.json; unset env falls back to config", () => {
  withDelegateEnv(
    (env) => {
      env.PI_ACP_DELEGATE_MAX_DEPTH = "1";
      env.PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES = "0";
    },
    () => {
      const r = resolveDelegate({ delegate: { maxDepth: 5, asyncTimeoutMinutes: 120 } });
      assert.equal(r.maxDepth, 1, "env beats config");
      assert.equal(r.asyncTimeoutMs, null, "env 0 disables");
    },
  );
  const r2 = resolveDelegate({ delegate: { maxDepth: 5, asyncTimeoutMinutes: 120 } });
  assert.equal(r2.maxDepth, 5, "config used when env unset");
  assert.equal(r2.asyncTimeoutMs, 120 * 60_000);
});

test("resolveDelegate: invalid env values fall back without failing", () => {
  let r!: ReturnType<typeof resolveDelegate>;
  withDelegateEnv(
    (env) => {
      env.PI_ACP_DELEGATE_MAX_DEPTH = "abc";
      env.PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES = "-3";
      env.PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES = "1.5x";
    },
    () => {
      r = resolveDelegate({ delegate: { syncTimeoutMinutes: 8 } });
    },
  );
  assert.equal(r.maxDepth, 2, "invalid env maxDepth → default");
  assert.equal(r.syncTimeoutMs, 5 * 60_000, "invalid env timeout → default (not config)");
  assert.equal(r.idleMs, 5 * 60_000, "invalid env idle → default");
});

test("resolveDelegate: maxConcurrent env > acp.json > unlimited, invalid env falls to config", () => {
  withDelegateEnv(
    (env) => {
      delete env.PI_ACP_DELEGATE_MAX_CONCURRENT;
    },
    () => {
      assert.equal(resolveDelegate({ delegate: { maxConcurrent: 3 } }).maxConcurrent, 3, "config when env unset");
      process.env.PI_ACP_DELEGATE_MAX_CONCURRENT = "5";
      assert.equal(resolveDelegate({ delegate: { maxConcurrent: 3 } }).maxConcurrent, 5, "env beats config");
      process.env.PI_ACP_DELEGATE_MAX_CONCURRENT = "not-a-number";
      assert.equal(resolveDelegate({ delegate: { maxConcurrent: 3 } }).maxConcurrent, 3, "invalid env falls to config");
      process.env.PI_ACP_DELEGATE_MAX_CONCURRENT = "0";
      assert.equal(resolveDelegate({ delegate: { maxConcurrent: 2 } }).maxConcurrent, 2, "env < 1 falls to config");
      delete process.env.PI_ACP_DELEGATE_MAX_CONCURRENT;
      assert.equal(resolveDelegate({}).maxConcurrent, Infinity, "no source -> unlimited");
    },
  );
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
