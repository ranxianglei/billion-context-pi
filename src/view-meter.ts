import type { CompressionState, Config, CoreMessage } from "acp-kernel";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { entriesToCoreMessages } from "./messages.js";
import { estimateTokens } from "./tokens.js";

// Issue #561: the exact sent-view recount (sentViewTokenCount) is a second full
// processTurn on a cloned state — O(total messages) and the dominant per-turn
// cost in long sessions. This meter replaces it in steady state: keep one
// exact sent-view reading as the base and extrapolate over appended entries.
// The caller falls back to the exact probe when resyncReason() reports a
// trigger — structure change, non-append-only tail, emergency-truncate band,
// or the drift bound.

/** Fires after which extrapolation is no longer trusted and an exact resync is
 *  forced. The base is refreshed from the actual pass every non-truncated
 *  turn, so this only bounds the pathological case where no refresh runs. */
export const VIEW_METER_RESYNC_EVERY = 16;

/** Prelim values at or above this floor take the exact probe: near the kernel
 *  truncate band (truncateCap), estimation error flips truncation/pressure
 *  decisions and the honest untruncated reading matters most there. */
export function exactBandFloor(config: Pick<Config, "modelContextLimit" | "truncate">): number {
  const cap = config.modelContextLimit > 0
    ? Math.max(0, Math.floor(config.truncate.threshold * config.modelContextLimit) - 1)
    : Number.MAX_SAFE_INTEGER;
  if (cap === Number.MAX_SAFE_INTEGER) return cap;
  const margin = Math.max(2000, Math.round((config.modelContextLimit ?? 0) * 0.02));
  return Math.max(0, cap - margin);
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fold(hash: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash;
}

/** Structural fingerprint of everything that can change the SENT view without
 *  appending new entries: active block set + coverage + block summaries +
 *  absorb records + system prompt size. Deliberately EXCLUDES messageRefs and
 *  tokenSnapshot: assignRefs grows both every turn (refs are never re-issued),
 *  and pure growth alters no existing view — counting them would invalidate
 *  the base every single turn. */
export function viewMeterFingerprint(state: CompressionState, systemPromptTokens: number): string {
  let coveredCount = 0;
  let activeBlocks = 0;
  let hash = FNV_OFFSET;
  for (const b of state.blocks) {
    if (!b.active) continue;
    activeBlocks++;
    hash = fold(hash ^ 0x41, `${b.blockId}:${b.tier}`);
    for (const id of b.effectiveMessageIds) {
      coveredCount++;
      hash = fold(hash ^ 0x2f, id);
    }
    if (b.summary) hash = fold(hash ^ 0x53, b.summary);
  }
  const absorbedLen = state.absorbed?.length ?? 0;
  const rulesLen = state.rules?.length ?? 0;
  return `${state.blocks.length}|${activeBlocks}|${coveredCount}|${hash >>> 0}|${absorbedLen}|${rulesLen}|${systemPromptTokens}`;
}

export interface ViewMeterBase {
  viewTokens: number;
  entryCount: number;
  lastEntryId: string;
  fingerprint: string;
}

export class SentViewMeter {
  private base: ViewMeterBase | null = null;
  private firesSinceExact = 0;

  get hasBase(): boolean {
    return this.base !== null;
  }

  /** Reason to run the exact probe instead of extrapolating, or null when the
   *  cached base can be safely extended. Reasons are log-worthy diagnostics. */
  resyncReason(input: {
    entries: readonly { id: string }[];
    fingerprint: string;
    prelim: number;
    config: Pick<Config, "modelContextLimit" | "truncate">;
  }): string | null {
    const base = this.base;
    if (!base) return "no-base";
    if (this.firesSinceExact >= VIEW_METER_RESYNC_EVERY) return "drift-bound";
    if (input.entries.length < base.entryCount) return "shrink";
    if (input.entries[base.entryCount - 1]?.id !== base.lastEntryId) return "tail-mismatch";
    if (input.fingerprint !== base.fingerprint) return "structure-change";
    if (input.prelim >= exactBandFloor(input.config)) return "truncate-band";
    return null;
  }

  /** Base + projected cost of entries appended since the base was recorded.
   *  Only call when resyncReason() returned null. */
  extrapolate(entries: SessionEntry[], imageTokensById?: Map<string, number>): number {
    const base = this.base!;
    const tail = entriesToCoreMessages(entries.slice(base.entryCount));
    const delta = estimateTokens(tail, undefined, imageTokensById);
    this.firesSinceExact += 1;
    return base.viewTokens + delta;
  }

  /** Record an exact measurement (probe result, or a recount of the real pass
   *  output) as the new base. Resets the drift counter. */
  resync(viewTokens: number, entries: readonly { id: string }[], fingerprint: string): void {
    this.base = {
      viewTokens,
      entryCount: entries.length,
      lastEntryId: entries[entries.length - 1]?.id ?? "",
      fingerprint,
    };
    this.firesSinceExact = 0;
  }
}
