# Configuration

[English](./CONFIGURATION.md) | [中文](./CONFIGURATION.zh-CN.md)

**billion-context-pi** works out of the box with no configuration — it reads your model's context window automatically and applies sensible defaults. This document is the complete reference for the optional JSON configuration file (`acp.json`) and the environment variables that let you tune behavior.

Configuration is layered: environment variables take the highest precedence, followed by the project config file, then the global config file, and finally the built-in defaults.

---

## Config file locations

Settings are read from JSON files named `acp.json`. The global file applies to every project; a project file overrides the global one on a **per-field** basis (individual keys you do not set in the project file still fall back to the global value).

| Scope | Path | Applies to |
|-------|------|------------|
| **Global** | `~/.pi/acp.json` | All projects on this machine |
| **Project** | `<project>/.pi/acp.json` | The current project only (overrides global per-field) |

> **Precedence:** Environment variable &gt; Project file &gt; Global file &gt; Built-in default.

Files are loaded at session start. Missing files, malformed JSON, and unknown keys are silently ignored — the extension never fails to start because of a config issue. Only the documented keys are read; everything else is discarded.

---

## Quick start

Create `~/.pi/acp.json` (or `<project>/.pi/acp.json`) and drop in whichever keys you want to change. Every field below is optional — omit a key to keep its default.

```json
{
  "debug": false,
  "autoUpdate": true,
  "modelContextLimit": 200000,
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000,

  "delegate": {
    "enabled": true,
    "displayUsage": "separate"
  },

  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000
  }
}
```

A minimal config enabling only debug logging:

```json
{
  "debug": true
}
```

---

## Parameter Reference

### Status legend

| Status | Meaning |
|--------|---------|
| 🟢 **ACTIVE** | Fully supported, documented, and recommended for use. |

All keys below are currently **ACTIVE**.

### Summary

**Top-level keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `debug` | boolean | `false` | 🟢 ACTIVE | Enable verbose debug-level events in the log. |
| `autoUpdate` | boolean | `true` | 🟢 ACTIVE | Check npm for a newer version on startup and auto-install it. |
| `modelContextLimit` | number | *(auto)* | 🟢 ACTIVE | Override the context limit (in tokens). |
| `toolBashDefaultTimeout` | number | `60` | 🟢 ACTIVE | Default `bash` tool timeout in seconds when the model omits it. |
| `toolOutputMaxBytes` | number | `200000` | 🟢 ACTIVE | Hard byte cap on tool result text. |

**Delegate keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `delegate.enabled` | boolean | `true` | 🟢 ACTIVE | Enable the `acp_delegate` tools and their system-prompt section. |
| `delegate.displayUsage` | string | `"separate"` | 🟢 ACTIVE | Controls how delegate sub-agent token usage is reported. |

**Compression keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `compress.maxContextLimit` | number \| string | `"75%"` | 🟢 ACTIVE | Context threshold that triggers forced compression nudges. |
| `compress.emergencyThresholdPercent` | number \| string | `"95%"` | 🟢 ACTIVE | Context threshold that triggers emergency truncation. |
| `compress.nudgeGrowthTokens` | number | `50000` | 🟢 ACTIVE | Token growth step for soft compression nudges. |

**Environment variables**

| Variable | Effect |
|----------|--------|
| `ACP_AUTO_UPDATE` | Set to `0` / `false` to disable auto-update (overrides `autoUpdate`). |
| `ACP_MODEL_CONTEXT_LIMIT` | Override the context limit (takes highest precedence). |
| `ACP_DEBUG` | Set to `1` / `true` to enable debug logging. |
| `ACP_LOG_FILE` | Override the log file path (default `~/.pi/acp.log`). |

> **Only the documented keys are read from `acp.json`.** Other tuning knobs (`preserveRecentMessages`, `protectedTools`) are code-level and not user-overridable. The three compression thresholds form a three-tier escalation: growth-driven soft nudges → forced nudges at `compress.maxContextLimit` → emergency truncation at `compress.emergencyThresholdPercent`.

---

## General

### `debug`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** 🟢 ACTIVE
- **Description:** Enable verbose **debug-level** events in the log file (default `~/.pi/acp.log`). The always-on log (session/turn/compress/delegate lifecycle events, all errors and warnings) is written regardless of this setting; `debug` only adds extra diagnostics such as full field dumps and per-turn internals. Also enabled by the environment variable `ACP_DEBUG=1` (or `ACP_DEBUG=true`).

### `autoUpdate`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** 🟢 ACTIVE
- **Description:** On Pi startup, check the npm registry for a newer version of `billion-context-pi` and auto-install it. Set to `false` to avoid all startup network calls. Can also be disabled via the `ACP_AUTO_UPDATE` environment variable (`ACP_AUTO_UPDATE=0` or `ACP_AUTO_UPDATE=false`), which overrides this setting.

### `modelContextLimit`

- **Type:** `number`
- **Default:** *(auto)* — the model's `contextWindow` read live each turn
- **Status:** 🟢 ACTIVE
- **Description:** Override the context limit, in tokens. By default the limit is read from the active model's `ctx.model.contextWindow` on every turn, so it stays correct when you switch models. Set an explicit value for deterministic test runs or headless/non-interactive sessions where the model metadata may be unavailable. The `ACP_MODEL_CONTEXT_LIMIT` environment variable takes precedence over this value.

### `toolBashDefaultTimeout`

- **Type:** `number`
- **Default:** `60`
- **Status:** 🟢 ACTIVE
- **Description:** The number of seconds injected into the `bash` tool when the model omits the `timeout` parameter. Pi has **no** built-in default timeout of its own, so without this guard a command the model forgets to time out can hang for thousands of seconds. On timeout the model is guided to re-run the command with a larger `timeout`. Set to `0` to disable this guard and restore Pi's unbounded behavior.

### `toolOutputMaxBytes`

- **Type:** `number`
- **Default:** `200000`
- **Status:** 🟢 ACTIVE
- **Description:** A hard byte cap (~200 KB, roughly 5000 lines) applied to tool result text via the `tool_result` hook. It stops runaway output that Pi's own caps cannot catch (for example, from tools Pi does not cap). When the cap fires, the oversized text is head-truncated with a notice telling the model how to see the full output. Set lower (e.g. `8192`) for a tighter context budget, or set to `0` to disable the cap entirely.

---

## Delegate

The `delegate` sub-object controls the `acp_delegate` sub-agent tool family (`acp_delegate`, `acp_delegate_wait`, `acp_delegate_cancel`) and how their token usage is reported.

> **Backward compatibility:** For convenience, `delegate` accepts both an object and a boolean shorthand:
> - `delegate: true` is treated as `delegate: { enabled: true }`.
> - The legacy flat top-level `displayUsage` key is still accepted as an alias for `delegate.displayUsage`. Prefer the nested `delegate.displayUsage` form.

### `delegate.enabled`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** 🟢 ACTIVE
- **Description:** Enable the `acp_delegate` tools (`acp_delegate`, `acp_delegate_wait`, `acp_delegate_cancel`) and the system-prompt section that describes them. Set to `false` to skip registering them entirely — for example, if you use a different sub-agent extension, or when running headless where async result injection adds no value.

### `delegate.displayUsage`

- **Type:** string enum `"merged" | "separate"`
- **Default:** `"separate"`
- **Status:** 🟢 ACTIVE
- **Description:** Controls how delegate sub-agent token usage is reported back to the main session. `"separate"` (default) tracks delegate tokens in a separate accumulator — the main session totals stay clean and delegate usage shows as its own block in `acp_status` (excluded from main totals). `"merged"` folds delegate token usage into the tool-result `usage` field so it is counted as part of the main session totals. Only meaningful when `delegate.enabled` is `true`.

---

## Compression Tuning

The `compress` sub-object groups the three thresholds that form a **three-tier escalation** for context management. They control *when* the model is nudged to compress and *when* large outputs are forcibly truncated to keep the session alive. Lower thresholds mean the extension compresses earlier and more aggressively.

The flow is:

1. **Growth-driven soft nudges** (0–75%) — governed by `compress.nudgeGrowthTokens`.
2. **Forced nudges** (75–95%) — once usage crosses `compress.maxContextLimit`, nudges fire regardless of the growth gate. These are lossless.
3. **Emergency truncation** (95%+) — once usage crosses `compress.emergencyThresholdPercent`, large tool outputs are truncated to prevent context overflow. This is lossy.

### `compress.maxContextLimit`

- **Type:** `number | string`
- **Default:** `0.75` (or `"75%"`)
- **Status:** 🟢 ACTIVE
- **Description:** The context-usage threshold that triggers **forced compression** nudges. Once usage reaches this level, nudges fire on every turn, bypassing the growth-gate and cadence checks that normally throttle them. Accepts a ratio (`0.75`) or a percent string (`"75%"`). A lower value makes the extension compress earlier and more aggressively. Maps to the kernel setting `nudge.maxContextLimitPct`.

### `compress.emergencyThresholdPercent`

- **Type:** `number | string`
- **Default:** `0.95` (or `"95%"`)
- **Status:** 🟢 ACTIVE
- **Description:** The context-usage threshold that triggers **emergency truncation** of large tool outputs to keep the session alive when context is nearly full. Accepts a ratio (`0.95`) or a percent string (`"95%"`). This value **must be greater than or equal to** `compress.maxContextLimit`, otherwise the escalation order breaks. Maps to the kernel settings `nudge.emergencyThresholdPct` and `truncate.threshold`.

### `compress.nudgeGrowthTokens`

- **Type:** `number`
- **Default:** `50000`
- **Status:** 🟢 ACTIVE
- **Description:** The token-growth threshold that controls the cadence of **soft** compression nudges. A soft nudge fires roughly every time this many tokens of new compressible content accumulate. A lower value means the model is nudged to compress more often; a higher value means less frequent nudges. This only governs *growth-driven* nudges — once usage crosses `compress.maxContextLimit`, forced nudges take over regardless of this setting. Maps to the kernel settings `nudge.growthFloor` and `nudge.growthCap`.

---

## Environment Variables

Environment variables take precedence over the JSON config files. They are useful for one-off overrides, CI runs, and headless sessions where you want to avoid editing config files.

### `ACP_AUTO_UPDATE`

- **Type:** string flag
- **Default:** *(unset — auto-update follows the `autoUpdate` config)*
- **Status:** 🟢 ACTIVE
- **Description:** Set to `0` or `false` to **disable** auto-update (same effect as `"autoUpdate": false`). Leave unset to honor the config. This is the recommended way to disable startup network calls in locked-down environments without modifying `acp.json`.

### `ACP_MODEL_CONTEXT_LIMIT`

- **Type:** integer (tokens)
- **Default:** *(unset — limit follows `modelContextLimit`, then the live model context window)*
- **Status:** 🟢 ACTIVE
- **Description:** Override the context limit, in tokens. **Takes the highest precedence** — overrides the `modelContextLimit` config value. Useful for forcing a specific limit in test harnesses and headless runs where model metadata is unavailable or unreliable.

### `ACP_DEBUG`

- **Type:** string flag
- **Default:** *(unset — debug logging follows the `debug` config)*
- **Status:** 🟢 ACTIVE
- **Description:** Set to `1` or `true` to enable debug-level logging. Equivalent to setting `"debug": true` in the config, but applied without editing a file. The always-on lifecycle/error/warning events are written regardless.

### `ACP_LOG_FILE`

- **Type:** string (file path)
- **Default:** `~/.pi/acp.log`
- **Status:** 🟢 ACTIVE
- **Description:** Override the path to the log file. By default, structured logs are written to `~/.pi/acp.log` (the file rotates to `~/.pi/acp.log.old` at 10 MB). Point this at a different location to keep per-project or per-run logs separate.
