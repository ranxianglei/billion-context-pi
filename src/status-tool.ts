import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { buildStatusReport, defaultCountTokens, formatRanges, viableRanges } from "acp-kernel";
import { estimateTokens, collectCoveredMessageIds, calibrateTokens, collectImageTokens, modelSupportsImages } from "./tokens.js";
import { getSystemPromptText } from "./compat.js";
import { logThrow } from "./log.js";
import { getDelegateUsage } from "./delegate-tool.js";
import { resolveDelegate, resolveRollover } from "./config.js";
import { pendingHasWork } from "./rollover.js";

const StatusParams = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal("compressed"), Type.Literal("uncompressed")], { description: '"compressed" = drill into blocks; "uncompressed" = show visible messages/ranges. Default: overview.' })),
  view: Type.Optional(Type.Union([Type.Literal("ranges"), Type.Literal("messages")], { description: 'For uncompressed scope: "ranges" (default) or "messages" (per-message listing).' })),
  tool: Type.Optional(Type.String({ description: 'Filter by tool name (e.g. "bash", "read"). Only for uncompressed+messages.' })),
  sort: Type.Optional(Type.Union([Type.Literal("size"), Type.Literal("time"), Type.Literal("tool"), Type.Literal("age")], { description: "Sort order. Default: size." })),
  limit: Type.Optional(Type.Number({ description: "Max items to show (default: 30)." })),
});

type StatusArgs = Static<typeof StatusParams>;

export function makeStatusTool(runtime: AcpRuntime): ToolDefinition<typeof StatusParams> {
  return {
    name: "acp_status",
    label: "ACP Status",
    description:
      "Context status: overview, compressed blocks, or uncompressed ranges/messages. No args = overview + totals + compressible ranges. scope:'uncompressed' + view:'messages' for per-message listing. scope:'compressed' for block drilldown.",
    promptSnippet: 'acp_status({}) or acp_status({ scope: "uncompressed", view: "messages" })',
    promptGuidelines: [
      "Call with no args for a quick overview of context usage.",
      "Use scope:'uncompressed' to find the largest compressible ranges.",
      "Use scope:'compressed' to inspect existing compression blocks.",
    ],
    parameters: StatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      let result: string;
      try {
        result = await handleStatus(params as StatusArgs, runtime, ctx);
      } catch (e) {
        logThrow("status", e, { sid: ctx.sessionManager.getSessionId(), scope: (params as StatusArgs).scope ?? null });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleStatus(args: StatusArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const { state, coreMessages, entries } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Run the same pipeline (assign-refs → prune → hide-compress-calls → ...) that
  // the context transform runs, so what acp_status reports matches what the
  // model actually receives. Without this, consumed/hidden compress calls and
  // pruned messages showed up in acp_status even though they never reached
  // the model.
  const coveredIds = collectCoveredMessageIds(state);
  // Sent-view arbitration (same scale as the context transform): never the
  // session-tree number from getContextUsage, which includes compressed
  // originals and never shrinks (false emergencies; see src/index.ts).
  const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const sentTokens = estimateTokens(coreMessages, coveredIds, collectImageTokens(entries, modelSupportsImages(ctx.model))) + systemPromptTokens;
  const tokenCount = calibrateTokens(sentTokens, runtime.density.densityFor(modelId));
  const turn = runtime.core.processTurn({
    messages: coreMessages,
    state,
    config,
    tokenCount,
  });
  const processed = turn.messages;

  const base = buildStatusReport(turn.state, processed, defaultCountTokens, {
    scope: args.scope,
    view: args.view,
    tool: args.tool,
    sort: args.sort,
    limit: args.limit,
  });

  // Overview mode additionally surfaces the nudge decision and compressible
  // ranges — the same info the /acp slash command shows. Drill-down modes
  // (scope: compressed/uncompressed) return the base report as-is.
  if (args.scope) return base;

  const nudge = turn.nudge;
  const ranges = viableRanges(nudge?.compressibleRanges ?? []);
  const protectedRanges = nudge?.protectedRanges ?? [];

  const extra: string[] = [];
  if (nudge) {
    extra.push("");
    extra.push(
      nudge.shouldInject
        ? `Nudge: ACTIVE — ${nudge.reason}`
        : `Nudge: idle — ${nudge.reason}`,
    );
  }
  const rollover = resolveRollover(runtime.adapter);
  if (rollover.enabled) {
    const pending = runtime.getRolloverPending(ctx);
    if (pending && pendingHasWork(pending)) {
      const pendingTokens =
        pending.compressions.reduce((s, c) => s + c.estTokens, 0) +
        pending.absorbs.reduce((s, a) => s + a.tokensReclaimed, 0);
      const usagePct = config.modelContextLimit > 0 ? Math.round((tokenCount / config.modelContextLimit) * 100) : 0;
      extra.push("");
      extra.push(
        `Rollover: ${pending.compressions.length} pending compression(s) + ${pending.absorbs.length} absorb(s) — ~${pendingTokens.toLocaleString()} tokens pending (threshold ${Math.round(rollover.threshold * 100)}%, current ${usagePct}%)`,
      );
    }
  }
  if (ranges.length > 0 || protectedRanges.length > 0) {
    extra.push("");
    // Reuse the kernel's merged range formatter so acp_status, the nudge,
    // and /acp all render compressible+protected ranges identically
    // (merged oldest-first, with mixed-range breakdowns).
    extra.push(formatRanges(ranges, protectedRanges));
  }
  const delegateUsage = getDelegateUsage();
  if (delegateUsage && delegateUsage.totalTokens > 0) {
    extra.push("");
    const cost = delegateUsage.cost.total;
    const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";
    extra.push("── Session delegate usage (excluded from main totals) ──");
    extra.push(`Tokens: ${delegateUsage.input.toLocaleString()} in, ${delegateUsage.output.toLocaleString()} out (${delegateUsage.totalTokens.toLocaleString()} total)${costStr}`);
  } else if (resolveDelegate(runtime.adapter).displayUsage === "merged") {
    extra.push("");
    extra.push("merged mode: delegate usage is included in main session totals.");
  } else {
    extra.push("");
    extra.push("Delegate usage: none this session.");
  }
  return extra.length > 0 ? `${base}\n${extra.join("\n")}` : base;
}
