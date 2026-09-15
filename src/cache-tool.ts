import { Type } from "typebox";
import type { AgentToolResult, ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { applyToolPromptOverrides, type ToolPromptOverrides } from "./surface.js";
import { buildCacheReport, defaultCountTokens, formatCacheReport, type CacheSample, type CompressionState, type FoldEvent } from "acp-kernel";
import { logThrow } from "./log.js";
import { UNSUPPORTED_HOST_MESSAGE } from "./omp.js";

const CacheParams = Type.Object({});

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

const refNum = (ref: string): number => Number(ref.replace(/\D/g, "")) || 0;

// Provider usage footers on assistant entries → kernel-normalized samples.
// pi reports `input` EXCLUDING cache tokens; the kernel wants the billed
// prompt total (cached-inclusive) plus the cache-read part separately.
// Cache-WRITE tokens stay on the fresh side: they were billed at write price.
export function cacheSamples(entries: SessionEntry[]): CacheSample[] {
  const out: CacheSample[] = [];
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } };
    if (m?.role !== "assistant" || !m.usage) continue;
    const read = num(m.usage.cacheRead);
    const write = num(m.usage.cacheWrite);
    const fresh = num(m.usage.input);
    if (fresh + read + write <= 0) continue;
    out.push({ at: Date.parse(e.timestamp) || 0, input: fresh + read + write, cached: read, output: num(m.usage.output) });
  }
  return out;
}

// Every block ever created is a wire-mutating fold event (tier distillations
// included — they replace summaries and move the divergence point). X = the
// token prefix before the block's earliest ref (kernel contract: refs are
// chronological and never reused, so a prefix sum over ref order is exact on
// our own estimation scale).
function foldEvents(state: CompressionState): FoldEvent[] {
  const byRef = state.messageRefs?.byRef ?? {};
  const snap = state.tokenSnapshot ?? {};
  const prefixBefore = (ref?: string): number | undefined => {
    if (!ref || refNum(ref) === 0) return undefined;
    let n = 0;
    for (const key of Object.keys(byRef)) {
      if (refNum(key) < refNum(ref)) n += snap[key] ?? 0;
    }
    return n;
  };
  return [...state.blocks].sort((a, b) => a.createdAt - b.createdAt).map((b) => ({
    at: b.createdAt,
    tokensCompressed: b.compressedTokens,
    summaryTokens: defaultCountTokens(b.summary || ""),
    firstFoldStartTokens: prefixBefore(b.startRef),
  }));
}

export async function cacheReportText(runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const { state, entries } = await runtime.stateFor(ctx);
  const report = buildCacheReport(cacheSamples(entries), foldEvents(state));
  return formatCacheReport(report, ctx.sessionManager.getSessionId());
}

export function makeCacheTool(runtime: AcpRuntime, overrides?: ToolPromptOverrides): ToolDefinition<typeof CacheParams> {
  return applyToolPromptOverrides({
    name: "acp_cache",
    label: "ACP Cache Report",
    description:
      "Prompt-cache reconciliation: grand ledger (total input/cached/output, session hit rate) with every request's miss split into new content / compression re-pay / TTL expiry, plus per-fold economics (one-time cost, breakeven turns vs measured cadence). Read-only.",
    promptSnippet: "acp_cache({})",
    promptGuidelines: [
      "Call when asked about cache hits, cache invalidation, or what compression costs.",
      "Read-only: reports numbers, never mutates context.",
    ],
    parameters: CacheParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (runtime.refused) return { details: undefined, content: [{ type: "text", text: runtime.refusalMessage ?? UNSUPPORTED_HOST_MESSAGE }] };
      try {
        const text = await cacheReportText(runtime, ctx);
        return { details: undefined, content: [{ type: "text", text }] };
      } catch (e) {
        logThrow("cache", e, { sid: ctx.sessionManager.getSessionId() });
        throw e;
      }
    },
  }, overrides);
}
