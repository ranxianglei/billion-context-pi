import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { MAX_COMPRESS_ATTEMPTS } from "./runtime.js";
import { debug, logError, logInfo, logThrow, logWarn } from "./log.js";
import { estimateTokens, collectCoveredMessageIds, collectImageTokens, modelSupportsImages, lastUserMessageId } from "./tokens.js";
import { defaultCountTokens, parseCompressArgs, viableRanges, formatRanges, type CompressionBlock, type CompressionState, type CompressParseDiagnostics, type NudgeDecision } from "acp-kernel";
import { countUnicodeEscapes, findUnverifiableUserQuote, sanitizeSummary } from "./summary-sanitize.js";
import { getSystemPromptText } from "./compat.js";
import { OMP_UNSUPPORTED_MESSAGE } from "./omp.js";

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
      if (runtime.refused) return { details: undefined, content: [{ type: "text", text: OMP_UNSUPPORTED_MESSAGE }] };
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

// Normalize the compress args via the kernel's lenient parser (fenced /
// trailing-comma / raw-newline / double-stringified / truncated-salvage).
// Returns an error string on bad input — handleCompress THROWS it so pi marks
// the toolResult isError:true, which is what makes the outcome count toward
// the failure cap (a returned string would land as isError:false and count
// as neutral). An empty array passes through (the call site returns "No
// ranges provided.").
export function normalizeRanges(args: CompressArgs): RangeEntry[] | string {
  const effective = repairContentTail(args);
  const { ranges, diagnostics } = parseCompressArgs(effective);
  if (ranges.length === 0) {
    if (Array.isArray(effective.content) && effective.content.length === 0) return [];
    return describeDiagnostics(diagnostics, effective.content);
  }
  return ranges.map((r) => ({ startId: r.startRef, endId: r.endRef, summary: r.summary, topic: r.topic }));
}

// Qwen-family models in non-strict tool-call mode sometimes emit the `content`
// array as a JSON-encoded string whose LAST entry object is missing its closing
// `}` (tail `"]` instead of `"}]`). The kernel's lenient parser then drops that
// last range — or every range, when it is the only one — and reports a
// misleading "truncated"/"no-valid-ranges" diagnostic. Repair the brace before
// delegating so the whole array parses. Args are returned unchanged when the
// repair does not apply.
function repairContentTail(args: CompressArgs): CompressArgs {
  if (typeof args.content !== "string") return args;
  const repaired = tailRepair(args.content);
  return repaired === undefined ? args : { ...args, content: repaired };
}

// Deterministic tail-repair: if the trimmed string ends with `"]` and the char
// before it is a closing `"`, retry the parse with `"}]` appended. A valid JSON
// array never still parses after appending `}`, so this has no false positives.
export function tailRepair(s: string): string | undefined {
  const t = s.trimEnd();
  if (!t.endsWith("]")) return undefined;
  const body = t.slice(0, -1).trimEnd();
  if (!body.endsWith('"')) return undefined;
  const candidate = body + "}]";
  try {
    if (Array.isArray(JSON.parse(candidate))) return candidate;
  } catch {
    // not the missing-brace case
  }
  return undefined;
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
  const parseErr = jsonParseError(content);
  if (parseErr !== undefined) {
    return `${base}; the JSON failed to parse: ${parseErr}. Fix the malformed JSON (e.g. a missing closing brace or quote) and retry.`;
  }
  return `${base}. content must be an ARRAY of {startId, endId, summary} objects.`;
}

// Short diagnostic for why a JSON-shaped string fails to parse, or undefined
// when it parses fine or is not JSON-shaped. Gives the model a retryable signal
// (the parser's own position) instead of the misleading "must be an ARRAY".
function jsonParseError(content: CompressArgs["content"]): string | undefined {
  if (typeof content !== "string") return undefined;
  const t = content.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    JSON.parse(t);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
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

// Issue #250 loop breaker: small models repeat an identical compress call with
// refs that can NEVER resolve (stale/consumed/unknown) — the kernel rejects
// every time and the model just retries the same dead refs for minutes. A
// range is "dead" when the kernel's boundary resolver will reject it no matter
// what summary is written, so repeating the same dead range set is guaranteed
// to fail. After DEAD_REPEAT_REJECT identical failures we stop running the
// kernel and return a hard rejection that lists the LIVE compressible ranges
// (from the nudge decision already computed in this call), so the model gets
// usable refs without having to call acp_status.
const DEAD_REPEAT_REJECT = 2;

function paddedRef(n: number): string {
  return `m${String(n).padStart(5, "0")}`;
}

function blockHasVisibleAnchor(block: CompressionBlock, visibleIds: Set<string>): boolean {
  if (visibleIds.has(`acp_summary_${block.blockId}`)) return true;
  return block.effectiveMessageIds.some((id) => visibleIds.has(id));
}

function hasActiveOwner(state: CompressionState, ownedIds: string[], visibleIds: Set<string>): boolean {
  const owned = new Set(ownedIds);
  for (const block of state.blocks) {
    if (!block.active) continue;
    const inheritsOwned = block.directBlockIds.some((childId) => {
      const child = state.blocks.find((c) => c.blockId === childId);
      return child !== undefined && child.effectiveMessageIds.some((id) => owned.has(id));
    });
    if (inheritsOwned && blockHasVisibleAnchor(block, visibleIds)) return true;
  }
  return false;
}

function refIsDead(ref: string, state: CompressionState, visibleIds: Set<string>): boolean {
  const trimmed = ref.trim();
  if (/^b\d+$/i.test(trimmed)) {
    const block = state.blocks.find((b) => b.blockId.toLowerCase() === trimmed.toLowerCase());
    if (!block) return true;
    if (block.active && blockHasVisibleAnchor(block, visibleIds)) return false;
    return !hasActiveOwner(state, block.effectiveMessageIds, visibleIds);
  }
  const m = trimmed.match(/^m(\d+)$/i);
  if (!m) return true;
  const rawId = state.messageRefs.byRef[trimmed] ?? state.messageRefs.byRef[paddedRef(Number(m[1]))];
  if (!rawId) return true;
  if (visibleIds.has(rawId)) return false;
  return !hasActiveOwner(state, [rawId], visibleIds);
}

function compressibleSnapshotText(nudge: NudgeDecision | undefined): string {
  const ranges = viableRanges(nudge?.compressibleRanges ?? []);
  if (ranges.length === 0) {
    return "No compressible ranges remain — the context is already at its minimum; continue the task without compressing.";
  }
  return formatRanges(ranges, []);
}

function deadRepeatRejectionText(spans: string[], count: number, snapshot: string): string {
  return [
    "▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)",
    `[ACP] REJECTED — this exact compress call has now failed ${count}× (ranges ${spans.join(", ")}). Those refs are stale: they point at content already compressed into an active block, or at refs that no longer exist. Repeating this call cannot succeed — do not retry it.`,
    "",
    "Current compressible ranges (use these refs exactly as listed):",
    snapshot,
    "",
    "If none of these fit, call acp_status for the full picture — or continue the task without compressing.",
  ].join("\n");
}

function cappedRejectionText(snapshot: string): string {
  return [
    "▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)",
    `[ACP] PAUSED — ${MAX_COMPRESS_ATTEMPTS} compress attempts already failed this turn; further compress calls are rejected until the next user message.`,
    "",
    "Current compressible ranges (use these refs exactly as listed):",
    snapshot,
    "",
    "Continue the task; compress becomes available again on the next user message.",
  ].join("\n");
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
    tokenCount: sentTokens,
  });
  const state = turn.state;
  const messages = turn.messages;
  const sid = ctx.sessionManager.getSessionId();
  // Issue #309: normalize at ingest — the kernel stores/renders summaries
  // verbatim, so double-escaped \uXXXX runs would persist into every future
  // prompt. Unverifiable user-quote claims are logged as evidence only.
  const sanitizedRanges = ranges.map((r) => {
    const span = `${r.startId}..${r.endId}`;
    const s = sanitizeSummary(r.summary);
    if (s.unescaped) {
      debug.event("compress", { sid, event: "summary-unescaped", span, escapes: countUnicodeEscapes(r.summary), beforeLen: r.summary.length, afterLen: s.text.length });
    }
    const unverifiedQuote = findUnverifiableUserQuote(s.text);
    if (unverifiedQuote !== null) {
      logWarn("compress", { sid, event: "summary-unverifiable-quote", span, claim: unverifiedQuote });
    }
    return s.text === r.summary ? r : { ...r, summary: s.text };
  });
  const turnKey = lastUserMessageId(entries) ?? sid;
  const snapshot = compressibleSnapshotText(turn.nudge);
  if (runtime.compressRetryCappedFor(turnKey)) {
    logWarn("compress", { sid, event: "capped-reject", turnKey });
    return cappedRejectionText(snapshot);
  }
  const visibleIds = new Set(messages.map((m) => m.id));
  const deadSpans = ranges
    .filter((r) => refIsDead(r.startId, state, visibleIds) || refIsDead(r.endId, state, visibleIds))
    .map((r) => `${r.startId}..${r.endId}`);
  const allDead = deadSpans.length === ranges.length;
  // beforeTokens on the same CJK-aware scale as the kernel's countTokens, so
  // "X → Y (~Z reclaimed)" compares like-for-like.
  const beforeTokens = estimateTokens(messages, collectCoveredMessageIds(state), imageTokens);
  const summaryMaxChars = args.summaryMaxChars;
  const topLevelTopic = args.topic;

  debug.event("compress-in", {
    sid: ctx.sessionManager.getSessionId(),
    modelId,
    ranges: ranges.length,
    spans: ranges.map((r) => ({ span: `${r.startId}..${r.endId}`, summaryLen: r.summary.length, summary: r.summary, topic: r.topic ?? topLevelTopic ?? null })),
    blocksBefore: state.blocks.length,
    activeBefore: state.blocks.filter((b) => b.active).length,
    beforeMsgCount: messages.length,
    beforeTokens,
  });
  const applied = runtime.core.applyCompression({
    ranges: sanitizedRanges.map((r) => ({ startRef: r.startId, endRef: r.endId, summary: r.summary, topic: r.topic ?? topLevelTopic, summaryMaxChars, compressCallId: toolCallId })),
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
  if (blocksCreated > 0) {
    runtime.clearDeadCompress(sid);
  } else if (allDead) {
    const count = runtime.noteDeadCompress(sid, ranges.map((r) => `${r.startId}..${r.endId}`).join("|"));
    if (count >= DEAD_REPEAT_REJECT) {
      logWarn("compress", { sid, event: "dead-range-reject", count, spans: deadSpans });
      return deadRepeatRejectionText(deadSpans, count, snapshot);
    }
  }

  // Re-measure the post-compression sent view on the SAME scale as beforeTokens
  // (post-processTurn view: visible text + every active block's summary anchor
  // + ref-tag overhead), so "X → Y (~Z reclaimed)" compares like-for-like —
  // including the new block's own summary, which the model will pay for next.
  const afterTurn = runtime.core.processTurn({
    messages: coreMessages,
    state: applied.state,
    config,
    tokenCount: sentTokens,
  });
  const afterTokens = estimateTokens(afterTurn.messages, collectCoveredMessageIds(applied.state), imageTokens);
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
