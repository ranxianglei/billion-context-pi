import { defaultCountTokens, type CompressionCore, type CompressionState, type Config, type CoreMessage } from "acp-kernel";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { countImageBlocks } from "./messages.js";

type AgentMessage = SessionMessageEntry["message"];

export function collectCoveredMessageIds(state: { blocks: { active: boolean; effectiveMessageIds: string[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const b of state.blocks) {
    if (!b.active) continue;
    for (const id of b.effectiveMessageIds) ids.add(id);
  }
  return ids;
}

// ~Anthropic screenshot cost; real per-model cost (85..2.8K) varies — flat approximation.
export const IMAGE_TOKEN_COST = 1600;

// pi-ai silently drops image blocks for non-vision models, so they cost nothing there.
export function modelSupportsImages(model: unknown): boolean {
  const input = (model as { input?: string[] } | null | undefined)?.input;
  return Array.isArray(input) && input.includes("image");
}

// Keyed by entry id — the core id of user/toolResult messages (assistant tool-call cores split as `${id}#callId` and never carry images).
export function collectImageTokens(entries: { id: string; type?: string; message?: AgentMessage }[], visionCapable: boolean): Map<string, number> {
  const out = new Map<string, number>();
  if (!visionCapable) return out;
  for (const e of entries) {
    if (e.type !== "message") continue;
    const n = countImageBlocks((e.message as { content?: unknown } | undefined)?.content);
    if (n > 0) out.set(e.id, n * IMAGE_TOKEN_COST);
  }
  return out;
}

export function estimateTokens(messages: CoreMessage[], coveredIds?: Set<string>, imageTokensById?: Map<string, number>): number {
  let tokens = 0;
  for (const m of messages) {
    if (m.toolName === "compress") continue;
    if (coveredIds?.has(m.id)) continue;
    tokens += defaultCountTokens(m.text ?? "");
    tokens += m.thinkingTokens ?? 0;
    const img = imageTokensById?.get(m.id);
    if (img) tokens += img;
  }
  return tokens;
}

// Re-measure tokenCount on the ACTUAL sent view: run processTurn on a throwaway
// state clone (processTurn mutates state — survival counters, nudge stamps) and
// count the pruned result (covered removed + summaries injected + orphaned tool
// pairs/absorbed/filtered messages stripped). The raw-view estimate over
// coreMessages minus block coverage diverges from this sent view in long
// multi-block sessions: uncovered messages that prune strips every turn stay
// counted forever while never being sent, pinning usage in the emergency band
// and driving low/zero-yield compression loops (issue #289). Ref-tag overhead
// is included because tags ride along in the sent text.
export function sentViewTokenCount(
  core: CompressionCore,
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  prelim: number,
  imageTokensById?: Map<string, number>,
  systemPromptTokens = 0,
): { viewTokens: number; drifted: boolean } {
  // Clamp the probe below the emergency-truncate threshold: passing prelim
  // through would let emergencyTruncateNode fire inside the probe whenever
  // prelim sits in the truncate band, so viewTokens would measure the
  // post-truncation view — under-reporting exactly the pathological case this
  // recount exists for (issue #289). The real pass still truncates when its
  // own (honest) count crosses the band.
  const cap = config.modelContextLimit > 0 ? Math.max(0, Math.floor(config.truncate.threshold * config.modelContextLimit) - 1) : Number.MAX_SAFE_INTEGER;
  const probe = core.processTurn({ messages, state: structuredClone(state), config, tokenCount: Math.min(prelim, cap) });
  const viewTokens = estimateTokens(probe.messages, collectCoveredMessageIds(probe.state), imageTokensById) + systemPromptTokens;
  return { viewTokens, drifted: Math.abs(viewTokens - prelim) > Math.max(1000, 0.1 * prelim) };
}

// Guarded variant for call sites that only need the final count: divergence is
// impossible without active block coverage, so skip the probe pass entirely then.
export function adjustedTokenCount(
  core: CompressionCore,
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  prelim: number,
  imageTokensById?: Map<string, number>,
  systemPromptTokens = 0,
): number {
  if (!state.blocks.some((b) => b.active && b.effectiveMessageIds.length > 0)) return prelim;
  const view = sentViewTokenCount(core, messages, state, config, prelim, imageTokensById, systemPromptTokens);
  return view.drifted ? view.viewTokens : prelim;
}

/** Per-session record of the EXACT sent view measured off the previous real
 *  processTurn output (issue #561) — replaces re-running a probe processTurn
 *  (clone + full second pass over the whole history) on every steady-state
 *  turn. */
export interface SentViewMeterRecord {
  viewTokens: number;
  blocksLen: number;
  activeBlocks: number;
  limit: number;
  /** False when the measured view may be dishonest (post-truncation output,
   *  or the record is absent) — callers must then run the full probe. */
  usable: boolean;
}

/** Signature check for adopting the previous turn's measured view (issue #561):
 *  the meter describes LAST turn's (state, config); it is only transferable
 *  when nothing structural moved — same window, same block count, same active
 *  count. Any compress/decompress/sync between turns changes one of these and
 *  forces the full probe path for a turn. Pure function, unit-testable. */
export function sentViewMeterMatches(
  meter: SentViewMeterRecord | undefined,
  state: CompressionState,
  config: Config,
): boolean {
  if (!meter || !meter.usable) return false;
  if (meter.limit !== config.modelContextLimit) return false;
  if (meter.blocksLen !== state.blocks.length) return false;
  let active = 0;
  for (const b of state.blocks) if (b.active) active++;
  return meter.activeBlocks === active;
}


