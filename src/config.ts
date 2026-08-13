import { defaultConfig, type Config } from "acp-kernel";

declare module "acp-kernel" {
  interface Config {
    usageTriggerPercent?: number;
  }
}

/** Delegate sub-agent configuration. */
export interface DelegateConfig {
  /** Enable acp_delegate tools (delegate/wait/cancel) and their system-prompt
   *  section. Default: true. Set `enabled: false` to skip registering them. */
  enabled?: boolean;
  /** How delegate usage is reported back to the main session.
   *  "separate" (default) — delegate tokens tracked in a separate accumulator;
   *  main session totals stay clean, delegate usage shows as its own block in
   *  acp_status (excluded from main totals).
   *  "merged" — delegate token usage folded into the tool-result usage field,
   *  counted as part of the main session totals. */
  displayUsage?: "merged" | "separate";
}

/** Compression tuning. All fields accept a ratio (0.75) or percent string
 *  ("75%") where noted. */
export interface CompressConfig {
  /** Context usage percentage that triggers forced compression nudges
   *  (bypasses growth-gate + cadence). Accepts a ratio (0.75) or percent
   *  string ("75%"). Default: 0.75. Maps to kernel nudge.maxContextLimitPct. */
  maxContextLimit?: number | string;
  /** Context usage percentage that triggers emergency truncation of large
   *  tool outputs. Accepts a ratio (0.95) or percent string ("95%").
   *  Default: 0.95. Must be >= maxContextLimit. Maps to kernel
   *  nudge.emergencyThresholdPct + truncate.threshold. */
  emergencyThresholdPercent?: number | string;
  /** Token growth threshold for soft compression nudges. Default: 50000.
   *  Maps to kernel nudge.growthFloor + nudge.growthCap. */
  nudgeGrowthTokens?: number;
}

/** Delegate sub-agent configuration. */

/**
 * Adapter configuration. Maps onto acp-kernel's `Config` plus Pi-specific knobs
 * (live model context window, protected tools, state persistence).
 */
export interface AdapterConfig {
  /** When omitted, the adapter reads `ctx.model.contextWindow` live each turn.
   *  Set explicitly for tests/headless runs. */
  modelContextLimit?: number;
  protectedTools?: string[];
  preserveRecentMessages?: number;
  /** Check npm for a newer billion-context-pi on startup and auto-install it. Default: true.
   *  Disable via `autoUpdate: false` or env `ACP_AUTO_UPDATE=0` to avoid all
   *  network calls on startup. */
  autoUpdate?: boolean;
  /** Enable debug-level events in the ACP log file (default ~/.pi/acp.log).
   *  Always-on events (session/turn/compress/delegate lifecycle, all errors and
   *  warnings) are written regardless; `debug` only adds verbose diagnostics.
   *  Default: false (or env ACP_DEBUG=1/true). */
  debug?: boolean;
  /** Default timeout in seconds injected into the bash tool when the model
   *  omits `timeout`. Pi has NO built-in default, so without this a command
   *  that the model forgets to time out can hang for thousands of seconds.
   *  Default: 60 (catches hangs quickly). On timeout the model is guided to
   *  re-run with a larger `timeout`. Set to 0 to disable (restore Pi's
   *  unbounded behavior). */
  toolBashDefaultTimeout?: number;
  /** Hard byte cap applied to tool result text via the `tool_result` hook.
   *  Default: 200000 (~200KB, roughly 5000 lines at ~40 bytes/line) — a
   *  generous ceiling that stops runaway output. Pi already caps bash/read/grep
   *  at 50KB/2000 lines (bash full output is saved to a temp file), so this
   *  default mainly caps tools Pi doesn't cap. Set lower (e.g. 8192) for a
   *  tighter context budget, or 0 to disable. When capped, oversized text is
   *  head-truncated with a notice telling the model how to see the full output
   *  (bash: read BashToolDetails.fullOutputPath). */
  toolOutputMaxBytes?: number;
  /** 工具输出清洗（去重 + 去噪），仅作用于 bash 工具结果。默认 true。
   *  规则保守：只折叠无缩进、非代码锚的重复行（日志/警告模板），
   *  代码类输出（缩进行、`{};` 锚行）完全豁免。设为 false 关闭。 */
  toolOutputClean?: boolean;
  /** 上下文水位触发压缩提示的百分比（0-100）。kernel 默认 growth 驱动，
   *  此配置让 usage 达到该水位即提示压缩。默认 25。设为 0 禁用。 */
  usageTriggerPercent?: number;
  /** 界面语言（slash 命令输出 / nudge 附加文本）："zh" | "en"，缺省按 LANG 检测 */
  language?: "zh" | "en";
  /** Delegate sub-agent config. Accepts a boolean shorthand (`true` →
   *  `{ enabled: true }`, `false` → `{ enabled: false }`) or a DelegateConfig
   *  object. Default: enabled. */
  delegate?: boolean | DelegateConfig;
  /** Compression tuning. */
  compress?: CompressConfig;
  /** Legacy flat alias for `delegate.displayUsage`. Kept for backward
   *  compatibility with existing acp.json files. Prefer `delegate.displayUsage`. */
  displayUsage?: "merged" | "separate";
  coreOverrides?: Partial<Config>;
}

export const DEFAULT_TOOL_BASH_TIMEOUT = 60;
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 200_000;
export const DEFAULT_TOOL_OUTPUT_CLEAN = true;

/** Resolve delegate config from the adapter, handling the boolean shorthand
 *  and the legacy flat `displayUsage` alias. */

/** Resolve delegate config from the adapter, handling the boolean shorthand
 *  and the legacy flat `displayUsage` alias. */
export function resolveDelegate(adapter: AdapterConfig): { enabled: boolean; displayUsage: "merged" | "separate" } {
  const d = adapter.delegate;
  if (typeof d === "object" && d !== null) {
    return {
      enabled: d.enabled !== false,
      displayUsage: d.displayUsage ?? adapter.displayUsage ?? "separate",
    };
  }
  return {
    enabled: d !== false,
    displayUsage: adapter.displayUsage ?? "separate",
  };
}

export function resolveConfig(adapter: AdapterConfig, liveContextLimit: number): Config {
  const envLimit = process.env.ACP_MODEL_CONTEXT_LIMIT;
  const envLimitNum = envLimit ? Number(envLimit) : NaN;
  const FALLBACK_LIMIT = 150_000;
  const limit =
    !Number.isNaN(envLimitNum) && envLimitNum > 0
      ? envLimitNum
      : adapter.modelContextLimit && adapter.modelContextLimit > 0
        ? adapter.modelContextLimit
        : liveContextLimit > 0
          ? liveContextLimit
          : FALLBACK_LIMIT;
  const config = defaultConfig(limit, {
    protectedTools: adapter.protectedTools ?? [],
    preserveRecentMessages: adapter.preserveRecentMessages ?? 5,
    ...adapter.coreOverrides,
...(adapter.usageTriggerPercent !== undefined
      ? { usageTriggerPercent: adapter.usageTriggerPercent }
      : {}),
    ...(adapter.language !== undefined ? { language: adapter.language } : {}),
  });
  const c = adapter.compress;
  if (c?.maxContextLimit !== undefined) config.nudge.maxContextLimitPct = parsePercent(c.maxContextLimit);
  if (c?.emergencyThresholdPercent !== undefined) {
    const pct = parsePercent(c.emergencyThresholdPercent);
    config.nudge.emergencyThresholdPct = pct;
    config.truncate.threshold = pct;
  }
  if (c?.nudgeGrowthTokens !== undefined) {
    config.nudge.growthFloor = c.nudgeGrowthTokens;
    config.nudge.growthCap = c.nudgeGrowthTokens;
  }
  return config;
}

export function parsePercent(v: number | string): number {
  if (typeof v === "number") return v;
  const s = v.trim();
  if (s.endsWith("%")) return Number(s.slice(0, -1)) / 100;
  return Number(s);
}
