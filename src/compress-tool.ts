import { Type, type Static } from "typebox";
import {
  convertToLlm,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Api, Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import type { AcpRuntime } from "./runtime.js";
import { debug, logError, logInfo, logThrow, logWarn } from "./log.js";
import { estimateTokens, collectCoveredMessageIds, calibrateTokens, collectImageTokens, modelSupportsImages } from "./tokens.js";
import { defaultCountTokens, parseCompressArgs, resolveBoundaries, type CompressionBlock, type CompressParseDiagnostics, type CoreMessage, type CompressionState } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";
import { buildSummarizeSystemPrompt, truncateContent, SESSION_MODEL_REF, type ResolvedCompressionModel } from "./compress-model.js";

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

/** Tool description is dynamic: when a dedicated compression model is
 *  configured, the main model only chooses ranges and passes a minimal
 *  placeholder summary (the compression model writes the real one) — saving the
 *  main model's output tokens. Without one, the main model writes full summaries. */
function compressDescription(ref: string | undefined): string {
  if (ref) {
    return (
      "Replace older conversation ranges with summaries. A dedicated compression model (" + ref +
      ") writes the summaries — you only choose the ranges. Pass a MINIMAL placeholder for each range's `summary` " +
      "(e.g. \"compressed\"); it will be replaced by the compression model. Do NOT write a full summary. " +
      "Single range: compress({ content: [{ startId, endId, summary: \"compressed\" }] }). " +
      "Batch: compress({ content: [{ topic, startId, endId, summary: \"compressed\" }, ...] })."
    );
  }
  return (
    "Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ startId, endId, summary }] }). " +
    "Batch: compress({ content: [{ topic, startId, endId, summary }, ...] }) — each entry gets its own summary."
  );
}

export function makeCompressTool(runtime: AcpRuntime, pi: ExtensionAPI): ToolDefinition<typeof CompressParams> {
  return {
    name: "compress",
    label: "Compress",
    get description() {
      return compressDescription(runtime.getCompressionModelRef());
    },
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
        result = await handleCompress(params as CompressArgs, runtime, ctx, toolCallId, collectActiveTools(pi));
      } catch (e) {
        logThrow("compress", e, { sid: ctx.sessionManager.getSessionId(), ranges: typeof (params as CompressArgs).content === "string" ? "string" : ((params as CompressArgs).content?.length ?? 0) });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

/** The active tools as pi-ai Tool[] — reused as the dedicated compression
 *  model's prompt prefix (the "session" ref) so its request matches the main
 *  model's and hits the provider's prompt cache. Defensive: a minimal host /
 *  test mock without these methods yields [] (cache is best-effort). */
function collectActiveTools(pi: ExtensionAPI): Tool[] {
  try {
    const active = new Set(pi.getActiveTools());
    return pi
      .getAllTools()
      .filter((t: ToolInfo) => active.has(t.name))
      .map((t: ToolInfo) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  } catch {
    return [];
  }
}

type RangeEntry = Static<typeof RangeSpec>;

// Normalize the compress args via the kernel's lenient parser (fenced /
// trailing-comma / raw-newline / double-stringified / truncated-salvage).
// Returns an error string on bad input — handleCompress THROWS it so pi marks
// the toolResult isError:true, which is what makes the outcome count toward
// the failure cap (a returned string would land as isError:false and count
// as neutral). An empty array passes through (the call site returns "No
// ranges provided.").
function normalizeRanges(args: CompressArgs): RangeEntry[] | string {
  const { ranges, diagnostics } = parseCompressArgs(args);
  if (ranges.length === 0) {
    if (Array.isArray(args.content) && args.content.length === 0) return [];
    return describeDiagnostics(diagnostics, args.content);
  }
  return ranges.map((r) => ({ startId: r.startRef, endId: r.endRef, summary: r.summary, topic: r.topic }));
}

function describeDiagnostics(diagnostics: CompressParseDiagnostics, content: CompressArgs["content"]): string {
  const shape = typeof content === "string"
    ? "a JSON-encoded string (non-strict-tool providers stringify array arguments)"
    : content === null ? "null" : `a ${typeof content}`;
  const base = `Invalid compress content (${diagnostics.kind}): got ${shape}`;
  if (diagnostics.kind === "truncated") {
    return `${base}; the input was truncated and no complete ranges could be recovered. Shorten the summary or split into smaller ranges.`;
  }
  if (diagnostics.invalidItems > 0) {
    return `${base}; ${diagnostics.invalidItems} entr${diagnostics.invalidItems === 1 ? "y was" : "ies were"} dropped as invalid. Each range must be an object with string fields startId, endId, summary.`;
  }
  return `${base}. content must be an ARRAY of {startId, endId, summary} objects.`;
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

async function handleCompress(args: CompressArgs, runtime: AcpRuntime, ctx: ExtensionContext, toolCallId: string | undefined, tools: Tool[]): Promise<string> {
  const maybeRanges = normalizeRanges(args);
  // Argument errors throw (not return): pi-agent-core only sets isError:true
  // on THROWN tool errors, and the failure counter keys off isError. A
  // returned string would land as isError:false — neutral, so it neither
  // counts toward the cap nor lifts it.
  if (typeof maybeRanges === "string") throw new Error(maybeRanges);
  const ranges = maybeRanges;
  if (ranges.length === 0) return "No ranges provided.";
  const { state: initialState, coreMessages, entries } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Sent-view arbitration — the same scale as the context transform and
  // acp_status (see src/index.ts): never the session-tree tokenCount.
  const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const imageTokens = collectImageTokens(entries, modelSupportsImages(ctx.model));
  const sentTokens = estimateTokens(coreMessages, collectCoveredMessageIds(initialState), imageTokens) + systemPromptTokens;
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
  const beforeTokens = calibrateTokens(estimateTokens(messages, collectCoveredMessageIds(state), imageTokens), density);
  const summaryMaxChars = args.summaryMaxChars;
  const topLevelTopic = args.topic;

  // Dedicated compression model: if configured and resolvable, generate each
  // range's summary with the external model (the main model only passed a
  // placeholder). On any failure, fall back to the main model's summary for
  // that range so the session is never interrupted.
  const compressionRef = runtime.getCompressionModelRef();
  let compressionNote: string | null = null;
  let compressionWarn = false;
  if (compressionRef) {
    const sid = ctx.sessionManager.getSessionId();
    const maxTokens = Math.max(256, Math.ceil((summaryMaxChars ?? 20000) / 3));
    let used = 0;
    if (compressionRef === SESSION_MODEL_REF) {
      // "session": summarize with the session's OWN model, reusing its prompt
      // prefix (system prompt + active tools + the exact transformed messages
      // Pi just sent) so the call hits the provider's prompt cache — isolation
      // without a cheaper model. Falls back to the main model's summary per
      // range on any failure, so the session is never interrupted.
      const sessionModel = ctx.model as Model<Api> | undefined;
      if (!sessionModel) {
        compressionNote = 'compression model "session" has no active session model — using main model summaries';
        compressionWarn = true;
      } else {
        const resolved: ResolvedCompressionModel = { provider: sessionModel.provider, id: sessionModel.id, model: sessionModel };
        const prefix = runtime.getLastSentMessages(sid);
        const llmPrefix: Message[] | null = prefix ? convertToLlm(prefix) : null;
        const systemPrompt = getSystemPromptText(ctx);
        for (const r of ranges) {
          const instruction = buildRangeInstruction(r, r.topic ?? topLevelTopic);
          // With a captured prefix: reuse it (prompt-cache hit) + a short
          // instruction pointing at the range by ref. Without one (first turn /
          // no context round yet): fall back to a fresh prompt with the
          // extracted range content.
          const context: Context = llmPrefix
            ? { systemPrompt, messages: [...llmPrefix, { role: "user", content: instruction, timestamp: Date.now() }], tools }
            : { systemPrompt: buildSummarizeSystemPrompt(runtime.prompts, r.topic ?? topLevelTopic), messages: [{ role: "user", content: `${instruction}\n\n<content>\n${extractRangeContent(messages, state, r.startId, r.endId) ?? "(range could not be extracted)"}\n</content>`, timestamp: Date.now() }] };
          try {
            r.summary = await runtime.compressionModel.summarizeContext(resolved, context, maxTokens);
            used += 1;
          } catch (e) {
            logWarn("compress", { sid, event: "compression-model-failed", ref: compressionRef, error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (used > 0) {
          compressionNote = `summaries written by session model ${resolved.provider}/${resolved.id} (${used}/${ranges.length} ranges${llmPrefix ? ", shared prefix" : ", no prefix captured"})`;
        } else {
          compressionNote = 'compression model "session" produced no summaries — using main model summaries';
          compressionWarn = true;
        }
      }
    } else {
      // A models.json model: fresh single-message prompt (no prefix sharing — a
      // different model lives in a different cache namespace).
      const resolved = await runtime.compressionModel.resolveModel(compressionRef);
      if (!resolved.model) {
        compressionNote = `compression model "${compressionRef}" not resolvable in models.json — using main model summaries`;
        compressionWarn = true;
        logWarn("compress", { sid, event: "compression-model-unresolved", ref: compressionRef });
      } else {
        const systemPrompt = buildSummarizeSystemPrompt(runtime.prompts, topLevelTopic);
        for (const r of ranges) {
          const content = extractRangeContent(messages, state, r.startId, r.endId);
          if (!content) continue; // cannot extract — keep the main model's summary
          try {
            r.summary = await runtime.compressionModel.summarize(resolved.model, truncateContent(content, 120000), systemPrompt, maxTokens);
            used += 1;
          } catch (e) {
            logWarn("compress", { sid, event: "compression-model-failed", ref: compressionRef, error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (used > 0) {
          compressionNote = `summaries written by ${resolved.model.provider}/${resolved.model.id} (${used}/${ranges.length} ranges)`;
        } else {
          compressionNote = `compression model "${compressionRef}" produced no summaries — using main model summaries`;
          compressionWarn = true;
        }
      }
    }
  }

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
  const afterTokens = calibrateTokens(estimateTokens(afterTurn.messages, collectCoveredMessageIds(applied.state), imageTokens), density);
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
  if (compressionNote) lines.push((compressionWarn ? "⚠️ " : "ℹ️ ") + compressionNote);
  if (warnings.length > 0) lines.push("⚠️ " + warnings.join("; "));
  if (errors.length > 0) lines.push("Errors: " + errors.join("; "));
  return lines.join("\n");
}

function formatCoreMessage(m: CoreMessage): string {
  const text = m.text ?? "";
  if (m.contentType === "tool-call") return `[${m.role}:${m.toolName ?? "tool"} call] ${text}`;
  if (m.contentType === "tool-result") return `[${m.role}:${m.toolName ?? "tool"} result] ${text}`;
  return `[${m.role}] ${text}`;
}

/** Instruction for the dedicated compression model to summarize one range.
 *  For the "session" ref the ACP compression rules already live in the reused
 *  session system prompt, so this only points at the range (by ref) and the
 *  output contract. */
function buildRangeInstruction(r: RangeEntry, topic: string | undefined): string {
  const topicLine = topic ? ` Topic: ${topic}.` : "";
  return (
    `Write the single detailed summary that replaces the conversation range from ${r.startId} to ${r.endId} ` +
    `(the messages tagged [${r.startId}] through [${r.endId}]).${topicLine} ` +
    `Follow the compression rules in your system prompt exactly. Output ONLY the summary text (no preamble, no code fences).`
  );
}

/** Raw transcript of the messages in [startId, endId] (fed to the compression
 *  model). Returns null when the range cannot be resolved. */
function extractRangeContent(messages: CoreMessage[], state: CompressionState, startId: string, endId: string): string | null {
  try {
    const range = resolveBoundaries({ startRef: startId, endRef: endId, messages, state });
    const slice = messages.slice(range.startIndex, range.endIndex + 1);
    if (slice.length === 0) return null;
    return slice.map(formatCoreMessage).join("\n\n");
  } catch {
    return null;
  }
}
