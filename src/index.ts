import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "./config-dir.js";
import { parseAcpJson } from "./user-config.js";
import type { KeyId } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CoreMessage, NudgeDecision, CompressionBlock, Prompts } from "acp-kernel";
import { renderNudgeText, resolvePrompts, defaultPrompts, viableRanges } from "acp-kernel";
import { type AdapterConfig, resolveDelegate, resolveHostSession, DEFAULT_DELEGATE_POLICY } from "./config.js";
import { createRuntime, isPiHost, retryBreakerKey, type AcpRuntime } from "./runtime.js";
import { makeCompressTool, isCompressSuccessText, isCompressNoopText } from "./compress-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeCacheTool } from "./cache-tool.js";
import { makeRuleTool } from "./rule-tool.js";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool, runningRunsSnapshot, resetDelegateUsage, setDelegateDisplayUsage, setDelegatePolicy, setDelegateDefaults, setDelegateNotifyIfRead, markDelegateResultRead, markDelegateRunReadByCommand } from "./delegate-tool.js";
import { makeCommands } from "./commands.js";
import { mergeSurface, readToolSurfaceWithPacks, resolveActivePack, resolvePackName, surfaceMetaOf } from "./prompt-pack.js";
import type { NudgeSectionsConfig } from "./surface.js";
import { coreOutToAgentMessages, extractText } from "./messages.js";
import { liveOnlyTailCached, dropLiveOnlyTailCache } from "./live-only-tail.js";
import { carryHostSystemMessages } from "./system-passthrough.js";
import { sanitizeToolPairing } from "./tool-pair-sanitizer.js";
import { countThinkingChars, dropCompressReasoning } from "./reasoning-drop.js";
import { collapseAssistantDegeneration, degenerationNotice, lastAssistantRuns, resolveDegenerationGuard } from "./degeneration.js";
import { buildAcpSystemPrompt, ACP_DELEGATE_PROMPT } from "./system-prompt.js";
import { delegateStatusWidget } from "./fleet-widget.js";
import { openFleetInspector } from "./fleet-inspector.js";
import { applyStripImages } from "./strip-images.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { debug, logError, logInfo, logWarn, logThrow, closeLogStream } from "./log.js";
import { collectCoveredMessageIds, estimateTokens, collectImageTokens, modelSupportsImages, sentViewTokenCount, sentViewMeterMatches } from "./tokens.js";
import { lastTurnBoundaryId, lastTurnBoundaryIndex } from "./turn-boundary.js";
import { compressionAnchorStaleness } from "./floor-stale.js";
import { checkForUpdate } from "./update.js";
import {
  THROTTLE_RETRY_ERROR_MESSAGE,
  THROTTLE_KICK_TEXT,
  abortableSleep,
  isKickMessage,
  isThrottleError,
  resolveThrottleRetry,
  throttleDelayMs,
} from "./throttle-retry.js";
import { defaultCountTokens } from "acp-kernel";
import { formatSystemPromptForEvent, getSystemPromptText } from "./compat.js";
import { applyOutputHeadroom, inspectOverflowMessage, isNoBody4xxError, resolveOutputHeadroomCap } from "./overflow-selfheal.js";
import { FORK_HOST_WARNING_MESSAGE, UNSUPPORTED_HOST_MESSAGE } from "./omp.js";
import { isDeclaredForkHost, isUnsupportedHost } from "./host.js";
import { isBiliProxyBaseUrl, PROXY_STAND_DOWN_MESSAGE, nativeStandDownMessage } from "./proxy-detect.js";
import { findPiSubagentsInstalls, resolveAgentDir, DELEGATE_STAND_DOWN_MESSAGE } from "./setup-subagent-tools.js";

// Host-facing API for multi-session hosts (docs/host-adapter.md, #367): the
// extension keeps its own runtime instance private; hosts build their own via
// createRuntime — derivation works across instances because it only touches
// on-disk sidecars through session refs.
export { createRuntime } from "./runtime.js";
export type { AcpRuntime, SessionRef } from "./runtime.js";
export { deriveChildState } from "./state.js";

type AgentMessage = SessionMessageEntry["message"];

declare const CURRENT_VERSION: string;

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if (process.env.BILLION_CONTEXT_PROXY) {
      console.log("[bcp] disabled: BILLION_CONTEXT_PROXY detected — proxy handles compression");
      return;
    }
    if (adapter.enabled === false || userConfigDisabled(process.cwd())) {
      console.log("[bcp] disabled: enabled=false — ACP tools and system prompt off; Pi's native context management is in control");
      return;
    }
    const runtime = createRuntime(adapter);
    // Double-compression guards (#296, #461): exactly one side may own
    // compression. Three signals, ALL checked lazily on every event because
    // none can be trusted at factory time:
    //  - BILLION_CONTEXT_PROXY: exported by the `bili <client>` launchers
    //    (inherited by the child), but never set by the standalone-proxy +
    //    manual-wiring path below.
    //  - /bili/ baseUrl prefix: manual wiring (#296) — `bili start` + models.json
    //    baseUrl pointed at http://127.0.0.1:PORT/bili/<scheme>://upstream...
    //    without the env var.
    //  - BILLION_CONTEXT_NATIVE: set synchronously (before any await) by a
    //    host-native entry's module evaluation (billion-context#820/#824) — the
    //    ONLY signal visible in native mode, where the bootstrap writes
    //    BILLION_CONTEXT_PROXY only after the proxy is up (past the synchronous
    //    extension load) and the fetch-layer rewrite keeps the configured
    //    baseUrl clean.
    // The env vars are re-read on every call — an async bootstrap writes them
    // after extensions load, so a one-shot factory read misses them (#461).
    // Checked lazily because ctx.model only exists on events, not in the
    // factory; warn once per process like the OMP refusal.
    let standDownWarned = false;
    const standDownIfProxied = (ctx: ExtensionContext): boolean => {
      const nativeHost = process.env.BILLION_CONTEXT_NATIVE || undefined;
      if (
        nativeHost === undefined &&
        !process.env.BILLION_CONTEXT_PROXY &&
        !isBiliProxyBaseUrl((ctx.model as { baseUrl?: string } | undefined)?.baseUrl)
      ) return false;
      const message = nativeHost !== undefined ? nativeStandDownMessage(nativeHost) : PROXY_STAND_DOWN_MESSAGE;
      runtime.refused = true;
      runtime.refusalMessage = message;
      if (!standDownWarned) {
        standDownWarned = true;
        logWarn("host", { event: nativeHost !== undefined ? "native-host-detected" : "proxy-detected", sid: ctx.sessionManager.getSessionId(), action: "refused", native: nativeHost ?? null });
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.error(message);
      }
      return true;
    };
    wireCompactionDisable(pi, runtime);
    wireDelegateReadTracking(pi);
    wireSessionLifecycle(pi, runtime, standDownIfProxied);
    wireContextTransform(pi, runtime, standDownIfProxied);
    wireBeforeProviderRequest(pi, runtime, standDownIfProxied);
    wireSystemPrompt(pi, runtime);
    wireToolGuardrails(pi, runtime);
    wireOverflowSelfHeal(pi, runtime);
    wireThrottleRetry(pi, runtime);
    const toolSurface = readToolSurfaceWithPacks(process.cwd());
    pi.registerTool(makeCompressTool(runtime, toolSurface.compress));
    pi.registerTool(makeDecompressTool(runtime, toolSurface.decompress));
    pi.registerTool(makeSearchTool(runtime, toolSurface.search_context));
    pi.registerTool(makeStatusTool(runtime, toolSurface.acp_status));
    pi.registerTool(makeCacheTool(runtime, toolSurface.acp_cache));
    for (const { name, options } of makeCommands(runtime, pi)) {
      pi.registerCommand(name, options);
    }
  };
}

export default createAcpExtension();

// Sync factory-time read of the `enabled` master switch: the factory runs at
// extension load, before session_start (where the async loadUserConfig runs),
// so a disabled adapter must be detected here to register nothing at all —
// no tools, no system prompt, no context transform, and no compaction-cancel,
// leaving Pi's native context management in control (issue #250: models too
// small to handle ACP). Project acp.json overrides global; only a literal
// enabled:true/false counts; missing files mean "not disabled", while bad
// files are repaired when possible and otherwise warned about loudly (#467).
function userConfigDisabled(cwd: string): boolean {
  let disabled: boolean | undefined;
  for (const base of [join(homedir(), CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)]) {
    const file = join(base, "acp.json");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // missing file → nothing to say
    }
    // #467: hand-edited configs commonly carry BOM heads, unquoted keys, or
    // trailing commas (Windows notepad defaults). Strict JSON.parse made every
    // one of those silently mean "not disabled" — the exact opposite of the
    // user's intent. parseAcpJson repairs the common shapes and warns loudly
    // on whatever still fails instead of swallowing it.
    const r = parseAcpJson(file, text);
    if (r.status === "failed") {
      console.warn(`[bcp] ${r.reason}`);
      continue;
    }
    if (r.status === "repaired") {
      console.warn(`[bcp] ${r.reason}`);
    }
    if (r.value) {
      const v = r.value.enabled;
      if (v === true || v === false) disabled = v;
      else if (v !== undefined) {
        console.warn(`[bcp] ${file}: enabled must be the literal boolean true/false, got ${JSON.stringify(v)} — ignoring. ACP stays enabled.`);
      }
    }
  }
  return disabled === false;
}

// ACP owns compression; cancel Pi's built-in auto-compaction entirely (mirrors
// opencode-acp requiring opencode's compaction.auto = false). On a refused host
// (OMP) we stand down and let the host compact normally instead.
function wireCompactionDisable(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_before_compact", () => {
    if (runtime.refused) return;
    return { cancel: true };
  });
}

// (acp_delegate injection is best-effort: sendUserMessage is fire-and-forget
// in pi, and interactive/rpc sessions are long-lived so their main loop
// consumes the follow-up queue naturally — no shutdown drain needed.)

// Read-tracking for delegate completion notifications (notifyIfRead: "skip"):
// when the model reads a delegate's result file, mark the run as read so the
// completion notification is skipped if the run finishes after that read.
// Registered once per process; the runs registry is per-process, so delegate
// child processes (nested delegates) track their own runs independently.
function wireDelegateReadTracking(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.isError) return;
    if (event.toolName === "read") {
      const p = (event.input as { path?: unknown }).path;
      if (typeof p === "string") markDelegateResultRead(p);
    } else if (event.toolName === "bash") {
      const cmd = (event.input as { command?: unknown }).command;
      if (typeof cmd === "string") markDelegateRunReadByCommand(cmd);
    }
  });
}

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime, standDownIfProxied: (ctx: ExtensionContext) => boolean): void {
  let ompWarned = false;
  let forkWarned = false;
  let subagentStandDownWarned = false;
  pi.on("session_start", async (_event, ctx) => {
    // Unsupported hosts stand down (#234 / #364): any host without Pi's
    // buildContextEntries() API is refused unless it declared itself a
    // Pi-compatible fork via PI_ACP_FORK_HOST=1. OMP (oh-my-pi) stays blocked
    // by default — its in-process live-entries integration diverges the nudge's
    // example refs from the session's real refs, so compress calls fail with
    // "does not exist in this session". Refuse service and point the user at
    // the fork opt-in or the billion-context proxy. session_start always
    // precedes the first context/before_agent_start event, so setting `refused`
    // here reliably gates every downstream handler for the session.
    if (isUnsupportedHost(ctx.sessionManager)) {
      runtime.refused = true;
      if (!ompWarned) {
        ompWarned = true;
        const sid = ctx.sessionManager.getSessionId();
        logWarn("host", { event: "host-unsupported", sid, action: "refused" });
        if (ctx.hasUI) ctx.ui.notify(UNSUPPORTED_HOST_MESSAGE, "warning");
        else console.error(UNSUPPORTED_HOST_MESSAGE);
      }
      return;
    }
    // Declared fork hosts are admitted with a caveat (#454/#459): live-tail
    // refs are content-stable while the host's view grows append-only; a host
    // that rewrites in-flight messages can still drift them, so warn at
    // admission and point long sessions at the proxy. Log per session (support
    // logs need the attribution), notify once per process like the refusal
    // path above.
    if (isDeclaredForkHost() && !isPiHost(ctx.sessionManager)) {
      const sid = ctx.sessionManager.getSessionId();
      logWarn("host", { event: "fork-host-admitted", sid, hardening: "#459", proxy: "billion-context" });
      if (!forkWarned) {
        forkWarned = true;
        if (ctx.hasUI) ctx.ui.notify(FORK_HOST_WARNING_MESSAGE, "warning");
        else console.error(FORK_HOST_WARNING_MESSAGE);
      }
    }
    if (standDownIfProxied(ctx)) return;
    runtime.store.invalidate();
    runtime.clearNudgeTracking(ctx.sessionManager.getSessionId());
    runtime.throttleFor(ctx.sessionManager.getSessionId()).reset();
    runtime.clearCompressRetryTracking(ctx.sessionManager.getSessionId());
    runtime.dropHostUsageSamples(ctx.sessionManager.getSessionId());
    runtime.dropSizeDivergence(ctx.sessionManager.getSessionId());
    runtime.dropTerminalEscape(ctx.sessionManager.getSessionId());
    runtime.dropTruncationSkipped(ctx.sessionManager.getSessionId());
    runtime.dropSentViewCount(ctx.sessionManager.getSessionId());
    runtime.dropProjectionCache(ctx.sessionManager.getSessionId());
    dropLiveOnlyTailCache(ctx.sessionManager.getSessionId());
    resetDelegateUsage();
    setDelegateDisplayUsage("separate");
    setDelegatePolicy(DEFAULT_DELEGATE_POLICY);
    const sid = ctx.sessionManager.getSessionId();
    // Model identity on every session start: diagnosing "which model loops
    // on compress rejections" from user logs required cwd forensics — the log
    // never said which model it was. id + contextWindow also catch window
    // misconfigurations.
    const modelInfo = ctx.model as { id?: string; contextWindow?: number; api?: string } | undefined;
    logInfo("session", { event: "start", sid, cwd: ctx.cwd, debug: runtime.adapter.debug ?? null, version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null, model: modelInfo?.id ?? null, modelApi: modelInfo?.api ?? null, contextWindow: modelInfo?.contextWindow ?? null });
    let delegateStoodDown = false;
    try {
      await runtime.reloadConfig(ctx.cwd);
      const delegateCfg = resolveDelegate(runtime.adapter);
      setDelegateDisplayUsage(delegateCfg.displayUsage);
      setDelegatePolicy(delegateCfg);
      setDelegateDefaults({ thinkingLevel: delegateCfg.thinkingLevel, agents: delegateCfg.agents });
      setDelegateNotifyIfRead(delegateCfg.notifyIfRead);
      // Third-party subagent overlap guard (#415): pi-subagents ships its own
      // sub-agent system (own fleet checker, spawn path, inspector shortcut —
      // the ctrl+alt+f clash behind #412). Running both fleets confuses the
      // model, and pi-subagents' agents never get ACP compression unless
      // /acp-subagents injects the tools into their overrides. A PROJECT-scope
      // install stands acp_delegate down (tool registration below + system-
      // prompt section) unless delegate.forceEnable opts back in; a USER-scope-
      // only install logs a warning and leaves acp_delegate active, so a global
      // install can't silently disable it in every project. Cheap fs probe once
      // per session — same pattern as the proxy stand down above.
      if (delegateCfg.enabled && !delegateCfg.forceEnable) {
        const scopes = findPiSubagentsInstalls(resolveAgentDir(), ctx.cwd ?? process.cwd());
        if (scopes.project[0] !== undefined) {
          delegateStoodDown = true;
          logWarn("delegate", { event: "delegate-auto-disabled", sid, install: scopes.project[0], scope: "project", hint: "run /acp-subagents to give its agents ACP compression tools; delegate.forceEnable=true keeps acp_delegate" });
          if (!subagentStandDownWarned) {
            subagentStandDownWarned = true;
            if (ctx.hasUI) ctx.ui.notify(DELEGATE_STAND_DOWN_MESSAGE, "warning");
            else console.error(DELEGATE_STAND_DOWN_MESSAGE);
          }
        } else if (scopes.user[0] !== undefined) {
          logWarn("delegate", { event: "delegate-user-scope-detected", sid, install: scopes.user[0], action: "warn-only", hint: "user-level pi-subagents does not disable acp_delegate; run /acp-subagents to give its agents ACP compression tools" });
        }
      }
    } catch (e) {
      logThrow("config", e, { sid, phase: "session_start" });
    }
    runtime.delegateStoodDown = delegateStoodDown;
    try {
      runtime.setPrompts(resolvePrompts(runtime.adapter.prompts, { acknowledgeRisk: runtime.adapter.acknowledgePromptsRisk === true }));
    } catch (e) {
      logWarn("config", { event: "prompts-resolve-failed", error: e instanceof Error ? e.message : String(e) });
      runtime.setPrompts(defaultPrompts);
    }
    const delegatePolicy = resolveDelegate(runtime.adapter);
    if (delegatePolicy.enabled && !runtime.delegateStoodDown) {
      pi.registerTool(makeDelegateTool(pi));
      pi.registerTool(makeDelegateWaitTool(pi));
      pi.registerTool(makeDelegateCancelTool(pi));
      // Not every host implements the full ExtensionAPI surface (older pi,
      // embedded hosts) — shortcuts are a TUI nicety, never load-bearing.
      if (typeof pi.registerShortcut === "function" && delegatePolicy.fleetShortcut !== "") {
        pi.registerShortcut(delegatePolicy.fleetShortcut as KeyId, {
          description: "Inspect acp_delegate runs (live list + transcript)",
          handler: (ctx) => { void openFleetInspector(ctx); },
        });
      }
    }
    // #433: opt-in record tool (default off). Registered here, not at factory
    // load, because the gate is user config applied in reloadConfig above.
    if (runtime.adapter.rules === true) {
      pi.registerTool(makeRuleTool(runtime));
    }
    // Headless hosts exit as soon as the turn ends; awaiting the check keeps
    // the process alive until a running install finishes. TUI stays
    // fire-and-forget so interactive startup is never blocked by npm.
    const updateCheck = checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
    if (!ctx.hasUI) await updateCheck;
    // Bind the TUI status widget for async delegates. The widget reads the
    // in-memory runs Map (via runningRunsSnapshot) and renders a live list of
    // running delegates below the editor. Only the interactive TUI has a UI;
    // rpc/json/print have hasUI=false and the call is a no-op.
    delegateStatusWidget.setContext(ctx, runningRunsSnapshot, delegatePolicy.fleetShortcut);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    runtime.clearDeadCompress(sid);
    runtime.dropTokenScale(sid);
    runtime.clearNudgeTracking(sid);
    runtime.clearCompressRetryTracking(sid);
    runtime.dropHostUsageSamples(sid);
    runtime.dropSizeDivergence(sid);
    runtime.dropTerminalEscape(sid);
    runtime.dropTruncationSkipped(sid);
    runtime.dropSentViewCount(sid);
    runtime.dropProjectionCache(sid);
    dropLiveOnlyTailCache(sid);
    delegateStatusWidget.dispose();
    closeLogStream();
  });
}

// [#351] Terminal-echo dedup for the degeneration recovery notice: pi fires
// the context event multiple times per assistant reply, so without this the
// same notify would spam the terminal on every event while the degenerated
// turn stays the most recent one. Keyed by session + top run so a NEW
// degeneration (different count/char) re-notifies. Per-process, like the
// other one-shot warn flags (ompWarned, proxyStandDownWarned).
let lastDegNoticeKey: string | null = null;

// Opt-in wire-level strip of historical image payloads (issue #321, kernel
// #215). pi serializes the provider request body from the (already transformed)
// messages and fires before_provider_request with the RAW payload right before
// the HTTP call — the same wire point the billion-context proxy strips at. We
// only touch the body when the policy is enabled AND something was actually
// removed; returning undefined keeps pi's payload reference untouched.
function wireBeforeProviderRequest(pi: ExtensionAPI, runtime: AcpRuntime, standDownIfProxied: (ctx: ExtensionContext) => boolean): void {
  pi.on("before_provider_request", async (event, ctx) => {
    if (runtime.refused) return;
    if (standDownIfProxied(ctx)) return;
    const settings = runtime.stripImagesFor(ctx);
    if (!settings.enabled) return;
    const outcome = applyStripImages(event.payload, (ctx.model as { api?: string } | undefined)?.api, settings);
    if (outcome.removed > 0) {
      logInfo("strip-images", {
        sid: ctx.sessionManager.getSessionId(),
        event: "stripped",
        removed: outcome.removed,
        keepRecent: settings.keepRecent,
      });
      return outcome.body;
    }
    return;
  });
}

// The core integration: Pi's `context` event fires before every LLM call with the
// messages about to be sent. We run acp-kernel's processTurn (prune + ref-tag +
// nudge decision) and return the transformed AgentMessage[].
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime, standDownIfProxied: (ctx: ExtensionContext) => boolean): void {
  pi.on("context", async (event, ctx) => {
    // Refused host (OMP / proxied baseUrl): leave the context completely
    // untouched — no ref tags, no compression, no nudge. Returning undefined
    // makes pi send the original messages verbatim.
    if (runtime.refused) return;
    // Fallback for hosts where session_start did not fire before the first LLM
    // call: detect the proxied baseUrl here instead.
    if (standDownIfProxied(ctx)) return;
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      await runtime.reloadConfig(ctx.cwd);
      const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";
      const { state, coreMessages, entries } = await runtime.stateFor(ctx, event.messages);
      const configBase = runtime.configFor(ctx);
      const ov = runtime.overflowFor(sid);
      // Self-heal: a prior upstream overflow may have taught us the real window
      // (see overflow-selfheal). If it is smaller than what we resolved this
      // turn (e.g. the 150k fallback for an unknown model), re-center the kernel
      // on it so the nudge/truncate bands sit below the real limit, not above it.
      // Learned per MODEL: switching to a bigger model mid-session must not
      // inherit the smaller model's learned limit. Spread into a new object —
      // never mutate the shared resolved config.
      let config = configBase;
      const learnedWindow = ov.learnedWindowFor(modelId);
      if (learnedWindow && learnedWindow > 0 && learnedWindow < config.modelContextLimit) {
        config = { ...config, modelContextLimit: learnedWindow };
        logInfo("overflow-selfheal", { sid, modelId, event: "window-recenter", resolved: configBase.modelContextLimit, learned: learnedWindow });
      }
      // Output headroom: reserve the model's output budget from the window so
      // the kernel's nudge/truncate bands sit below (window - reserved) and
      // the context leaves room for the model's reply. The reservation is
      // capped at outputHeadroomMaxPct * window (default 25%, issue #207):
      // reserving the FULL registered maxTokens capability halves the input
      // budget on models whose maxTokens is a large share of the window.
      // Applied to the (possibly re-centered) window above; never mutates the
      // shared config. Anthropic is exempt (see applyOutputHeadroom).
      const headroomCap = resolveOutputHeadroomCap(runtime.adapter.outputHeadroomMaxPct);
      const fullWindow = config.modelContextLimit;
      config = applyOutputHeadroom(config, ctx.model, headroomCap);
      if (config.modelContextLimit !== fullWindow) {
        logInfo("overflow-selfheal", { sid, event: "output-headroom", before: fullWindow, after: config.modelContextLimit, maxOutput: (ctx.model as { maxTokens?: number } | undefined)?.maxTokens ?? 0, cap: headroomCap });
      }
      const coveredIds = collectCoveredMessageIds(state);
      // Nudge arbitration on the SENT-VIEW scale: CJK-aware estimate over the
      // pruned projection + measured system prompt, floored at the host's real
      // context usage (issue #257, below). realUsage is anchored on the last
      // assistant's provider-reported usage when available; it is also logged
      // for diagnostics.
      const realUsage = ctx.getContextUsage?.();
      const systemPromptText = getSystemPromptText(ctx);
      const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
      const imageTokens = collectImageTokens(entries, modelSupportsImages(ctx.model));
      const sentTokens = estimateTokens(coreMessages, coveredIds, imageTokens) + systemPromptTokens;
      // Self-heal (armed): after an overflow, force this turn's usage to >=95%
      // so the kernel's emergency nudge + tool-result truncate fire immediately,
      // even if the estimate under-reports the sent view. Consumed exactly once.
      let armedFloor = 0;
      if (ov.armed && config.modelContextLimit > 0) {
        ov.armed = false;
        armedFloor = Math.floor(config.modelContextLimit * 0.95);
        logWarn("overflow-selfheal", { sid, event: "armed-emergency", floor: armedFloor, limit: config.modelContextLimit });
      }
      // Host floor (#257/#258): the provider's real prompt size, anchored on the
      // last assistant's provider-reported usage + trailing estimate. While the
      // anchor predates a successful compress its raw value still reflects the
      // pre-compression request, so subtract the tokens genuinely freed since
      // it (issue #325, floor-stale.ts) instead of skipping the floor entirely —
      // the skip dropped the meter onto the undercounting estimate (~70-80K low)
      // and the next fresh reading snapped it back into the emergency band.
      const { predates, netReclaimed } = compressionAnchorStaleness(entries, state.blocks, defaultCountTokens);
      const realPromptTokens = realUsage?.tokens ?? 0;
      const hostFloor = realPromptTokens > 0 ? Math.max(0, realPromptTokens - (predates ? netReclaimed : 0)) : 0;
      // Calibration anchor (issue #455): the estimate carries systematic phantom
      // mass (content counted locally that never goes on the wire) which the
      // raise-only floors below can never pull down — in #452 the meter ran
      // 1.5-2x above provider truth for the whole session and never re-anchored.
      // When the provider measurement is FRESH (anchor postdates the last
      // successful compress) and STABLE (recent samples agree), cap the estimate
      // at measured × 1.2: density-scaling toward provider truth while keeping
      // pre-send prediction for growth beyond the lagged-by-one-response
      // measurement. Stale or jittering measurements fall back to the raw
      // estimate; the divergence watch below keeps that fallback visible.
      const hostUsageStable = !predates && realPromptTokens > 0 ? runtime.noteHostUsage(sid, realPromptTokens) : false;
      const calibrate = (base: number): number =>
        hostUsageStable ? Math.min(base, Math.ceil(realPromptTokens * 1.2)) : base;
      const applyFloors = (base: number): number => Math.max(calibrate(base), hostFloor, armedFloor);
      // Basis for the no-body-4xx overflow guard (wireOverflowSelfHeal): the
      // sent-view estimate of the request about to be sent, on the same scale
      // as the turn log below — but WITHOUT the armed 95% floor: that floor is
      // an artifact of a prior arm, not evidence of size, and feeding it back
      // into the ratio guard would re-arm unconditionally right after any
      // emergency.
      const guardBasis = (base: number): number => Math.max(calibrate(base), hostFloor);
      let tokenCount = applyFloors(sentTokens);
      let guardTokens = guardBasis(sentTokens);
      // View-based recount (issue #289): the raw-view estimate counts uncovered
      // messages that prune strips from the sent view every turn (orphaned tool
      // pairs straddling block boundaries, absorbed/filtered messages) — in long
      // multi-block sessions that pins tokenCount far above reality, holding
      // usage in the emergency band and driving low/zero-yield compression loops.
      // Issue #561: re-measuring that view used to cost a second full processTurn
      // (structuredClone + whole-history pass) EVERY turn. Steady state now adopts
      // the previous turn's exact measured view (recorded after the real pass
      // below) whenever the signature matches; the probe only runs to resync —
      // first turn, structural change (compress/decompress/window), or after a
      // truncation-band turn whose output under-reports.
      if (state.blocks.some((b) => b.active && b.effectiveMessageIds.length > 0)) {
        const meter = runtime.peekSentViewCount(sid);
        if (meter && sentViewMeterMatches(meter, state, config)) {
          if (Math.abs(meter.viewTokens - sentTokens) > Math.max(1000, 0.1 * sentTokens)) {
            tokenCount = applyFloors(meter.viewTokens);
            guardTokens = guardBasis(meter.viewTokens);
            logInfo("turn", { sid, event: "view-recount", source: "prev-turn", prelim: sentTokens, viewTokens: meter.viewTokens, tokenCount });
          }
        } else {
          const view = sentViewTokenCount(runtime.core, coreMessages, state, config, tokenCount, imageTokens, systemPromptTokens);
          if (view.drifted) {
            tokenCount = applyFloors(view.viewTokens);
            guardTokens = guardBasis(view.viewTokens);
            logInfo("turn", { sid, event: "view-recount", source: "probe", prelim: sentTokens, viewTokens: view.viewTokens, tokenCount });
          }
        }
      }
      ov.noteSentView(guardTokens, config.modelContextLimit);
      // Divergence watch (issue #455): persistent >2x disagreement between the
      // internal meter and the FRESH provider measurement means calibration
      // could not engage (stale anchor or jittering usage) — warn once per
      // episode instead of silently driving every threshold off the wrong ruler.
      // With calibration engaged the capped tokenCount stays within 20% of the
      // measurement, so this only fires in the fallback states it diagnoses.
      const sizeDivergent = !predates && realPromptTokens > 0 && Math.abs(tokenCount - realPromptTokens) / realPromptTokens > 0.5;
      if (runtime.noteSizeDivergence(sid, sizeDivergent)) {
        logWarn("turn", { sid, event: "size-divergence", est: tokenCount, host: realPromptTokens, ratio: Number((tokenCount / realPromptTokens).toFixed(2)), stable: hostUsageStable });
      }
      // Growth scale guard (issue #267, re-anchored in #455): the meter switches
      // rulers when the dominant source flips between the provider floor and the
      // local estimate (hostFloor vs sentTokens, not raw staleness — a stale anchor
      // whose adjusted floor still dominates is not a switch, #325). A growth delta
      // spanning that switch is a false artifact, not real growth.
      // Zeroing the baselines (the original fix) re-armed the kernel's one-shot
      // first-sight-mass bypass on EVERY flip (it requires
      // lastNudgeShownTokens === 0 && baseline === 0) — flips happen twice per
      // compress cycle, so a sawtooth session kept treating the mass bypass as
      // available and re-fired emergency nudges forever (#452/#455). Re-anchor
      // existing references to the current tokenCount instead: growth since
      // reference resets to zero, cadence baselines stay meaningful on the new
      // ruler, and the mass bypass keeps its consumed state. Genuine cold starts
      // (references already 0) are untouched and keep their one-shot.
      if (runtime.noteTokenScale(sid, hostFloor <= sentTokens)) {
        state.nudge.lastNudgeShownTokens = state.nudge.lastNudgeShownTokens > 0 ? tokenCount : 0;
        state.nudge.lastPerMessageNudgeTokens = state.nudge.lastPerMessageNudgeTokens > 0 ? tokenCount : 0;
        const reanchored: Record<number, number> = {};
        for (const [tier, shown] of Object.entries(state.nudge.lastShownByTier)) {
          if (shown > 0) reanchored[Number(tier)] = tokenCount;
        }
        state.nudge.lastShownByTier = reanchored;
        runtime.clearNudgeTokenStamps(sid);
        logInfo("growth-scale", { sid, event: "scale-flip-reanchor", estScaleWins: hostFloor <= sentTokens, predates, tokenCount });
      }
      debug.event("context-in", {
        sid,
        modelId,
        eventMsgs: event.messages?.length ?? 0,
        entries: entries.length,
        coreMsgs: coreMessages.length,
        tokenCount,
        sessionTokens: realUsage?.tokens ?? null,
        limit: config.modelContextLimit,
        blocksBefore: state.blocks.length,
        activeBefore: state.blocks.filter((b) => b.active).length,
      });

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      await runtime.save(turn.state, ctx);

      // Issue #561: measure the EXACT view that just went out (turn.messages is
      // the pruned, summary-injected projection the provider receives) and
      // record it as next turn's recount source — this is what lets the probe
      // processTurn above stay on the resync-only path. Unusable when this turn
      // ran in the truncate band (output may be post-truncation → under-reports).
      const truncateBand = config.modelContextLimit > 0 ? Math.floor(config.truncate.threshold * config.modelContextLimit) : Number.MAX_SAFE_INTEGER;
      runtime.noteSentViewCount(sid, {
        viewTokens: estimateTokens(turn.messages, collectCoveredMessageIds(turn.state), imageTokens) + systemPromptTokens,
        blocksLen: turn.state.blocks.length,
        activeBlocks: turn.state.blocks.filter((b) => b.active).length,
        limit: config.modelContextLimit,
        usable: tokenCount < truncateBand,
      });

      // [#464] Surface the kernel's end-game observability signals: they fire
      // every stuck turn inside the kernel, but before this were invisible —
      // exactly when compression can no longer save the session is the moment
      // the user must hear about. One log + one UI notice per episode.
      if (turn.terminalEscape) {
        if (runtime.noteTerminalEscape(sid, true)) {
          logWarn("overflow", {
            sid,
            event: "terminal-escape",
            stuckEvents: turn.terminalEscape.stuckEvents,
            usage: turn.terminalEscape.usage,
            tokens: turn.terminalEscape.tokenCount,
            limit: turn.terminalEscape.modelContextLimit,
          });
          if (ctx.hasUI) {
            ctx.ui.notify(`[ACP] ⚠️ ${turn.terminalEscape.message}`, "warning");
          }
        }
      } else {
        runtime.noteTerminalEscape(sid, false);
      }
      if (turn.truncationSkipped) {
        if (runtime.noteTruncationSkipped(sid, true)) {
          logWarn("overflow", { sid, event: "truncation-skipped", detail: turn.truncationSkipped });
        }
      } else {
        runtime.noteTruncationSkipped(sid, false);
      }

      logInfo("turn", {
        sid,
        model: (ctx.model as { id?: string } | undefined)?.id ?? null,
        inMsgs: coreMessages.length,
        outMsgs: turn.messages.length,
        tokens: tokenCount,
        pct: config.modelContextLimit > 0 ? Number(((tokenCount / config.modelContextLimit) * 100).toFixed(2)) : null,
        limit: config.modelContextLimit,
        ...(fullWindow !== config.modelContextLimit ? { fullWindow } : {}),
        nudge: turn.nudge?.shouldInject ? (turn.nudge.breakdown?.emergencyOverride === 1 ? "emergency" : "active") : "idle",
        nudgeReason: turn.nudge?.reason ?? null,
        blocks: turn.state.blocks.length,
        activeBlocks: turn.state.blocks.filter((b) => b.active).length,
        // #289: host-reported usage (Pi window scale) logged separately so
        // tokens/pct above stay on one scale; field order after activeBlocks
        // keeps the pre-existing [turn] layout stable for log consumers.
        hostTokens: realUsage?.tokens ?? null,
        hostPct: realUsage?.percent ?? null,
      });
      debug.event("processTurn", {
        modelId,
        outMsgs: turn.messages.length,
        summaryMsgs: turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        prunedMsgs: coreMessages.length - turn.messages.length + turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        nudgeShouldInject: turn.nudge?.shouldInject ?? false,
        nudgeReason: turn.nudge?.reason ?? null,
        nudgeVoice: turn.nudge ? renderNudgeText(turn.nudge, runtime.prompts, activeNudgeSections(runtime, ctx)).voice : null,
      nudgePct: turn.nudge ? Math.round(turn.nudge.contextUsage * 100) : null,
      nudgeTier: turn.nudge?.tier ?? null,
      nudgeCompressibleCount: turn.nudge?.compressibleRanges.length ?? 0,
      nudgeProtectedCount: turn.nudge?.protectedRanges?.length ?? 0,
      nothingToCompress: turn.nudge?.reason?.includes("nothing to compress") ?? false,
      blocksAfter: turn.state.blocks.length,
      activeAfter: turn.state.blocks.filter((b) => b.active).length,
    });

    const originalById = collectOriginals(entries);
    let rebuilt = coreOutToAgentMessages(turn.messages, originalById);
    // [#336] Request-time reasoning drop, aligned with opencode-acp #377:
    // compress calls are hard-exempt from compression, so their thinking
    // rides along every request as an unreclaimable floor. Round closure is
    // judged on tool-result evidence [#348]; applied BEFORE the nudge push
    // so a synthetic user-role nudge can never count as the trailing
    // "message after the result" and close an in-flight round. Persisted
    // history is never modified — this only rewrites the outgoing view,
    // rebuilt fresh from entries on every event.
    const reasoningDrop = runtime.reasoningDropFor(ctx);
    const droppedThinking = dropCompressReasoning(rebuilt, reasoningDrop);
    if (droppedThinking !== rebuilt) {
      const droppedChars = countThinkingChars(rebuilt) - countThinkingChars(droppedThinking);
      debug.event("reasoning-drop", { sid, droppedChars, drop: reasoningDrop.drop, threshold: reasoningDrop.threshold });
    }
    rebuilt = droppedThinking;
    // [#351] Request-time degenerate-repeat collapse: models occasionally
    // degenerate into long single-codepoint runs (observed: 4655×「【」 in one
    // thinking block, escalating over turns until the turn aborts). pi replays
    // prior assistant thinking back to the provider (reasoning_content / text)
    // on every subsequent request, so a degenerated tail poisons every later
    // prompt via continuation bias and the session dies in an abort loop.
    // Collapse runs >= minRun in assistant text/thinking of the outgoing view
    // (persisted history untouched — rebuilt is fresh from entries each event),
    // and while the LAST assistant message is degenerated append a one-shot
    // recovery notice. Position-based self-limiting: a fresh model turn makes
    // the old message non-last, so no persistent state and no accumulation
    // (#223 lesson). Tail detection runs on the PERSISTED ORIGINALS (not
    // rebuilt): thinking-only aborted turns never reach rebuilt (projectMessage
    // drops them — empty text would 400 on OpenAI-compatible providers), yet
    // they are still "the previous turn" as far as the model's continuation is
    // concerned; the notice must fire there too.
    const degCfg = resolveDegenerationGuard(runtime.adapter.degenerationGuard);
    const tailRuns = degCfg.enabled ? lastAssistantRuns([...originalById.values()], degCfg.minRun) : null;
    const deg = collapseAssistantDegeneration(rebuilt, degCfg);
    if (deg.messages !== rebuilt) {
      rebuilt = deg.messages;
      const maxRun = deg.evidence.reduce((m, e) => e.runs.reduce((x, r) => Math.max(x, r.count), m), 0);
      logWarn("degeneration", { sid, event: "runs-collapsed", msgs: deg.evidence.length, maxRun, minRun: degCfg.minRun });
      debug.event("degeneration-collapsed", { sid, msgs: deg.evidence.length, maxRun });
    }
    if (tailRuns) {
      rebuilt.push(degenerationNotice(tailRuns));
      const top = [...tailRuns].sort((a, b) => b.count - a.count)[0]!;
      logInfo("degeneration", { sid, event: "recovery-notice", maxRun: top.count });
      if (ctx.hasUI && lastDegNoticeKey !== `${sid}:${top.count}:${top.char.codePointAt(0)}`) {
        lastDegNoticeKey = `${sid}:${top.count}:${top.char.codePointAt(0)}`;
        ctx.ui.notify(`[ACP] previous turn ended in degenerate generation (${top.count}× repeat) — the repeated segment was truncated above and a recovery notice injected.`);
      }
    }
    const debugOn = debug.enabled;

    // #364: one policy for all turn-boundary decisions this event (turnKey +
    // outcome scoping); default-off keeps pi-native boundaries.
    const turnPolicy = resolveHostSession(runtime.adapter);
    const turnKey = lastTurnBoundaryId(entries, turnPolicy) ?? sid;
    // #453: the retry breaker keys off PERSISTED boundaries only — under fork
    // hosts the merged `entries` carry content-addressed live-* ids (#459) for
    // the not-yet-persisted tail, which can still churn when the host's view
    // of a message drifts between context fires and would reset failCount
    // mid-episode (cap never latches, emergency-inject loops).
    const retryTurnKey = retryBreakerKey(ctx.sessionManager, turnPolicy) ?? sid;

    // Compress-outcome tracking feeds ONLY the nudge circuit breaker below:
    // failed/no-op attempts are counted (capped at MAX_COMPRESS_ATTEMPTS per
    // user turn) to stop re-injecting the nudge at a model that keeps failing
    // compress. The failed toolResult itself already persists in the session
    // log with the full error text — the model sees it and can self-correct —
    // so NO transient retry prompt is injected (transient re-injection per
    // LLM call caused the #223 infinite-append loop). Only outcomes from the
    // CURRENT user turn are considered; processed BEFORE the nudge block so
    // the cap suppression sees the newest outcome (a success on this fire
    // must lift the cap on this same fire).
    const compressOutcomes = collectCompressOutcomes(entries, lastTurnBoundaryIndex(entries, turnPolicy));
    const outcome = compressOutcomes.length > 0 ? runtime.noteCompressOutcomes(sid, retryTurnKey, compressOutcomes) : null;

    // Growth-aware re-inject bookkeeping (issue #269) runs on EVERY context
    // event, not only when the kernel wants to inject: the drop re-anchor
    // must advance even on idle events (post-compress collapse), or the
    // baseline would keep pointing at the pre-compress peak and suppress the
    // next pressure nudge straight into the emergency band.
    // Floor mirrors the kernel's decideNudge cadence inputs (config carries
    // kernel defaults via defaultConfig, so unset fields are the kernel's own):
    //   nudgeGrowthTokens = min(growthCap, max(growthFloor, limit × growthRatio))
    //   floor = max(minGrowthFloor, minGrowthRatio × nudgeGrowthTokens)
    const adaptiveGrowth =
      !config.modelContextLimit || config.modelContextLimit <= 0
        ? config.nudge.growthFloor
        : Math.min(
            config.nudge.growthCap,
            Math.max(config.nudge.growthFloor, Math.round(config.modelContextLimit * config.nudge.growthRatio)),
          );
    const reInjectFloor = Math.max(config.nudge.minGrowthFloor, config.nudge.minGrowthRatio * adaptiveGrowth);
    let shownAt = runtime.nudgeShownTokensFor(sid, turnKey);
    if (shownAt !== undefined && tokenCount < shownAt - adaptiveGrowth) {
      // Mirror the kernel's drop re-anchor (nudgeNode): after a successful
      // compress the meter collapses; growth since the last shown must
      // restart from the new baseline, not from the old peak.
      logInfo("nudge", { sid: ctx.sessionManager.getSessionId(), event: "drop-reanchor", turnKey, from: shownAt, to: tokenCount });
      shownAt = tokenCount;
      runtime.markNudgeShown(sid, turnKey, tokenCount);
    }

    if (turn.nudge?.shouldInject) {
      // Two independent channels for the nudge:
      //  1. CONTEXT injection (always on): the nudge is appended to the
      //     messages returned to the LLM so the model sees it and compresses.
      //     This is a per-turn append — the next context event rebuilds the
      //     array from scratch, so it does NOT permanently pollute context.
      //  2. TERMINAL echo (debug only): when debug is on, also print the exact
      //     text via ctx.ui.notify so the user can observe what is being
      //     injected while debugging. The model never sees terminal output.
      // Emergency nudges (usage >= 95%) bypass the per-turn dedup so the
      // overflow warning always reaches the model. Other nudges inject at most
      // once per turn: pi fires the context event multiple times per assistant
      // reply (streaming/tool loop), and without this gate the same nudge
      // would be appended on every event. Exception (issue #269): once the
      // context has GROWN by a full growth floor since the last actual
      // injection, the nudge is allowed to re-inject within the same turn — a
      // model that ignored the earlier nudge gets a fresh reminder on the new
      // growth instead of being driven into the emergency band first. The
      // floor mirrors the kernel's own anti-thrashing cadence (decideNudge:
      // growthFloor = max(minGrowthFloor, minGrowthRatio × nudgeGrowthTokens),
      // nudgeGrowthTokens = resolveAdaptiveGrowth — acp-kernel), so the
      // re-inject never fires more eagerly than the kernel's growth-branch
      // cadence and merely extends it to the pressure branch (75%+), which the
      // kernel re-decides on every event by design.
      const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
      // Recommend only ranges the model can actually compress: a tiny
      // fragmented range in the list makes batched attempts fail atomically
      // (kernel validates the whole batch). See viableRanges in acp-kernel.
      turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
      // Retry-cap circuit breaker (issue #6): emergency nudges re-inject on
      // every LLM call, so a model answering each one with a failed/no-op
      // compress call loops forever (each attempt adds protected tokens and
      // keeps usage pinned at emergency). Once this turn burned
      // MAX_COMPRESS_ATTEMPTS attempts, stop re-injecting the nudge — the
      // kernel's emergency truncation still shrinks context mechanically.
      const retryCapped = runtime.compressRetryCappedFor(sid, retryTurnKey);
      const reInjectReady = shownAt === undefined || tokenCount - shownAt >= reInjectFloor;
      const alreadyShown = retryCapped || (!emergency && runtime.nudgeShownFor(sid, turnKey) && !reInjectReady);
      if (!alreadyShown) {
        rebuilt.push(nudgeMessage(turn.nudge, turn.state.blocks.filter((b) => b.active), runtime.prompts, activeNudgeSections(runtime, ctx)));
        const rendered = renderNudgeText(turn.nudge, runtime.prompts, activeNudgeSections(runtime, ctx));
        const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
        const example = top ? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })` : "";
        if (emergency) {
          logWarn("nudge", { sid: ctx.sessionManager.getSessionId(), event: "emergency-inject", pct: Math.round(turn.nudge.contextUsage * 100), voice: rendered.voice, compressible: turn.nudge.compressibleRanges.length });
        }
        if (debugOn && ctx.hasUI) {
          ctx.ui.notify(`[ACP nudge → context]${emergency ? " [EMERGENCY]" : ""}\n${rendered.text}${example}`);
        }
        if (!emergency) runtime.markNudgeShown(sid, turnKey, tokenCount);
        debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, channels: ["context", debugOn ? "terminal" : null].filter(Boolean), emergency, turnKey, reInject: shownAt !== undefined, text: rendered.text + example });
      } else {
        debug.event("nudge-suppressed", { sid: ctx.sessionManager.getSessionId(), turnKey, reason: turn.nudge.reason, shownAt: shownAt ?? null, tokenCount, adaptiveGrowth, reInjectFloor });
      }
    }

    if (outcome !== null && outcome.cappedNow) {
      logWarn("nudge", { sid, event: "compress-retry-capped", failures: outcome.count });
      debug.event("compress-retry-capped", { sid, turnKey, failures: outcome.count });
      if (ctx.hasUI) {
        ctx.ui.notify(`[ACP] compress failed ${outcome.count}× this turn — nudge paused until the next user message (emergency truncation still active).`);
      }
    }

    // #471 Re-append host-injected live-only messages (pi-web auto-name adds its
    // instruction to event.messages without persisting an entry, so a Pi-host
    // rebuild from entries alone drops them). null = no-op: normal turns align
    // byte-for-byte and non-Pi hosts already merged live into entries. Append-only
    // — never touches refs/blocks, so it stays orthogonal to the #459 ref churn.
    const liveTail = liveOnlyTailCached(sid, entries, event.messages);
    if (liveTail && liveTail.length > 0) {
      rebuilt.push(...liveTail);
      logInfo("live-only-tail", { sid, event: "appended", tail: liveTail.length, outMsgs: rebuilt.length });
    }

    // #477 pi 0.86 carries the active toolset on the session system message
    // (toolsAdded); provider adapters derive request `tools` from it. The
    // rebuild sources messages from persisted entries, which never include the
    // system message, so requests went out toolless. Carry the input's system
    // message(s) back onto the rebuild; strict no-op on hosts without one.
    const withHostSystem = carryHostSystemMessages(rebuilt, event.messages);
    if (withHostSystem !== rebuilt) {
      rebuilt = withHostSystem;
      logInfo("system-passthrough", { sid, event: "carried", systems: event.messages.filter((m) => (m as { role?: unknown }).role === "system").length, outMsgs: rebuilt.length });
    }

    // [#505] drop orphaned tool results created by compression folding away a
    // matching call (an orphan result would 400 upstream). Gated on compression
    // having occurred: a non-compressed branch can legitimately begin at a
    // toolResult whose originating call is not in view, and must not be touched.
    if (turn.state.blocks.length > 0) {
      const sanitized = sanitizeToolPairing(rebuilt);
      if (sanitized.droppedResults.length > 0) {
        rebuilt = sanitized.messages;
        logWarn("tool-pair-sanitize", { sid, event: "dropped-orphan-results", count: sanitized.droppedResults.length, droppedResults: sanitized.droppedResults });
      }
    }

    // Always return the transformed array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
    debug.event("context-out", { outMsgs: rebuilt.length, injected: turn.nudge?.shouldInject ?? false, emergency: turn.nudge?.breakdown?.emergencyOverride === 1 });
    // Also check for updates here (not only on session_start): resuming a
    // long-running session never re-fires session_start, so an update could
    // go unnoticed for days. checkForUpdate throttles internally (3 min) and
    // is guarded against concurrent calls, so firing it per LLM call is safe.
    // Headless: await so a process exiting after this turn cannot kill a
    // running install (TUI stays fire-and-forget to avoid blocking the turn).
    const updateCheck = checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
    if (!ctx.hasUI) await updateCheck;
    return { messages: rebuilt };
    } catch (e) {
      logThrow("context", e, { sid, phase: "transform" });
      throw e;
    } finally {
      release();
    }
  });
}

let lastPackPromptGateKeys: string | null = null;

function wireSystemPrompt(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("before_agent_start", (event, ctx) => {
    // Refused host (OMP): don't inject the ACP system prompt — the model must
    // not learn about compress/decompress on a host where they can't work.
    if (runtime.refused) return;
    const m = ctx?.model as { provider?: string; id?: string } | undefined;
    const cwd = ctx?.cwd ?? process.cwd();
    const requested = resolvePackName(runtime.adapter, m?.provider, m?.id);
    const activePack = resolveActivePack(runtime.adapter, cwd, m?.provider, m?.id);
    const merged = mergeSurface(activePack, runtime.adapter);
    // Audit stamp (#431 forensics): record the effective pack for this
    // session; persisted into the sidecar on the next state save.
    try {
      const sid = ctx?.sessionManager?.getSessionId();
      if (sid) runtime.store.setActivePack(ctx?.sessionManager?.getSessionFile?.(), sid, surfaceMetaOf(activePack, requested).pack);
    } catch {
      // best-effort — status reporting never depends on the stamp
    }
    // Unconditional: switching to a model/pack without prompt overrides must
    // reset the rules to kernel defaults, not keep the previous pack's.
    try {
      runtime.setPrompts(resolvePrompts(merged.prompts, { acknowledgeRisk: runtime.adapter.acknowledgePromptsRisk === true }));
    } catch (e) {
      const keys = Object.keys(merged.prompts).sort().join(",");
      if (keys !== lastPackPromptGateKeys) {
        lastPackPromptGateKeys = keys;
        logWarn("config", { event: "pack-prompts-gated", keys, error: e instanceof Error ? e.message : String(e) });
      }
      runtime.setPrompts(defaultPrompts);
    }
    const delegate = resolveDelegate(runtime.adapter).enabled && !runtime.delegateStoodDown;
    const acp = buildAcpSystemPrompt(runtime.prompts, merged.promptSections);
    const delegateText = merged.delegatePrompt !== undefined ? merged.delegatePrompt : ACP_DELEGATE_PROMPT;
    const prompt = delegate && delegateText !== null ? `${acp}\n${delegateText}` : acp;
    return { systemPrompt: formatSystemPromptForEvent(event.systemPrompt, prompt) };
  });
}

function activeNudgeSections(runtime: AcpRuntime, ctx?: ExtensionContext): NudgeSectionsConfig {
  const m = ctx?.model as { provider?: string; id?: string } | undefined;
  const cwd = ctx?.cwd ?? process.cwd();
  const pack = resolveActivePack(runtime.adapter, cwd, m?.provider, m?.id);
  return mergeSurface(pack, runtime.adapter).nudgeSections;
}

// Context-overflow self-heal: when the model API rejects a request because the
// context is too large (a context-overflow 400), learn the real window (if the
// error states it) and arm an emergency for the next turn. The `context` handler
// (wireContextTransform) reads the learned window + armed flag via
// runtime.overflowFor(sid). Design: src/overflow-selfheal.ts.
//
// Unlike throttle-retry we do NOT rewrite the error or ask pi to retry: the
// overflow is real, and re-sending the same context would overflow again. The
// error surfaces; the next turn self-heals.
function wireOverflowSelfHeal(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("message_end", (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    const sid = ctx.sessionManager.getSessionId();
    const ov = runtime.overflowFor(sid);
    if (msg.stopReason !== "error") {
      // Successful assistant turn: the request loop is unwedged, so the
      // consecutive no-body-4xx count (possible-overflow path below)
      // restarts from zero.
      ov.noteSuccess();
      return;
    }
    // Haystack = errorMessage + error content: some relays put the upstream
    // error body in the streamed content and leave errorMessage generic
    // ("Provider finish_reason: error_finish") — errorMessage alone would miss
    // them. (Same haystack approach as isThrottleError.)
    const haystack = `${msg.errorMessage ?? ""}\n${extractText(msg.content)}`;
    const info = inspectOverflowMessage(haystack);
    const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";
    if (info.isOverflow) {
      if (info.window) ov.setLearnedWindow(modelId, info.window);
      ov.armed = true;
      logWarn("overflow-selfheal", { sid, modelId, event: "detected", window: info.window ?? null, message: info.message.slice(0, 200) });
      if (ctx.hasUI) ctx.ui.notify(`[ACP] context overflow detected${info.window ? ` (window ${info.window})` : ""} — forcing emergency compression next turn`);
      return;
    }
    // Possible overflow: pi's bodyless "4xx ... (no body)" (incident
    // 2026-08-23: a huge bash tool result pushed every request past sglang's
    // input+max_tokens cap; each retry returned "400 status code (no body)"
    // forever and the text-marker path above never matched, so the emergency
    // never fired and the session dead-looped). The text is ambiguous — the
    // same 4xx comes back for invalid models / malformed requests (see
    // messages.ts) — so arm only with corroboration: sent-view >= 50% of the
    // effective limit, or the >=2nd consecutive no-body since the last
    // successful turn. Unlike the path above no window can be parsed from a
    // bodyless error, so none is learned: the armed emergency uses the
    // already-resolved effective limit (wireContextTransform).
    if (!isNoBody4xxError(haystack)) return;
    const decision = ov.onNoBody4xx();
    if (!decision.arm) return;
    ov.armed = true;
    logWarn("overflow-selfheal", { sid, modelId, event: "no-body-arm", consecutive: decision.consecutive, ratio: decision.ratio, message: haystack.slice(0, 200) });
    if (ctx.hasUI) ctx.ui.notify(`[ACP] possible context overflow (4xx no-body error, ${decision.consecutive} consecutive) — forcing emergency compression next turn`);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    runtime.overflowDrop(ctx.sessionManager.getSessionId());
  });
}

// Bedrock per-minute token-throttle auto-retry (hybrid design):
//  1. message_end (sync, no sleep): when a finalized assistant message is a
//     provider throttle error, rewrite its errorMessage to a pi-retryable
//     form. Pi's native post-run classifier then re-runs the same turn via
//     agent.continue() (error message removed from LLM state, native TUI
//     indicator) within its own in-memory budget (default 3).
//  2. agent_settled: if the run still ended on a rewritten throttle error and
//     the ACP episode budget remains, ACP sleeps its own progressive delay
//     (60s exponential base, capped) then pi.sendUserMessage(kick) to resume
//     the task — covering attempts Pi's in-memory budget refuses.
//     agent_settled fires in _runAgentPrompt's finally (after all of pi's
//     retry/compaction/continue decisions) with the agent idle, so the sleep
//     blocks nothing; ctx.signal is undefined there, so ACP keeps its own
//     AbortController. Any non-kick user input cancels the pending kick
//     (input event, source !== "extension"); the throttled error stays in
//     context and the system-prompt line guides the model to resume.
function wireThrottleRetry(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("message_end", (event, ctx) => {
    const th = runtime.throttleFor(ctx.sessionManager.getSessionId());
    const msg = event.message;
    if (msg.role === "user") {
      th.onUserMessage(isKickMessage(msg));
      return;
    }
    if (msg.role !== "assistant") return;
    if (msg.stopReason !== "error") {
      th.onProgress();
      return;
    }
    if (!isThrottleError(msg)) {
      th.onNonThrottleError();
      return;
    }
    const cfg = resolveThrottleRetry(runtime.adapter.throttleRetry);
    if (!cfg.enabled) {
      th.onNonThrottleError();
      return;
    }
    const decision = th.onThrottleError(cfg.maxRetries);
    if (decision === "exhausted") {
      logWarn("throttle-retry", { sid: ctx.sessionManager.getSessionId(), event: "budget-exhausted", max: cfg.maxRetries });
      if (ctx.hasUI) ctx.ui.notify(`[ACP] provider throttled — retry budget exhausted (${cfg.maxRetries}); surfacing error`);
      return;
    }
    logInfo("throttle-retry", { sid: ctx.sessionManager.getSessionId(), event: "rewrite", attempt: th.state.attempts, max: cfg.maxRetries, path: "native" });
    if (ctx.hasUI) ctx.ui.notify(`[ACP] provider throttled — retry ${th.state.attempts}/${cfg.maxRetries} (fast probe)`);
    return { message: { ...msg, errorMessage: THROTTLE_RETRY_ERROR_MESSAGE } };
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const th = runtime.throttleFor(ctx.sessionManager.getSessionId());
    const cfg = resolveThrottleRetry(runtime.adapter.throttleRetry);
    if (!cfg.enabled || !th.readyToKick(cfg.maxRetries)) return;
    const kickNumber = th.state.kicks + 1;
    const delayMs = throttleDelayMs(kickNumber, cfg);
    th.onKickStarted();
    const sid = ctx.sessionManager.getSessionId();
    logInfo("throttle-retry", { sid, event: "kick-sleep", kickNumber, delayMs });
    if (ctx.hasUI) ctx.ui.notify(`[ACP] provider throttled — waiting ${Math.round(delayMs / 1000)}s before retry ${th.state.attempts + 1}/${cfg.maxRetries}`);
    const result = await abortableSleep(delayMs, th.sleepController().signal);
    if (result === "aborted") {
      th.onKickCancelled();
      logInfo("throttle-retry", { sid, event: "kick-cancelled", kickNumber });
      if (ctx.hasUI) ctx.ui.notify("[ACP] throttle retry cancelled (user input received)");
      return;
    }
    if (!th.readyToKick(cfg.maxRetries)) return;
    pi.sendUserMessage(THROTTLE_KICK_TEXT);
    logInfo("throttle-retry", { sid, event: "kick-sent", kickNumber, attempt: th.state.attempts + 1, max: cfg.maxRetries });
  });
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") runtime.throttleFor(ctx.sessionManager.getSessionId()).cancelSleep();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    runtime.throttleDrop(ctx.sessionManager.getSessionId());
  });
}

function collectOriginals(entries: Array<{ type: string; id: string; message?: AgentMessage; content?: unknown }>): Map<string, AgentMessage> {
  const map = new Map<string, AgentMessage>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      map.set(entry.id, entry.message);
    } else if (entry.type === "custom_message") {
      // Pi's convertToLlm projects custom messages as { role: "user", content }
      // for the LLM. Mirror that here so coreOutToAgentMessages restores a
      // proper user AgentMessage — using role:"custom" would be dropped by Pi.
      const content = typeof entry.content === "string"
        ? [{ type: "text" as const, text: entry.content }]
        : entry.content;
      map.set(entry.id, { role: "user", content } as AgentMessage);
    }
  }
  return map;
}

// Compress toolResults from the CURRENT user turn only — the raw material for
// the nudge circuit breaker above. Scoping matters: feeding the whole session
// would keep an old failure counting against the current turn's budget
// forever (review finding on 7ddd2c6).
function collectCompressOutcomes(entries: Array<{ type: string; id: string; message?: AgentMessage }>, startIndex: number): Array<{ toolCallId: string; isError: boolean; success: boolean; noop: boolean; text: string }> {
  const out: Array<{ toolCallId: string; isError: boolean; success: boolean; noop: boolean; text: string }> = [];
  for (let i = Math.max(startIndex, -1) + 1; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type !== "message" || !entry.message) continue;
    const m = entry.message as { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: unknown };
    if (m.role !== "toolResult" || m.toolName !== "compress" || !m.toolCallId) continue;
    const text = extractText(m.content);
    out.push({ toolCallId: m.toolCallId, isError: m.isError === true, success: m.isError !== true && isCompressSuccessText(text), noop: m.isError !== true && isCompressNoopText(text), text });
  }
  return out;
}

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[], prompts: Prompts, sections?: NudgeSectionsConfig): AgentMessage {
  const rendered = renderNudgeText(nudge, prompts, sections);
  const lines = [rendered.text];

  if (blocks.length > 0) {
    const totalSummary = blocks.reduce((s, b) => s + Math.ceil((b.summary || "").length / 4), 0);
    const totalCompressed = blocks.reduce((s, b) => s + (b.compressedTokens || 0), 0);
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
    const tierCounts: Record<number, number> = {};
    for (const b of blocks) {
      const t = b.tier ?? 1;
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    }
    const tierStr = Object.keys(tierCounts).map(Number).sort().map((t) => `T${t}:${tierCounts[t]}`).join(" ");
    const ids = blocks.slice(0, 10).map((b) => b.blockId).join(", ");
    const extra = blocks.length > 10 ? ` (+${blocks.length - 10} more)` : "";
    lines.push("");
    lines.push(`Compressed blocks: ${blocks.length} active (${tierStr}) — ${fmt(totalSummary)} summary, ${fmt(totalCompressed)} original compressed. Blocks: ${ids}${extra}.`);
  }

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
