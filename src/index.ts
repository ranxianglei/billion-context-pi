import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { CoreMessage, NudgeDecision, CompressionBlock } from "acp-kernel";
import { renderNudgeText } from "acp-kernel";
import { type AdapterConfig, resolveDelegate } from "./config.js";
import { createRuntime, type AcpRuntime } from "./runtime.js";
import { makeCompressTool } from "./compress-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool, runningRunsSnapshot, resetDelegateUsage, setDelegateDisplayUsage } from "./delegate-tool.js";
import { makeCommands } from "./commands.js";
import { autoCompress, summarizeRange, selectRangeSpan, totalCompressibleChars } from "./auto-compress.js";
import { coreOutToAgentMessages } from "./messages.js";
import { ACP_SYSTEM_PROMPT, ACP_DELEGATE_PROMPT } from "./system-prompt.js";
import { delegateStatusWidget } from "./fleet-widget.js";
import { setLocale, t } from "./i18n.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { debug, setDebugEnabled, logError, logInfo, logWarn, logThrow, closeLogStream } from "./log.js";
import { pruneStaleRefs } from "./state.js";
import { collectCoveredMessageIds, estimateTokens, lastUserMessageId } from "./tokens.js";
import { checkForUpdate } from "./update.js";
import { runSetupAndNotify } from "./setup-subagent-tools.js";
import { loadUserConfig, applyUserConfig } from "./user-config.js";
import { formatSystemPromptForEvent } from "./compat.js";

type AgentMessage = SessionMessageEntry["message"];

declare const CURRENT_VERSION: string;

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const runtime = createRuntime(adapter);
    wireCompactionDisable(pi, runtime);
    wireSessionLifecycle(pi, runtime);
    wireContextTransform(pi, runtime);
    wireSystemPrompt(pi, runtime);
    wireToolGuardrails(pi, runtime);
    pi.registerTool(makeCompressTool(runtime));
    pi.registerTool(makeDecompressTool(runtime));
    pi.registerTool(makeSearchTool(runtime));
    pi.registerTool(makeStatusTool(runtime));
registerCommands(pi, runtime);
  };
}

export default createAcpExtension();

/** Register slash commands. Map.set 同名覆盖 → setLocale 后重新注册可更新 description。 */
function registerCommands(pi: ExtensionAPI, runtime: AcpRuntime): void {
  for (const { name, options } of makeCommands(runtime)) {
    pi.registerCommand(name, options);
  }
}

// Intercept Pi's compaction (manual /compact or automatic threshold) and run
// ACP's own compression instead: pick the largest compressible range, have the
// compression model summarize it, applyCompression to create an ACP block, and
// hand Pi the resulting summary for its compaction entry. This makes /compact
// behave like ACP's compress tool. If anything fails (no model, no ranges,
// kernel rejection), return undefined so Pi falls back to its default
// compaction — never return { cancel: true }, which makes Pi throw
// "Compaction cancelled" for manual compaction.
function wireCompactionDisable(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_before_compact", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages } = await runtime.stateFor(ctx);
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(state);
      const tokenCount = estimateTokens(coreMessages, coveredIds);

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      await runtime.save(turn.state, ctx);

      const ranges = (turn.nudge?.compressibleRanges ?? []).filter((r) => !r.dangerous);
      if (ranges.length === 0) return undefined;

      const span = selectRangeSpan(ranges, turn.messages, turn.state, config.compress?.minCompressRange ?? 5000);
      if (!span) return undefined;

      ctx.ui?.notify?.(t("compact.compressing", { tokens: span.tokens }), "info");
      const result = await summarizeRange(ctx, turn.messages, turn.state, span.startRef, span.endRef, config);
      if (!result) {
        ctx.ui?.notify?.(t("compact.failed"), "warning");
        return undefined;
      }
      const { summary, model } = result;

      const applied = runtime.core.applyCompression({
        ranges: [{ startRef: span.startRef, endRef: span.endRef, summary }],
        messages: turn.messages,
        state: turn.state,
        config,
      });
      const errors = applied.result.errors ?? [];
      if (errors.length > 0) {
        logWarn("compact", { sid, event: "rejected", span: `${span.startRef}..${span.endRef}`, model, errors });
        return undefined;
      }
      await runtime.save(applied.state, ctx);

      logInfo("compact", {
        sid,
        event: "acp-compaction",
        span: `${span.startRef}..${span.endRef}`,
        tokens: span.tokens,
        model,
        blocksCreated: applied.result.blocksCreated,
        reason: event.reason,
      });
      debug.event("compact-acp", { sid, span: `${span.startRef}..${span.endRef}`, tokens: span.tokens, model, reason: event.reason });

      ctx.ui?.notify?.(t("compact.done", { tokens: span.tokens, model }), "info");

      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    } catch (e) {
      logThrow("compact", e, { sid });
      return undefined;
    } finally {
      release();
    }
  });
}

// (acp_delegate injection is best-effort: sendUserMessage is fire-and-forget
// in pi, and interactive/rpc sessions are long-lived so their main loop
// consumes the follow-up queue naturally — no shutdown drain needed.)

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_start", async (_event, ctx) => {
    runtime.store.invalidate();
    runtime.clearNudgeTracking();
    resetDelegateUsage();
    setDelegateDisplayUsage("separate");
    const sid = ctx.sessionManager.getSessionId();
    logInfo("session", { event: "start", sid, cwd: ctx.cwd, debug: runtime.adapter.debug ?? null, version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null });
    try {
      const user = await loadUserConfig(ctx.cwd);
      runtime.setAdapter(applyUserConfig(runtime.adapter, user));
      setDelegateDisplayUsage(resolveDelegate(runtime.adapter).displayUsage);
      if (runtime.adapter.debug !== undefined) setDebugEnabled(runtime.adapter.debug);
      setLocale(runtime.adapter.language); // acp.json "language" 覆盖 LANG 检测
      registerCommands(pi, runtime); // 重新注册命令（同名覆盖）→ description 用配置语言
    } catch (e) {
      logThrow("config", e, { sid, phase: "session_start" });
    }
    if (resolveDelegate(runtime.adapter).enabled) {
      pi.registerTool(makeDelegateTool(pi));
      pi.registerTool(makeDelegateWaitTool(pi));
      pi.registerTool(makeDelegateCancelTool(pi));
    }
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
    // Idempotently ensure all builtin pi-subagents have ACP context tools
    // (compress/decompress/search_context/acp_status) in their allowlists.
    // Settings.json is patched safely (backup + optimistic mtime lock + verify).
    void runSetupAndNotify(ctx.hasUI ? (m) => ctx.ui.notify(m) : undefined);
    // Bind the TUI status widget for async delegates. The widget reads the
    // in-memory runs Map (via runningRunsSnapshot) and renders a live list of
    // running delegates below the editor. Only the interactive TUI has a UI;
    // rpc/json/print have hasUI=false and the call is a no-op.
    delegateStatusWidget.setContext(ctx, runningRunsSnapshot);
  });
  pi.on("session_shutdown", () => {
    delegateStatusWidget.dispose();
    closeLogStream();
  });
}

// The core integration: Pi's `context` event fires before every LLM call with the
// messages about to be sent. We run acp-kernel's processTurn (prune + ref-tag +
// nudge decision) and return the transformed AgentMessage[].
const AUTO_COMPRESS_COOLDOWN_MS = 30_000;
const lastAutoCompressAt = new Map<string, number>();
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("context", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages, entries } = await runtime.stateFor(ctx, event.messages);
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(state);
      // Prefer pi's real token count (anchored on provider usage) over our
      // chars/4 estimate — it includes the system prompt, tool schemas, and
      // trailing messages pi has not yet received a usage for. This is what the
      // footer percentage reflects, so nudge usage/growth will match what the
      // user sees.
      const realUsage = ctx.getContextUsage?.();
      const estimated = estimateTokens(coreMessages, coveredIds);
      const tokenCount = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : estimated;

      debug.event("context-in", {
        sid,
        eventMsgs: event.messages?.length ?? 0,
        entries: entries.length,
        coreMsgs: coreMessages.length,
        tokenCount,
        estimatedTokens: estimated,
        realTokens: realUsage?.tokens ?? null,
        realPercent: realUsage?.percent ?? null,
        limit: config.modelContextLimit,
        blocksBefore: state.blocks.length,
        activeBefore: state.blocks.filter((b) => b.active).length,
      });

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      pruneStaleRefs(turn.state, coreMessages.map((m) => m.id));
      await runtime.save(turn.state, ctx);

      logInfo("turn", {
        sid,
        inMsgs: coreMessages.length,
        outMsgs: turn.messages.length,
        tokens: tokenCount,
        pct: realUsage?.percent ?? (config.modelContextLimit > 0 ? Math.round((tokenCount / config.modelContextLimit) * 100) : null),
        limit: config.modelContextLimit,
        nudge: turn.nudge?.shouldInject ? (turn.nudge.breakdown?.emergencyOverride === 1 ? "emergency" : "active") : "idle",
        nudgeReason: turn.nudge?.reason ?? null,
        blocks: turn.state.blocks.length,
        activeBlocks: turn.state.blocks.filter((b) => b.active).length,
      });

      debug.event("processTurn", {
        outMsgs: turn.messages.length,
        summaryMsgs: turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        prunedMsgs: coreMessages.length - turn.messages.length + turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        nudgeShouldInject: turn.nudge?.shouldInject ?? false,
        nudgeReason: turn.nudge?.reason ?? null,
        nudgeVoice: turn.nudge ? renderNudgeText(turn.nudge).voice : null,
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

    // usageTrigger channel: config-driven threshold (acp.json "usageTriggerPercent",
    // default 25, 0=disabled). Kernel's growth model may not fire yet, but usage
    // crossing the threshold with compressible content is enough to nudge.
const triggerPct = config.usageTriggerPercent ?? 25;
    const nudgeUsage = turn.nudge?.contextUsage ?? 0;
    const usageTriggered =
      triggerPct > 0 &&
      !turn.nudge?.shouldInject &&
      nudgeUsage >= triggerPct / 100 &&
      (turn.nudge?.compressibleRanges?.length ?? 0) > 0;
    if (usageTriggered) debug.event("usage-triggered", { pct: Math.round(nudgeUsage * 100), threshold: triggerPct });
    if (turn.nudge && (turn.nudge.shouldInject || usageTriggered)) {
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
      const turnKey = lastUserMessageId(entries) ?? sid;
      const alreadyShown = !emergency && runtime.nudgeShownFor(turnKey);
      if (!alreadyShown) {
        // Emergency nudges fire on every context event (streaming/tool loop) —
        // throttle the blocking compression-model call so one reply is not
        // stalled repeatedly while usage stays above 80%.
        const lastAuto = lastAutoCompressAt.get(sid) ?? 0;
        const throttled = Date.now() - lastAuto < AUTO_COMPRESS_COOLDOWN_MS;
        // With a compression model configured (/acp-config), intercept the nudge:
        // have that model compress the largest safe range directly instead of
        // asking the main model to spend its tokens. Falls back to injection.
        const autoResult = throttled
          ? { applied: false, fatal: false, error: "throttled" }
          : await autoCompress(ctx, runtime, { messages: turn.messages, state: turn.state, nudge: turn.nudge }, config);
        if (autoResult.applied) {
          lastAutoCompressAt.set(sid, Date.now());
          runtime.markNudgeShown(turnKey);
          debug.event("nudge-auto-compressed", { sid: ctx.sessionManager.getSessionId(), turnKey, pct: Math.round(turn.nudge.contextUsage * 100) });
        } else if (autoResult.fatal) {
          // Config error (model not found, auth missing) — stop nudge attempts to avoid infinite loop
          const wasShown = runtime.nudgeShownFor(turnKey);
          runtime.markNudgeShown(turnKey);
          if (!wasShown) {
            logWarn("nudge", { sid: ctx.sessionManager.getSessionId(), event: "auto-compress-fatal", error: autoResult.error, turnKey });
          }
          if (!wasShown && debugOn && ctx.hasUI) {
            ctx.ui.notify(`[ACP auto-compress disabled] ${autoResult.error}\nRun /acp-config to fix compression model configuration.`);
          }
          debug.event("nudge-fatal", { sid: ctx.sessionManager.getSessionId(), voice: "fatal", channels: ["context", debugOn ? "terminal" : null].filter(Boolean), turnKey, error: autoResult.error });
        } else {
          const minChars = config.compress?.minCompressRange ?? 5000;
          const compressibleChars = totalCompressibleChars(turn.nudge.compressibleRanges, turn.messages, turn.state);
          if (compressibleChars < minChars) {
            // Nothing can pass the kernel's minCompressRange check — injecting
            // the nudge would just make the model attempt impossible compressions
            // (and emergency nudges repeat every turn). Skip it.
            const wasShown = runtime.nudgeShownFor(turnKey);
            runtime.markNudgeShown(turnKey);
            if (!wasShown) {
              logInfo("nudge", { sid, event: "nudge-skipped", reason: turn.nudge.reason, compressibleChars, minChars });
            }
            debug.event("nudge-skipped", { sid, turnKey, emergency, compressibleChars, minChars, reason: turn.nudge.reason });
          } else {
            rebuilt.push(nudgeMessage(turn.nudge, turn.state.blocks.filter((b) => b.active), minChars));
            const rendered = renderNudgeText(turn.nudge);
            const top = [...turn.nudge.compressibleRanges].filter((r) => !r.dangerous).sort((a, b) => b.tokens - a.tokens)[0];
            const example = top ? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })` : "";
            if (emergency) {
              logWarn("nudge", { sid: ctx.sessionManager.getSessionId(), event: "emergency-inject", pct: Math.round(turn.nudge.contextUsage * 100), voice: rendered.voice, compressible: turn.nudge.compressibleRanges.length });
            }
            if (debugOn && ctx.hasUI) {
              ctx.ui.notify(`[ACP nudge → context]${emergency ? " [EMERGENCY]" : ""}\n${rendered.text}${example}`);
            }
            if (!emergency) runtime.markNudgeShown(turnKey);
            debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, channels: ["context", debugOn ? "terminal" : null].filter(Boolean), emergency, turnKey, text: rendered.text + example });
          }
        }
      } else {
        debug.event("nudge-suppressed", { sid: ctx.sessionManager.getSessionId(), turnKey, reason: turn.nudge.reason });
      }
    }

    // Always return the transformed array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
    debug.event("context-out", { outMsgs: rebuilt.length, injected: turn.nudge?.shouldInject ?? false, emergency: turn.nudge?.breakdown?.emergencyOverride === 1 });
    // Also check for updates here (not only on session_start): resuming a
    // long-running session never re-fires session_start, so an update could
    // go unnoticed for days. checkForUpdate throttles internally (3 min) and
    // is guarded against concurrent calls, so firing it per LLM call is safe.
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
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
    const delegate = runtime.adapter.delegate !== false;
    const prompt = delegate ? `${ACP_SYSTEM_PROMPT}\n${ACP_DELEGATE_PROMPT}` : ACP_SYSTEM_PROMPT;
    return { systemPrompt: formatSystemPromptForEvent(event.systemPrompt, prompt) };
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

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[], minCompressChars: number): AgentMessage {
  const rendered = renderNudgeText(nudge);
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
    lines.push(t("nudge.compressedBlocks", { count: blocks.length, tiers: tierStr, summary: fmt(totalSummary), original: fmt(totalCompressed), ids, more: extra }));
  }

  if (!(nudge.tier !== null && nudge.tier >= 2)) {
    lines.push("");
    lines.push(t("nudge.minChars", { min: minCompressChars }));
  }

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
