// pi's getContextUsage() anchors on the last assistant message with valid
// provider usage; a successful compress after that anchor leaves it reflecting
// the pre-compression request until the next turn reports fresh usage.
import type { CompressionBlock } from "acp-kernel";
import { isCompressSuccessText } from "./compress-tool.js";
import { extractText } from "./messages.js";

type UsageLike = {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null | undefined;

type AnchorEntry = {
  type: string;
  message?: {
    role?: string;
    stopReason?: string;
    usage?: UsageLike;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    content?: unknown;
  };
};

function validAnchorUsage(u: UsageLike): boolean {
  if (!u) return false;
  const total = (u.totalTokens ?? 0) || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return total > 0;
}

interface AnchorScan {
  lastUsageIdx: number;
  lastCompressIdx: number;
  compressIdxByCallId: Map<string, number>;
}

function scanEntries(entries: AnchorEntry[]): AnchorScan {
  let lastUsageIdx = -1;
  let lastCompressIdx = -1;
  const compressIdxByCallId = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const m = entries[i]!.message;
    if (!m) continue;
    if (m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error" && validAnchorUsage(m.usage)) {
      lastUsageIdx = i;
    } else if (
      m.role === "toolResult" &&
      m.toolName === "compress" &&
      m.toolCallId !== undefined &&
      m.isError !== true &&
      isCompressSuccessText(extractText(m.content))
    ) {
      lastCompressIdx = i;
      compressIdxByCallId.set(m.toolCallId, i);
    }
  }
  return { lastUsageIdx, lastCompressIdx, compressIdxByCallId };
}

/** True when the last valid assistant usage anchor comes strictly BEFORE the
 *  last successful compress toolResult — the host's provider-usage number
 *  still reflects the pre-compression request. Failed/no-op compresses don't
 *  count (nothing was reclaimed). */
export function usageAnchorPredatesCompression(entries: AnchorEntry[]): boolean {
  const scan = scanEntries(entries);
  return scan.lastCompressIdx > scan.lastUsageIdx;
}

export interface AnchorStaleness {
  // anchor still reflects the pre-compression request
  predates: boolean;
  // Σ max(0, compressedTokens − summary) over active blocks whose compress
  // landed after the anchor; unattributable/pre-anchor blocks are excluded
  netReclaimed: number;
}

// issue #325: flooring at a stale anchor's raw value re-fires a false EMERGENCY,
// while skipping it under-counts by the fixed overhead the host already counts.
// Return how much was reclaimed since the anchor so callers floor at
// `anchor − netReclaimed` instead of either extreme.
export function compressionAnchorStaleness(
  entries: AnchorEntry[],
  blocks: readonly CompressionBlock[],
  countTokens: (text: string) => number,
): AnchorStaleness {
  const scan = scanEntries(entries);
  let netReclaimed = 0;
  for (const block of blocks) {
    if (!block.active || block.compressCallId == null) continue;
    const idx = scan.compressIdxByCallId.get(block.compressCallId);
    if (idx == null || idx <= scan.lastUsageIdx) continue;
    const saved = (block.compressedTokens ?? 0) - countTokens(block.summary ?? "");
    netReclaimed += saved > 0 ? saved : 0;
  }
  return { predates: scan.lastCompressIdx > scan.lastUsageIdx, netReclaimed };
}
