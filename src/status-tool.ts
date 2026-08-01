import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { buildStatusReport, defaultCountTokens } from "acp-kernel";
import { estimateTokens, collectCoveredMessageIds } from "./tokens.js";

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

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
      const result = await handleStatus(params as StatusArgs, runtime, ctx);
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleStatus(args: StatusArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Run the same pipeline (assign-refs → prune → hide-compress-calls → ...) that
  // the context transform runs, so what acp_status reports matches what the
  // model actually receives. Without this, consumed/hidden compress calls and
  // pruned messages showed up in acp_status even though they never reached
  // the model.
  const tokenCount = estimateTokens(coreMessages, collectCoveredMessageIds(state));
  const realUsage = ctx.getContextUsage?.();
  const turn = runtime.core.processTurn({
    messages: coreMessages,
    state,
    config,
    tokenCount: realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : tokenCount,
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
  const ranges = nudge?.compressibleRanges ?? [];

  const extra: string[] = [];
  if (nudge) {
    extra.push("");
    extra.push(
      nudge.shouldInject
        ? `Nudge: ACTIVE — ${nudge.reason}`
        : `Nudge: idle — ${nudge.reason}`,
    );
  }
  if (ranges.length > 0) {
    extra.push("");
    extra.push(`Compressible Ranges (${ranges.length}):`);
    for (const r of ranges) {
      const tools = r.toolPct > 0 ? ` (${Math.round(r.toolPct)}% tools)` : "";
      extra.push(`  ${r.startRef}\u2013${r.endRef}  (${r.count} msgs, ${fmtTokens(r.tokens)}${tools})`);
    }
  }
  const protectedRanges = nudge?.protectedRanges ?? [];
  if (protectedRanges.length > 0) {
    extra.push("");
    extra.push(`Protected Ranges (${protectedRanges.length}, do not compress):`);
    for (const r of protectedRanges) {
      const tools = r.tools.length > 0 ? ` [${r.tools.join(", ")}]` : "";
      extra.push(`  ${r.startRef}\u2013${r.endRef}  (${r.count} msgs, ${fmtTokens(r.tokens)}${tools})`);
    }
  }
  return extra.length > 0 ? `${base}\n${extra.join("\n")}` : base;
}
