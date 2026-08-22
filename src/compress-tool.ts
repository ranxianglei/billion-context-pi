import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug, logError, logInfo, logThrow, logWarn } from "./log.js";
import { estimateTokens, collectCoveredMessageIds, calibrateTokens } from "./tokens.js";
import { defaultCountTokens, salvageParseRanges, type CompressionBlock } from "acp-kernel";
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
  content: Type.Union([
    Type.Array(RangeSpec),
    // Non-strict-tool providers (vLLM openai-completions, supportsStrictTools:
    // false) sometimes stringify nested array arguments — session
    // 01a00a38 died on exactly this: pi's typebox validation rejected
    // "[{\"topic\":...}]" with "content.0: must be object" and the turn's
    // only compress attempt was lost. Accept the JSON-encoded form and parse
    // it in normalizeRanges below.
    Type.String({ description: "JSON-encoded array of ranges — accepted because non-strict-tool providers sometimes stringify array arguments; parsed automatically." }),
  ], { description: "One or more ranges to compress, each with start/end boundaries and a summary. When compressing multiple unrelated ranges in one call, give each its own topic." }),
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
      let result: string;
      try {
        result = await handleCompress(params as CompressArgs, runtime, ctx, toolCallId);
      } catch (e) {
        logThrow("compress", e, { sid: ctx.sessionManager.getSessionId(), ranges: typeof (params as CompressArgs).content === "string" ? "string" : ((params as CompressArgs).content?.length ?? 0) });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

type RangeEntry = Static<typeof RangeSpec>;

// Normalize the content argument: array passes through; a JSON-encoded string
// (non-strict-tool providers) is parsed. Returns an error string on bad input —
// handleCompress THROWS it so pi marks the toolResult isError:true and the
// retry nudge (src/index.ts) can quote it back (returning it normally would
// produce isError:false, which both skips the nudge and resets the counter).
function normalizeRanges(content: CompressArgs["content"]): RangeEntry[] | string {
  let ranges: unknown = content ?? [];
  if (typeof ranges === "string") {
    try {
      ranges = JSON.parse(ranges);
    } catch (e) {
      // Weak/local models emit truncated or malformed JSON here ~50% of the
      // time (see billion-context-omp#121). Before giving up, run the kernel's
      // salvage ladder (fences / comma+newline repairs / truncated-array
      // prefix / field-regex). Recovered entries proceed as normal ranges.
      const sal = salvageParseRanges(ranges as string);
      logWarn("compress", {
        event: "content-salvage",
        layer: sal.layer,
        note: sal.note,
        ranges: sal.ranges.length,
      });
      if (sal.ranges.length > 0) {
        return sal.ranges.map((r) => ({ startId: r.startRef, endId: r.endRef, summary: r.summary, ...(r.topic ? { topic: r.topic } : {}) })) as RangeEntry[];
      }
      return `Invalid content: not valid JSON (${e instanceof Error ? e.message : String(e)}). content must be an ARRAY of {startId, endId, summary} objects — pass the array directly, not a string.`;
    }
  }
  if (!Array.isArray(ranges)) {
    return `Invalid content: expected an array of ranges, got ${ranges === null ? "null" : typeof ranges}.`;
  }
  for (const [i, r] of ranges.entries()) {
    const o = r as Record<string, unknown>;
    if (!o || typeof o !== "object" || typeof o.startId !== "string" || typeof o.endId !== "string" || typeof o.summary !== "string") {
      return `Invalid content[${i}]: each range must be an object with string fields startId, endId, summary.`;
    }
  }
  return ranges as RangeEntry[];
}

/** Panel block count ("… (~N reclaimed, B blocks)"), or -1 for non-panels. */
function compressPanelBlocks(text: string): number {
  if (!text.trimStart().startsWith("▣ ACP |")) return -1;
  const m = text.match(/, (\d+) blocks?\)/);
  return m ? Number(m[1]) : -1;
}

/** Success = completed run that created >= 1 block (partial range errors
 *  still count: progress was made). A 0-block panel must NOT be success —
 *  it would reset the retry counter while the emergency nudge re-fires,
 *  looping no-op compressions (issue #6). */
export function isCompressSuccessText(text: string): boolean {
  return compressPanelBlocks(text) > 0;
}

/** No-op = completed run that compressed nothing (0-block panel: every
 *  range skipped). Counted as a FAILED attempt by noteCompressOutcomes so
 *  the retry cap applies. Non-panels ("No ranges provided.") stay neutral. */
export function isCompressNoopText(text: string): boolean {
  return compressPanelBlocks(text) === 0;
}

function tier3OnlyRewrite(newBlocks: CompressionBlock[], allBlocks: CompressionBlock[]): string[] | null {
  if (newBlocks.length === 0) return null;
  const byId = new Map(allBlocks.map((b) => [b.blockId, b]));
  const spans: string[] = [];
  for (const b of newBlocks) {
    const consumed = b.directBlockIds.map((id) => byId.get(id));
    if (
      b.tier !== 3 ||
      b.directMessageIds.length > 0 ||
      b.directBlockIds.length === 0 ||
      consumed.some((c) => !c || c.tier !== 3)
    ) {
      return null;
    }
    spans.push(`${b.startRef ?? "?"}..${b.endRef ?? "?"}`);
  }
  return spans;
}

async function handleCompress(args: CompressArgs, runtime: AcpRuntime, ctx: ExtensionContext, toolCallId?: string): Promise<string> {
  const maybeRanges = normalizeRanges(args.content);
  // Argument errors throw (not return): pi-agent-core only sets isError:true
  // on THROWN tool errors, and the retry nudge keys off isError. A returned
  // string would land as isError:false — no nudge, and the counter resets.
  if (typeof maybeRanges === "string") throw new Error(maybeRanges);
  const ranges = maybeRanges;
  if (ranges.length === 0) return "No ranges provided.";
  const { state: initialState, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Sent-view arbitration — the same scale as the context transform and
  // acp_status (see src/index.ts): never the session-tree tokenCount.
  const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const sentTokens = estimateTokens(coreMessages, collectCoveredMessageIds(initialState)) + systemPromptTokens;
  const turn = runtime.core.processTurn({
    messages: coreMessages,
    state: initialState,
    config,
    tokenCount: calibrateTokens(sentTokens, runtime.density.densityFor(modelId)),
  });
  const state = turn.state;
  const messages = turn.messages;
  // Display-layer density alignment (doc §3.3): beforeTokens is calibrated to
  // the same scale as the kernel's injected countTokens (which already carries
  // density), so the numbers the model sees match real usage.
  const density = runtime.density.densityFor(modelId);
  const beforeTokens = calibrateTokens(estimateTokens(messages, collectCoveredMessageIds(state)), density);
  const summaryMaxChars = args.summaryMaxChars;
  const topLevelTopic = args.topic;

  debug.event("compress-in", {
    sid: ctx.sessionManager.getSessionId(),
    modelId,
    density,
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
  const rewriteSpans = applied.result.blocksCreated > 0
    ? tier3OnlyRewrite(applied.state.blocks.slice(-applied.result.blocksCreated), applied.state.blocks)
    : null;
  if (rewriteSpans) {
    await runtime.save(state, ctx);
    logWarn("compress", {
      sid: ctx.sessionManager.getSessionId(),
      event: "tier3-rewrite-rejected",
      spans: rewriteSpans,
    });
    throw new Error(
      `Range ${rewriteSpans.join(", ")} only re-condenses terminal tier-3 block(s) — T3 is the highest tier, so rewriting it reclaims nothing and can repeat forever (dog/billion-context-pi#3). Nothing was compressed. ` +
        `Use search_context or decompress to retrieve details, or pick a range containing uncompressed messages (acp_status lists compressible ranges).`,
    );
  }
  await runtime.save(applied.state, ctx);
  const { blocksCreated, tokensCompressed, errors, warnings } = applied.result;

  // Re-measure the post-compression sent view on the SAME scale as beforeTokens
  // (post-processTurn view: visible text + every active block's summary anchor
  // + ref-tag overhead), so "X → Y (~Z reclaimed)" compares like-for-like —
  // including the new block's own summary, which the model will pay for next.
  const afterTurn = runtime.core.processTurn({
    messages: coreMessages,
    state: applied.state,
    config,
    tokenCount: calibrateTokens(sentTokens, density),
  });
  const afterTokens = calibrateTokens(estimateTokens(afterTurn.messages, collectCoveredMessageIds(applied.state)), density);
  const reclaimed = Math.max(0, beforeTokens - afterTokens);

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
    logWarn("compress", { sid: ctx.sessionManager.getSessionId(), event: "warnings", count: warnings.length, warnings: warnings.slice(0, 5) });
  }

  const lines = [`▣ ACP | ${formatK(beforeTokens)} → ${formatK(afterTokens)} tokens (~${formatK(reclaimed)} reclaimed, ${blocksCreated} block${blocksCreated > 1 ? "s" : ""})`];
  if (warnings.length > 0) lines.push("⚠️ " + warnings.join("; "));
  if (errors.length > 0) lines.push("Errors: " + errors.join("; "));
  return lines.join("\n");
}
