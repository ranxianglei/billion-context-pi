import {
  defaultCountTokens,
  type AbsorbRecord,
  type CompressionState,
  type Config,
  type CoreMessage,
  type ProcessTurnResult,
} from "acp-kernel";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { estimateTokens, collectCoveredMessageIds, calibrateTokens } from "./tokens.js";
import { formatTokens } from "./tag-tokens.js";

export interface PendingCompression {
  startRef: string;
  endRef: string;
  summary: string;
  topic?: string;
  summaryMaxChars?: number;
  callId: string;
  createdAt: number;
  estTokens: number;
}

export interface RolloverPending {
  compressions: PendingCompression[];
  absorbs: AbsorbRecord[];
}

export const DEFAULT_ROLLOVER_THRESHOLD = 0.7;

export function emptyPending(): RolloverPending {
  return { compressions: [], absorbs: [] };
}

export function pendingHasWork(p: RolloverPending | null): boolean {
  return !!p && (p.compressions.length > 0 || p.absorbs.length > 0);
}

export function shouldRollover(opts: {
  enabled: boolean;
  tokenCount: number;
  limit: number;
  threshold: number;
  hasPending: boolean;
  manual: boolean;
}): boolean {
  return opts.enabled && opts.hasPending && opts.limit > 0 && (opts.manual || opts.tokenCount >= opts.threshold * opts.limit);
}

function refNum(ref: string): number | null {
  const m = /^m(\d+)$/.exec(ref);
  return m ? Number(m[1]) : null;
}

export function pendingOverlaps(p: RolloverPending | null, startRef: string, endRef: string): boolean {
  if (!p) return false;
  const s = refNum(startRef);
  const e = refNum(endRef);
  if (s === null || e === null) return false;
  for (const c of p.compressions) {
    const ps = refNum(c.startRef);
    const pe = refNum(c.endRef);
    if (ps === null || pe === null) continue;
    if (s <= pe && e >= ps) return true;
  }
  return false;
}

export function rangeTokenEstimate(messages: CoreMessage[], state: CompressionState, startRef: string, endRef: string): number {
  const s = refNum(startRef);
  const e = refNum(endRef);
  if (s === null || e === null) return 0;
  let total = 0;
  for (const m of messages) {
    const ref = state.messageRefs.byRaw[m.id];
    if (!ref) continue;
    const n = refNum(ref);
    if (n !== null && n >= s && n <= e) total += defaultCountTokens(m.text ?? "");
  }
  return total;
}

export interface RolloverInput {
  runtime: AcpRuntime;
  ctx: ExtensionContext;
  config: Config;
  coreMessages: CoreMessage[];
  turn: ProcessTurnResult;
  modelId: string;
  imageTokens: Map<string, number>;
  systemPromptTokens: number;
}

export interface RolloverResult {
  turn: ProcessTurnResult;
  compressionsApplied: number;
  absorbsApplied: number;
  errors: string[];
  warnings: string[];
  tokensCompressed: number;
  beforeTokens: number;
  afterTokens: number;
  reclaimed: number;
}

export async function runRollover(input: RolloverInput): Promise<RolloverResult | null> {
  const { runtime, ctx, config, coreMessages, turn, modelId, imageTokens, systemPromptTokens } = input;
  const pending = runtime.getRolloverPending(ctx);
  if (!pending || !pendingHasWork(pending)) return null;
  const p = pending;

  let state = turn.state;
  const errors: string[] = [];
  const warnings: string[] = [];
  let compressionsApplied = 0;
  let tokensCompressed = 0;
  if (p.compressions.length > 0) {
    const applied = runtime.core.applyCompression({
      ranges: p.compressions.map((c) => ({
        startRef: c.startRef,
        endRef: c.endRef,
        summary: c.summary,
        topic: c.topic,
        summaryMaxChars: c.summaryMaxChars,
        compressCallId: c.callId,
      })),
      messages: turn.messages,
      state,
      config,
    });
    state = applied.state;
    compressionsApplied = applied.result.blocksCreated;
    tokensCompressed = applied.result.tokensCompressed;
    errors.push(...applied.result.errors);
    warnings.push(...applied.result.warnings);
  }
  if (p.absorbs.length > 0) {
    state = {
      ...state,
      absorbed: [...(state.absorbed ?? []), ...p.absorbs],
      stats: {
        ...state.stats,
        absorbedTokens: (state.stats.absorbedTokens ?? 0) + p.absorbs.reduce((sum, a) => sum + a.tokensReclaimed, 0),
      },
    };
  }
  runtime.setRolloverPending(ctx, null);
  await runtime.save(state, ctx);

  const probe = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount: 0 });
  const newSentTokens = estimateTokens(probe.messages, collectCoveredMessageIds(state), imageTokens) + systemPromptTokens;
  const newTokenCount = calibrateTokens(newSentTokens, runtime.density.densityFor(modelId));
  const afterTurn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount: newTokenCount });

  const density = runtime.density.densityFor(modelId);
  const beforeTokens = calibrateTokens(estimateTokens(turn.messages, collectCoveredMessageIds(turn.state), imageTokens), density);
  const afterTokens = calibrateTokens(estimateTokens(afterTurn.messages, collectCoveredMessageIds(state), imageTokens), density);

  return {
    turn: afterTurn,
    compressionsApplied,
    absorbsApplied: p.absorbs.length,
    errors,
    warnings,
    tokensCompressed,
    beforeTokens,
    afterTokens,
    reclaimed: Math.max(0, beforeTokens - afterTokens),
  };
}

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function rolloverReportText(r: RolloverResult): string {
  const applied: string[] = [];
  if (r.compressionsApplied > 0) applied.push(`${r.compressionsApplied} compression(s)`);
  if (r.absorbsApplied > 0) applied.push(`${r.absorbsApplied} absorb(s)`);
  const lines = [
    `\u25a3 ACP rollover | ${applied.join(" + ")} applied: ${formatK(r.beforeTokens)} \u2192 ${formatK(r.afterTokens)} tokens (~${formatK(r.reclaimed)} reclaimed)`,
  ];
  for (const w of r.warnings) lines.push(`Warning: ${w}`);
  for (const e of r.errors) lines.push(`Error: ${e}`);
  return lines.join("\n");
}

export function findHiddenPendingCompressCalls(input: CoreMessage[], output: CoreMessage[], pending: RolloverPending | null): Set<string> {
  const hidden = new Set<string>();
  if (!pending || pending.compressions.length === 0) return hidden;
  const outputIds = new Set(output.map((m) => m.id));
  for (const c of pending.compressions) {
    for (const m of input) {
      if (m.toolCallId !== c.callId) continue;
      if (m.contentType === "tool-call" && m.toolName !== "compress") continue;
      if (!outputIds.has(m.id)) hidden.add(m.id);
    }
  }
  return hidden;
}

function renderRestored(m: CoreMessage, state: CompressionState): CoreMessage {
  const ref = state.messageRefs.byRaw[m.id];
  if (!ref) return m;
  const body = m.text ?? "";
  const tokens = state.tokenSnapshot[ref] ?? defaultCountTokens(body);
  const type = m.contentType === "tool-call" || m.contentType === "tool-result" ? (m.toolName || "tool") : m.contentType;
  const tag = `\x3cacp tokens="${formatTokens(tokens)}" type="${type}"\x3e${ref}\x3c/acp\x3e`;
  return { ...m, text: body ? `${tag}\n${body}` : tag };
}

export function mergeRestoredMessages(coreOut: CoreMessage[], input: CoreMessage[], hiddenIds: Set<string>, state: CompressionState): CoreMessage[] {
  if (hiddenIds.size === 0) return coreOut;
  const outIds = new Set(coreOut.map((m) => m.id));
  const restored = new Map<string, CoreMessage>();
  for (const m of input) {
    if (hiddenIds.has(m.id) && !outIds.has(m.id)) restored.set(m.id, renderRestored(m, state));
  }
  if (restored.size === 0) return coreOut;
  const inputPos = new Map<string, number>();
  input.forEach((m, i) => {
    if (!inputPos.has(m.id)) inputPos.set(m.id, i);
  });
  const merged: CoreMessage[] = [];
  const emitted = new Set<string>();
  let lastPos = -1;
  for (const cm of coreOut) {
    const pos = inputPos.get(cm.id);
    const anchor = pos !== undefined ? pos : lastPos;
    if (pos !== undefined) lastPos = pos;
    for (const [rid, rm] of restored) {
      if (emitted.has(rid)) continue;
      if ((inputPos.get(rid) ?? -1) < anchor) {
        merged.push(rm);
        emitted.add(rid);
      }
    }
    merged.push(cm);
  }
  for (const [rid, rm] of restored) {
    if (!emitted.has(rid)) {
      merged.push(rm);
      emitted.add(rid);
    }
  }
  return merged;
}
