import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug, logError, logInfo, logThrow } from "./log.js";
import { tryForwardTool } from "./cooperative.js";
import { estimateTokens, collectCoveredMessageIds } from "./tokens.js";
import { defaultCountTokens } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

const RangeSpec = Type.Object({
  startId: Type.String({ description: 'Message ref, e.g. "m00005" (from the acp tag), or a block id "b3".' }),
  endId: Type.String({ description: 'Inclusive end ref. Must be at or after startId.' }),
  summary: Type.String({ description: "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.)." }),
  topic: Type.Optional(Type.String({ description: "Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'. Omit to use top-level topic. When compressing multiple unrelated ranges, give each its own topic for better quality." })),
});

const CompressParams = Type.Object({
  topic: Type.Optional(Type.String({ description: "Fallback topic for entries without their own. Omit when each content entry specifies its own topic." })),
  content: Type.Array(RangeSpec, { description: "One or more ranges to compress, each with start/end boundaries and a summary. When compressing multiple unrelated ranges in one call, give each its own topic." }),
  summaryMaxChars: Type.Optional(Type.Number({ description: "Override max summary length (default max: 20000 chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit." })),
});

type CompressArgs = Static<typeof CompressParams>;

export function makeCompressTool(runtime: AcpRuntime): ToolDefinition<typeof CompressParams> {
  return {
    name: "compress",
    label: "Compress",
    description:
      "Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ startId, endId, summary }] }). Batch: compress({ content: [{ topic, startId, endId, summary }, ...] }) — each entry gets its own summary.",
    promptSnippet: "compress({ content: [{ startId, endId, summary }] }) or batch multiple ranges",
    promptGuidelines: [
      "Each message has an acp tag with its mNNNNN ref, token size, and type. Compress ranges by their refs.",
      "Batch multiple unrelated ranges in one call — each gets its own topic and summary.",
      "Write dense, self-contained summaries — preserve file paths, signatures, errors, and decisions verbatim.",
      "Never compress content the current step is actively using.",
    ],
    parameters: CompressParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const forwarded = await tryForwardTool("compress", params, ctx);
      if (forwarded !== undefined) {
        return { details: undefined, content: [{ type: "text", text: forwarded }] };
      }
      let result: string;
      try {
        result = await handleCompress(params as CompressArgs, runtime, ctx, toolCallId);
      } catch (e) {
        logThrow("compress", e, { sid: ctx.sessionManager.getSessionId(), ranges: (params as CompressArgs).content?.length ?? 0 });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleCompress(args: CompressArgs, runtime: AcpRuntime, ctx: ExtensionContext, toolCallId?: string): Promise<string> {
  const ranges = args.content ?? [];
  if (ranges.length === 0) return "No ranges provided.";
  const { state: initialState, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Sent-view arbitration — the same scale as the context transform and
  // acp_status. processTurn here persists nudge stamps via the saved state,
  // so a tree-scale tokenCount (provider fallback summing the whole session,
  // never shrinks) would poison lastNudgeShownTokens/lastShownByTier at the
  // wrong scale and suppress legitimate growth nudges afterward.
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const sentTokens = estimateTokens(coreMessages, collectCoveredMessageIds(initialState)) + systemPromptTokens;
  const turn = runtime.core.processTurn({
    messages: coreMessages,
    state: initialState,
    config,
    tokenCount: sentTokens,
  });
  const state = turn.state;
  const messages = turn.messages;
  const beforeTokens = estimateTokens(messages, collectCoveredMessageIds(state));
  const summaryMaxChars = args.summaryMaxChars;
  const topLevelTopic = args.topic;

  debug.event("compress-in", {
    sid: ctx.sessionManager.getSessionId(),
    ranges: ranges.length,
    spans: ranges.map((r) => ({ span: `${r.startId}..${r.endId}`, summaryLen: r.summary.length, summary: r.summary, topic: r.topic ?? topLevelTopic ?? null })),
    blocksBefore: state.blocks.length,
    activeBefore: state.blocks.filter((b) => b.active).length,
    beforeMsgCount: messages.length,
    beforeTokens,
  });

  const applied = runtime.core.applyCompression({
    ranges: ranges.map((r) => ({ startRef: r.startId, endRef: r.endId, summary: r.summary, topic: r.topic ?? topLevelTopic, summaryMaxChars, compressCallId: toolCallId })),
    messages,
    state,
    config,
  });
  await runtime.save(applied.state, ctx);
  const { blocksCreated, tokensCompressed, errors, warnings } = applied.result;

  const afterTokens = Math.max(0, beforeTokens - tokensCompressed);

  const newBlocks = applied.state.blocks.slice(-blocksCreated);
  debug.event("compress-out", {
    sid: ctx.sessionManager.getSessionId(),
    blocksCreated,
    tokensCompressed,
    beforeTokens,
    afterTokens,
    afterMsgCount: applied.state.blocks.length,
    errors: errors.length,
    errorDetails: errors.slice(0, 3),
    blocksAfter: applied.state.blocks.length,
    activeAfter: applied.state.blocks.filter((b) => b.active).length,
    newBlocks: newBlocks.map((b) => ({ blockId: b.blockId, tier: b.tier, summaryLen: b.summary.length, directMsgCount: b.directMessageIds.length, effectiveMsgCount: b.effectiveMessageIds.length, summary: b.summary })),
  });

  logInfo("compress", {
    sid: ctx.sessionManager.getSessionId(),
    event: "applied",
    ranges: ranges.length,
    blocksCreated,
    tokensCompressed,
    beforeTokens,
    afterTokens,
    warnings: warnings.length,
    errors: errors.length,
    newBlockIds: newBlocks.map((b) => b.blockId),
  });
  if (errors.length > 0) {
    logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "errors", count: errors.length, errors: errors.slice(0, 5) });
  }
  if (warnings.length > 0) {
    logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "warnings", count: warnings.length, warnings: warnings.slice(0, 5) });
  }

  const lines = [`▣ ACP | ${formatK(beforeTokens)} → ${formatK(afterTokens)} tokens (~${formatK(tokensCompressed)} reclaimed, ${blocksCreated} block${blocksCreated > 1 ? "s" : ""})`];
  if (warnings.length > 0) lines.push("⚠️ " + warnings.join("; "));
  if (errors.length > 0) lines.push("Errors: " + errors.join("; "));
  return lines.join("\n");
}
