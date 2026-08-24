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

  "throttleRetry": {
    "enabled": true,
    "maxRetries": 10
  },

  "delegate": {
    "enabled": true,
    "displayUsage": "separate"
  },

  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000
  },

  "absorb": {
    "minToolTokens": 1000,
    "contextThresholdPct": 0,
    "excludeTools": ["read"]
  }
}
```

A minimal config enabling only debug logging:

```json
{
  "debug": true
}
```

An advanced config overriding the kernel's compression prompt rules (requires the risk acknowledgement). Set only the fields you want to change; the rest inherit the kernel defaults:

```json
{
  "prompts": {
    "compressPhilosophy": "My compression philosophy...",
    "howToCompressRules": "My tier-1 rules...",
    "tier2DistillRules": "My tier-2 distillation rules...",
    "tier3CondenseRules": "My tier-3 condensation rules..."
  },
  "acknowledgePromptsRisk": true
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
| `throttleRetry` | boolean \| object | `true` | 🟢 ACTIVE | Auto-retry provider token rate-limit errors with progressive backoff. |

**Delegate keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `delegate.enabled` | boolean | `true` | 🟢 ACTIVE | Enable the `acp_delegate` tools and their system-prompt section. |
| `delegate.displayUsage` | string | `"separate"` | 🟢 ACTIVE | Controls how delegate sub-agent token usage is reported. |

**Provider throttle retry keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `throttleRetry.enabled` | boolean | `true` | 🟢 ACTIVE | Enable auto-retry of provider token rate-limit errors. |
| `throttleRetry.maxRetries` | number | `10` | 🟢 ACTIVE | Total budget of ACP-driven retries per error episode. |
| `throttleRetry.baseDelayMs` | number | `60000` | 🟢 ACTIVE | Delay before the first paced kick. |
| `throttleRetry.maxDelayMs` | number | `300000` | 🟢 ACTIVE | Cap for paced kick delays. |
| `throttleRetry.backoffMode` | string | `"exponential"` | 🟢 ACTIVE | Delay progression: `"exponential"` (×2 per kick) or `"fixed"`. |

**Compression keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `compress.maxContextLimit` | number \| string | `"75%"` | 🟢 ACTIVE | Context threshold that triggers forced compression nudges. |
| `compress.emergencyThresholdPercent` | number \| string | `"95%"` | 🟢 ACTIVE | Context threshold that triggers emergency truncation. |
| `compress.nudgeGrowthTokens` | number | `50000` | 🟢 ACTIVE | Token growth step for soft compression nudges. |

**Absorb keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `absorb` | boolean \| object | `false` | 🟢 ACTIVE | `true` enables instant tool-result absorption with defaults; an object tunes it. |
| `absorb.toolName` | string | `"absorb"` | 🟢 ACTIVE | Name of the absorb tool exposed to the model. |
| `absorb.minToolTokens` | number | `1000` | 🟢 ACTIVE | Tool results below this estimated size never get the absorb prompt. |
| `absorb.contextThresholdPct` | number \| string | `0` | 🟢 ACTIVE | Only prompt when context usage is at or above this fraction (`0.3` / `"30%"`); `0` = size alone decides. |
| `absorb.excludeTools` | string[] | `[]` | 🟢 ACTIVE | Tool names whose results are never absorbable. |

**Prompts keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `prompts` | object | *(kernel defaults)* | 🟢 ACTIVE | Override acp-kernel's 4 load-bearing compression prompt rules. Each set field replaces the default verbatim. |
| `acknowledgePromptsRisk` | boolean | `false` | 🟢 ACTIVE | Must be `true` for `prompts` overrides to take effect; otherwise overrides are dropped and defaults are used. |

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

## Absorb

The `absorb` sub-object enables **instant tool-result compression** — designed for small-context setups (e.g. a 10K–20K window) where waiting for a regular compression nudge starves the model of working room. Tool calls are the biggest context consumer; absorption makes the model pay that cost back immediately after every large tool result.

How it works:

1. When a tool result is large enough (≥ `absorb.minToolTokens` estimated tokens) and not excluded/protected, a forced `[ACP absorb]` instruction is appended to it: the model must immediately call the `absorb` tool with the result's ref and a distilled summary.
2. Once absorbed, the original tool-call + tool-result pair is **hidden from all later turns**; the `absorb` call (carrying your summary) becomes the durable record.
3. `absorb` calls are ordinary tool calls — the regular compression system can fold them into blocks later, so the two mechanisms stay orthogonal.

Shorthand forms (like `delegate`): `absorb: true` enables with defaults; an object tunes it.

### `absorb.minToolTokens`

- **Type:** `number`
- **Default:** `1000`
- **Status:** 🟢 ACTIVE
- **Description:** Tool results estimated below this many tokens never get the absorb prompt. Keep it high enough that only genuinely bulky outputs demand a distill step.

### `absorb.contextThresholdPct`

- **Type:** `number | string`
- **Default:** `0`
- **Status:** 🟢 ACTIVE
- **Description:** Only append absorb prompts when context usage is at or above this fraction of the window (`0.3` or `"30%"`). With the default `0`, size alone decides — every qualifying result is absorbed immediately, which is what small-context setups want.

### `absorb.excludeTools`

- **Type:** `string[]`
- **Default:** `[]`
- **Status:** 🟢 ACTIVE
- **Description:** Tool names whose results are never absorbable. ACP's own tool results (`compress`, `decompress`, `search_context`, `acp_status`, …) and protected tools are always excluded automatically.

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

## Provider Throttle Retry

The `throttleRetry` key controls auto-retry of **provider-side token rate-limit errors** — e.g. AWS Bedrock's per-minute token-throughput quota, whose standard error text is `"Too many tokens, please wait before trying again."` When the relay streams that error as content with a non-standard `finish_reason`, it surfaces to Pi as `Provider finish_reason: error_finish` and fails the turn immediately: Pi's built-in retry does not recognize the signature, and it must not be treated as context overflow.

How it works:

1. When a turn ends in a recognized throttle error, ACP rewrites the error so Pi's **native retry** re-runs the same turn (no duplicate user message, the error is kept out of the LLM context, native TUI retry indicator). Pi's native budget is small and fast (3 attempts, 2s base).
2. When a run still ends in a throttle error and ACP's budget allows, ACP waits a **progressive delay** (default: 60s, 120s, 240s, … capped at 5 minutes), then sends one auto-marked user message (starts with `[ACP:provider-throttle]`) that resumes the interrupted step.
3. The model is instructed to resume where it left off (system-prompt note). Sending new input during a wait **cancels** the pending retry. When the budget is exhausted, the error is surfaced to you unchanged.

> **Not retried** (deliberately left to Pi's own behavior or to fail-fast): real context-overflow errors (`prompt is too long`, …), quota/billing exhaustion (`quota exceeded`, `billing`, …), and generic 429s.

> **Strict pacing (optional):** By default ACP lets Pi's native fast retries run first and then paces on its own. If you want *only* ACP's paced kicks (e.g. a very tight tokens/minute quota), additionally set Pi's own retry off via `"retry": { "enabled": false }` in `~/.pi/settings.json`.

### `throttleRetry`

- **Type:** `boolean | object`
- **Default:** `true` (object form with all defaults)
- **Status:** 🟢 ACTIVE
- **Description:** Enable/disable auto-retry of provider token rate-limit errors and tune its budget. `throttleRetry: false` disables the feature entirely. Object form (any subset):

```json
{
  "throttleRetry": {
    "enabled": true,
    "maxRetries": 10,
    "baseDelayMs": 60000,
    "maxDelayMs": 300000,
    "backoffMode": "exponential"
  }
}
```

### `throttleRetry.enabled`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** 🟢 ACTIVE
- **Description:** Turn the feature on/off. `false` (or top-level `throttleRetry: false`) restores the original fail-fast behavior.

### `throttleRetry.maxRetries`

- **Type:** `number` (integer ≥ 1)
- **Default:** `10`
- **Status:** 🟢 ACTIVE
- **Description:** Total budget of ACP-driven retries for one error episode (a run ending in the same throttle error, plus the paced kicks it triggers). Any successful non-error response — or a new user message — starts a fresh episode. Exhausted → the error is surfaced to you as-is.

### `throttleRetry.baseDelayMs`

- **Type:** `number` (milliseconds)
- **Default:** `60000`
- **Status:** 🟢 ACTIVE
- **Description:** Delay before the first paced kick — sized for Bedrock's per-minute rolling quota window. `maxDelayMs` is forced to at least this value.

### `throttleRetry.maxDelayMs`

- **Type:** `number` (milliseconds)
- **Default:** `300000`
- **Status:** 🟢 ACTIVE
- **Description:** Cap for paced kick delays in `"exponential"` mode (60s → 120s → 240s → 300s → 300s … with defaults). Ignored in `"fixed"` mode, which always uses `baseDelayMs`.

### `throttleRetry.backoffMode`

- **Type:** string enum `"exponential" | "fixed"`
- **Default:** `"exponential"`
- **Status:** 🟢 ACTIVE
- **Description:** Delay progression between paced kicks: `"exponential"` doubles the delay per kick (capped at `maxDelayMs`); `"fixed"` repeats `baseDelayMs` every kick.

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

### `compress.providers` — per-provider & per-model overrides

- **Type:** object — a map of provider name → `{ ...<compress fields>, models: { modelId → <compress fields> } }`
- **Default:** *(unset — global `compress.*` applies to all models)*
- **Status:** 🟢 ACTIVE
- **Description:** Narrows the global thresholds for a specific Pi **provider** and/or a specific **model**, resolved live each turn from the active model. The three levels cascade **per-field, deepest-wins**: `model > provider > global`. A field left undefined at a deeper level does **not** clear a shallower value — only a field you actually set overrides. Unknown providers/models fall back to the global thresholds.

The provider key is the **Pi provider name** (e.g. `"anthropic"`, `"openai"`, `"zhipu"`) — the same name used in `models.json` and `pi --provider`. The model key is the **model id** (`ctx.model.id`). The adapter sits at Pi's model layer and never sees the upstream URL, so it matches providers by **name**, not by URL prefix like the billion-context proxy does.

```json
{
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000,
    "providers": {
      "anthropic": {
        "maxContextLimit": "80%",
        "models": {
          "claude-sonnet-4-5": { "maxContextLimit": "70%", "nudgeGrowthTokens": 30000 }
        }
      }
    }
  }
}
```

On `anthropic` / `claude-sonnet-4-5` the effective thresholds become `maxContextLimit=70%`, `nudgeGrowthTokens=30000`, and `emergencyThresholdPercent=95%` (inherited from global).

---

## Prompts Customization

The `prompts` object overrides acp-kernel's **load-bearing** compression prompt rules — the verbatim instructions the model receives about *how* to write summaries (keep full file paths, function signatures, decisions and rationale; drop verbose logs, etc.). These four fields are embedded into the system prompt and the compression nudge text:

| Field | What it governs |
|-------|-----------------|
| `compressPhilosophy` | The two failure modes to avoid (over-/under-compression) and the single test for when to compress. |
| `howToCompressRules` | Tier-1 rules: what to KEEP verbatim vs DROP, and the summary priority order. |
| `tier2DistillRules` | Tier-2 distillation rules (decisions/outcomes only). |
| `tier3CondenseRules` | Tier-3 ultra-condensation rules (bare facts). |

> ⚠️ **Quality risk.** These rules are tuned for retrieval quality. Replacing them with looser text can silently degrade summaries — lost paths, signatures, and decisions lead to worse reconstruction later. The `acknowledgePromptsRisk` gate exists to make this an explicit, deliberate choice.

### `prompts`

- **Type:** `object` (partial — omit fields to keep their defaults)
- **Default:** *(kernel defaults)* — the verbatim rules shipped with acp-kernel
- **Status:** 🟢 ACTIVE
- **Description:** Override one or more of the four compression prompt fields. Each field you set replaces the kernel default **verbatim**; fields you omit are inherited unchanged. Non-string values are silently dropped (only deliberate string overrides apply). Requires `acknowledgePromptsRisk: true` — without it, every override is dropped and the defaults are used, with a warning logged. Example:

  ```json
  {
    "prompts": {
      "compressPhilosophy": "Compress aggressively; prefer signal over completeness.",
      "howToCompressRules": "Keep file paths + signatures verbatim. Drop verbose logs.",
      "tier2DistillRules": "Decisions and outcomes only; drop process and paths.",
      "tier3CondenseRules": "One line per block: bare facts only."
    },
    "acknowledgePromptsRisk": true
  }
  ```

### `acknowledgePromptsRisk`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** 🟢 ACTIVE
- **Description:** The safety gate for `prompts` overrides. Set to `true` to acknowledge that replacing the kernel's tuned compression rules may reduce summary quality, and to make your `prompts` overrides take effect. When `false` (or omitted), all `prompts` overrides are ignored and the kernel defaults are used. If `resolvePrompts` rejects your override (for example a malformed value that still passes the type check), the extension falls back to the defaults and logs a `prompts-resolve-failed` warning rather than failing to start.

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
