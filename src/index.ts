import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CoreMessage, NudgeDecision, CompressionBlock, Prompts } from "acp-kernel";
import { renderNudgeText, resolvePrompts, defaultPrompts, viableRanges } from "acp-kernel";
import { type AdapterConfig, resolveDelegate, parsePercent } from "./config.js";
import { createRuntime, type AcpRuntime } from "./runtime.js";
import { makeCompressTool, isCompressSuccessText, isCompressNoopText } from "./compress-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool, runningRunsSnapshot, resetDelegateUsage, setDelegateDisplayUsage } from "./delegate-tool.js";
import { makeCommands } from "./commands.js";
import { coreOutToAgentMessages, extractText } from "./messages.js";
import { buildAcpSystemPrompt, ACP_DELEGATE_PROMPT } from "./system-prompt.js";
import { delegateStatusWidget } from "./fleet-widget.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { debug, logError, logInfo, logWarn, logThrow, closeLogStream } from "./log.js";
import { collectCoveredMessageIds, estimateTokens, lastUserMessageId, collectImageTokens, modelSupportsImages } from "./tokens.js";
import { usageAnchorPredatesCompression } from "./floor-stale.js";
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
import { DEFAULT_OUTPUT_HEADROOM_MAX_PCT, inspectOverflowMessage, reserveOutputHeadroom, shouldReserveOutputHeadroom } from "./overflow-selfheal.js";
import { isOmpHost, OMP_UNSUPPORTED_MESSAGE } from "./omp.js";

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
    wireCompactionDisable(pi, runtime);
    wireSessionLifecycle(pi, runtime);
    wireContextTransform(pi, runtime);
    wireSystemPrompt(pi, runtime);
    wireToolGuardrails(pi, runtime);
    wireOverflowSelfHeal(pi, runtime);
    wireThrottleRetry(pi, runtime);
    pi.registerTool(makeCompressTool(runtime));
    pi.registerTool(makeDecompressTool(runtime));
    pi.registerTool(makeSearchTool(runtime));
    pi.registerTool(makeStatusTool(runtime));
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
// enabled:true/false counts; missing/bad files mean "not disabled".
function userConfigDisabled(cwd: string): boolean {
  let disabled: boolean | undefined;
  for (const base of [join(homedir(), CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(base, "acp.json"), "utf8"));
      if (parsed && typeof parsed === "object") {
        const v = (parsed as Record<string, unknown>).enabled;
        if (v === true || v === false) disabled = v;
      }
    } catch {
      // missing file / bad JSON → not disabled
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

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime): void {
  let ompWarned = false;
  pi.on("session_start", async (_event, ctx) => {
    // OMP (oh-my-pi) is not supported: its in-process live-entries integration
    // diverges the nudge's example refs from the session's real refs, so
    // compress calls fail with "does not exist in this session". Stand down —
    // refuse service and point the user at the billion-context proxy. session_start
    // always precedes the first context/before_agent_start event, so setting
    // `refused` here reliably gates every downstream handler for the session.
    if (isOmpHost(ctx.sessionManager)) {
      runtime.refused = true;
      if (!ompWarned) {
        ompWarned = true;
        const sid = ctx.sessionManager.getSessionId();
        logWarn("host", { event: "omp-unsupported", sid, action: "refused" });
        if (ctx.hasUI) ctx.ui.notify(OMP_UNSUPPORTED_MESSAGE, "warning");
        else console.error(OMP_UNSUPPORTED_MESSAGE);
      }
      return;
    }
    runtime.store.invalidate();
    runtime.clearNudgeTracking();
    runtime.throttleFor(ctx.sessionManager.getSessionId()).reset();
    runtime.clearCompressRetryTracking();
    resetDelegateUsage();
    setDelegateDisplayUsage("separate");
    const sid = ctx.sessionManager.getSessionId();
    // Model identity on every session start: diagnosing "which model loops
    // on compress rejections" from user logs required cwd forensics — the log
    // never said which model it was. id + contextWindow also catch window
    // misconfigurations.
    const modelInfo = ctx.model as { id?: string; contextWindow?: number; api?: string } | undefined;
    logInfo("session", { event: "start", sid, cwd: ctx.cwd, debug: runtime.adapter.debug ?? null, version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null, model: modelInfo?.id ?? null, modelApi: modelInfo?.api ?? null, contextWindow: modelInfo?.contextWindow ?? null });
    try {
      await runtime.reloadConfig(ctx.cwd);
      setDelegateDisplayUsage(resolveDelegate(runtime.adapter).displayUsage);
    } catch (e) {
      logThrow("config", e, { sid, phase: "session_start" });
    }
    try {
      runtime.setPrompts(resolvePrompts(runtime.adapter.prompts, { acknowledgeRisk: runtime.adapter.acknowledgePromptsRisk === true }));
    } catch (e) {
      logWarn("config", { event: "prompts-resolve-failed", error: e instanceof Error ? e.message : String(e) });
      runtime.setPrompts(defaultPrompts);
    }
    if (resolveDelegate(runtime.adapter).enabled) {
      pi.registerTool(makeDelegateTool(pi));
      pi.registerTool(makeDelegateWaitTool(pi));
      pi.registerTool(makeDelegateCancelTool(pi));
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
    delegateStatusWidget.setContext(ctx, runningRunsSnapshot);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    runtime.clearDeadCompress(ctx.sessionManager.getSessionId());
    delegateStatusWidget.dispose();
    closeLogStream();
  });
}

// The core integration: Pi's `context` event fires before every LLM call with the
// messages about to be sent. We run acp-kernel's processTurn (prune + ref-tag +
// nudge decision) and return the transformed AgentMessage[].
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("context", async (event, ctx) => {
    // Refused host (OMP): leave the context completely untouched — no ref tags,
    // no compression, no nudge. Returning undefined makes pi send the original
    // messages verbatim.
    if (runtime.refused) return;
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
      // shared config. Anthropic is exempt — its input limit is enforced
      // independently of max_tokens (see shouldReserveOutputHeadroom).
      const maxOutput = (ctx.model as { maxTokens?: number } | undefined)?.maxTokens ?? 0;
      const rawHeadroomCap = runtime.adapter.outputHeadroomMaxPct;
      const headroomCap = rawHeadroomCap === undefined ? DEFAULT_OUTPUT_HEADROOM_MAX_PCT : parsePercent(rawHeadroomCap);
      let fullWindow = config.modelContextLimit;
      if (shouldReserveOutputHeadroom((ctx.model as { api?: string } | undefined)?.api)) {
        const reservedWindow = reserveOutputHeadroom(config.modelContextLimit, maxOutput, headroomCap);
        if (reservedWindow !== config.modelContextLimit) {
          const before = config.modelContextLimit;
          config = { ...config, modelContextLimit: reservedWindow };
          logInfo("overflow-selfheal", { sid, event: "output-headroom", before, after: reservedWindow, maxOutput, cap: headroomCap });
        }
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
      const sentTokens = estimateTokens(coreMessages, coveredIds, collectImageTokens(entries, modelSupportsImages(ctx.model))) + systemPromptTokens;
      // Usage/emergency arbitration on the sent view, floored at the host's
      // real context usage (issue #257): the CJK-aware base estimate is still
      // a heuristic (images, mixed content, per-model tokenizer drift), so
      // the 0.75/0.95 bands run on the real scale via the floor. realUsage is
      // anchored on the last assistant's provider-reported usage + trailing
      // estimate. Only ever raises (never lowers); skipped while the anchor
      // predates a successful compress (floor-stale.ts). tokenCount only
      // feeds processTurn.
      let tokenCount = sentTokens;
      const realPromptTokens = realUsage?.tokens ?? 0;
      if (!usageAnchorPredatesCompression(entries) && realPromptTokens > tokenCount) {
        tokenCount = realPromptTokens;
      }
      // Self-heal (armed): after an overflow, force this turn's usage to >=95%
      // so the kernel's emergency nudge + tool-result truncate fire immediately,
      // even if the estimate under-reports the sent view. tokenCount only feeds
      // processTurn (nudge/truncate).
      if (ov.armed && config.modelContextLimit > 0) {
        ov.armed = false;
        const floor = Math.floor(config.modelContextLimit * 0.95);
        if (floor > tokenCount) {
          tokenCount = floor;
          logWarn("overflow-selfheal", { sid, event: "armed-emergency", tokenCount, limit: config.modelContextLimit });
        }
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

      logInfo("turn", {
        sid,
        model: (ctx.model as { id?: string } | undefined)?.id ?? null,
        inMsgs: coreMessages.length,
        outMsgs: turn.messages.length,
        tokens: tokenCount,
        pct: realUsage?.percent ?? (config.modelContextLimit > 0 ? Math.round((tokenCount / config.modelContextLimit) * 100) : null),
        limit: config.modelContextLimit,
        ...(fullWindow !== config.modelContextLimit ? { fullWindow } : {}),
        nudge: turn.nudge?.shouldInject ? (turn.nudge.breakdown?.emergencyOverride === 1 ? "emergency" : "active") : "idle",
        nudgeReason: turn.nudge?.reason ?? null,
        blocks: turn.state.blocks.length,
        activeBlocks: turn.state.blocks.filter((b) => b.active).length,
      });
      debug.event("processTurn", {
        modelId,
        outMsgs: turn.messages.length,
        summaryMsgs: turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        prunedMsgs: coreMessages.length - turn.messages.length + turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        nudgeShouldInject: turn.nudge?.shouldInject ?? false,
        nudgeReason: turn.nudge?.reason ?? null,
        nudgeVoice: turn.nudge ? renderNudgeText(turn.nudge, runtime.prompts).voice : null,
      nudgePct: turn.nudge ? Math.round(turn.nudge.contextUsage * 100) : null,
      nudgeTier: turn.nudge?.tier ?? null,
      nudgeCompressibleCount: turn.nudge?.compressibleRanges.length ?? 0,
      nudgeProtectedCount: turn.nudge?.protectedRanges?.length ?? 0,
      nothingToCompress: turn.nudge?.reason?.includes("nothing to compress") ?? false,
      blocksAfter: turn.state.blocks.length,
      activeAfter: turn.state.blocks.filter((b) => b.active).length,
    });

    const originalById = collectOriginals(entries);
    const rebuilt = coreOutToAgentMessages(turn.messages, originalById);
    const debugOn = debug.enabled;

    const turnKey = lastUserMessageId(entries) ?? sid;

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
    const compressOutcomes = collectCompressOutcomes(entries, turnStartIndex(entries));
    const outcome = compressOutcomes.length > 0 ? runtime.noteCompressOutcomes(turnKey, compressOutcomes) : null;

    if (turn.nudge?.shouldInject) {
      // Two independent channels for the nudge:
      //  1. CONTEXT injection (always on): the nudge is appended to the
      //     messages returned to the LLM so the model sees it and compresses.
      //     This is a per-turn append — the next context event rebuilds the
      //     array from scratch, so it does NOT permanently pollute context.
      //  2. TERMINAL echo (debug only): when debug is on, also print the exact
      //     text via ctx.ui.notify so the user can observe what is being
      //     injected while debugging. The model never sees terminal output.
      // Emergency nudges (usage >= 80%) bypass the per-turn dedup so the
      // overflow warning always reaches the model. Other nudges inject at most
      // once per turn: pi fires the context event multiple times per assistant
      // reply (streaming/tool loop), and without this gate the same nudge
      // would be appended on every event.
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
      const retryCapped = runtime.compressRetryCappedFor(turnKey);
      const alreadyShown = retryCapped || (!emergency && runtime.nudgeShownFor(turnKey));
      if (!alreadyShown) {
        rebuilt.push(nudgeMessage(turn.nudge, turn.state.blocks.filter((b) => b.active), runtime.prompts));
        const rendered = renderNudgeText(turn.nudge, runtime.prompts);
        const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
        const example = top ? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })` : "";
        if (emergency) {
          logWarn("nudge", { sid: ctx.sessionManager.getSessionId(), event: "emergency-inject", pct: Math.round(turn.nudge.contextUsage * 100), voice: rendered.voice, compressible: turn.nudge.compressibleRanges.length });
        }
        if (debugOn && ctx.hasUI) {
          ctx.ui.notify(`[ACP nudge → context]${emergency ? " [EMERGENCY]" : ""}\n${rendered.text}${example}`);
        }
        if (!emergency) runtime.markNudgeShown(turnKey);
        debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, channels: ["context", debugOn ? "terminal" : null].filter(Boolean), emergency, turnKey, text: rendered.text + example });
      } else {
        debug.event("nudge-suppressed", { sid: ctx.sessionManager.getSessionId(), turnKey, reason: turn.nudge.reason });
      }
    }

    if (outcome !== null && outcome.cappedNow) {
      logWarn("nudge", { sid, event: "compress-retry-capped", failures: outcome.count });
      debug.event("compress-retry-capped", { sid, turnKey, failures: outcome.count });
      if (ctx.hasUI) {
        ctx.ui.notify(`[ACP] compress failed ${outcome.count}× this turn — nudge paused until the next user message (emergency truncation still active).`);
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

function wireSystemPrompt(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("before_agent_start", (event) => {
    // Refused host (OMP): don't inject the ACP system prompt — the model must
    // not learn about compress/decompress on a host where they can't work.
    if (runtime.refused) return;
    const delegate = runtime.adapter.delegate !== false;
    const acp = buildAcpSystemPrompt(runtime.prompts);
    const prompt = delegate ? `${acp}\n${ACP_DELEGATE_PROMPT}` : acp;
    return { systemPrompt: formatSystemPromptForEvent(event.systemPrompt, prompt) };
  });
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
    if (msg.stopReason !== "error") return;
    // Haystack = errorMessage + error content: some relays put the upstream
    // error body in the streamed content and leave errorMessage generic
    // ("Provider finish_reason: error_finish") — errorMessage alone would miss
    // them. (Same haystack approach as isThrottleError.)
    const haystack = `${msg.errorMessage ?? ""}\n${extractText(msg.content)}`;
    const info = inspectOverflowMessage(haystack);
    if (!info.isOverflow) return;
    const sid = ctx.sessionManager.getSessionId();
    const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";
    const ov = runtime.overflowFor(sid);
    if (info.window) ov.setLearnedWindow(modelId, info.window);
    ov.armed = true;
    logWarn("overflow-selfheal", { sid, modelId, event: "detected", window: info.window ?? null, message: info.message.slice(0, 200) });
    if (ctx.hasUI) ctx.ui.notify(`[ACP] context overflow detected${info.window ? ` (window ${info.window})` : ""} — forcing emergency compression next turn`);
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

// Index of the last user-role entry — the start of the current turn.
// Everything strictly AFTER this index belongs to the current turn; -1 when
// the session has no user message yet.
function turnStartIndex(entries: Array<{ type: string; message?: { role?: string } }>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.message?.role === "user") return i;
  }
  return -1;
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

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[], prompts: Prompts): AgentMessage {
  const rendered = renderNudgeText(nudge, prompts);
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
