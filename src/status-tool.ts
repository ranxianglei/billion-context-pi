import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { buildStatusReport, defaultCountTokens, formatRanges, viableRanges } from "acp-kernel";
import { estimateTokens, collectCoveredMessageIds, collectImageTokens, modelSupportsImages, adjustedTokenCount } from "./tokens.js";
import { usageAnchorPredatesCompression } from "./floor-stale.js";
import { applyOutputHeadroom } from "./overflow-selfheal.js";
import { getSystemPromptText } from "./compat.js";
import { logThrow } from "./log.js";
import { getDelegateUsage } from "./delegate-tool.js";
import { resolveDelegate } from "./config.js";
import { OMP_UNSUPPORTED_MESSAGE } from "./omp.js";

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
      if (runtime.refused) return { details: undefined, content: [{ type: "text", text: runtime.refusalMessage ?? OMP_UNSUPPORTED_MESSAGE }] };
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
  // Same real request limit (window − output headroom) as the live context
  // transform, so the reported percentages match the nudge bands (issue #267).
  const config = applyOutputHeadroom(runtime.configFor(ctx), ctx.model);
  // Run the same pipeline (assign-refs → prune → hide-compress-calls → ...) that
  // the context transform runs, so what acp_status reports matches what the
  // model actually receives. Without this, consumed/hidden compress calls and
  // pruned messages showed up in acp_status even though they never reached
  // the model.
  const coveredIds = collectCoveredMessageIds(state);
  // Sent-view arbitration (same scale as the context transform), floored at
  // the host's real context usage (issue #257; see src/index.ts).
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const imageTokens = collectImageTokens(entries, modelSupportsImages(ctx.model));
  const sentTokens = estimateTokens(coreMessages, coveredIds, imageTokens) + systemPromptTokens;
  // View-based recount (issue #289): with active blocks the raw-view estimate
  // can sit far above the sent view and mis-scale the nudge shown here — same
  // arbitration as src/index.ts. The host floor (#257) applies on top of the
  // winning base.
  const viewSentTokens = adjustedTokenCount(runtime.core, coreMessages, state, config, sentTokens, imageTokens, systemPromptTokens);
  const providerReal = ctx.getContextUsage?.()?.tokens ?? 0;
  const anchorStale = usageAnchorPredatesCompression(entries);
  const turn = runtime.core.processTurn({
    messages: coreMessages,
    state,
    config,
    tokenCount: anchorStale ? viewSentTokens : Math.max(viewSentTokens, providerReal),
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
  // issue #257: side-by-side estimate vs provider-real so estimator drift is
  // visible at a glance (Estimate is the pre-floor sent-view meter).
  if (providerReal > 0 && config.modelContextLimit > 0) {
    const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const estPct = Math.round((viewSentTokens / config.modelContextLimit) * 100);
    const realPct = Math.round((providerReal / config.modelContextLimit) * 100);
    extra.push("");
    extra.push(
      `Estimate: ${fmtK(viewSentTokens)} (${estPct}%)   |   Provider-reported: ${fmtK(providerReal)} (${realPct}%)`,
    );
  }
  if (nudge) {
    extra.push("");
    extra.push(
      nudge.shouldInject
        ? `Nudge: ACTIVE — ${nudge.reason}`
        : `Nudge: idle — ${nudge.reason}`,
    );
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
