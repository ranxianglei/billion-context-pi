import type { CompressionState } from "acp-kernel";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { logInfo } from "./log.js";

// issue #603: a session forked before some of the parent's compressions ran
// inherits the parent's CURRENT blocks through the parentSession header chain —
// including blocks for compressions this branch never executed. The kernel
// prunes raw messages covered by those inherited blocks, while Pi carries
// summaries only through compress toolResults inside the branch's own log, so
// the request silently loses both the raw text and the summary.
//
// A block is valid on this branch only if its creating compress call actually
// happened here: its toolCallId must have a non-error compress toolResult in
// this branch's entry view. A call with a missing or failed result cannot
// authorize pruning. Unevidenced blocks are REMOVED (not merely deactivated):
// kernel syncBlocks recomputes consumption from the remaining directBlockIds
// references, so an earlier block they folded away is resurrected again once
// its raw messages are still present in the branch view. Blocks predating the
// compressCallId field carry no id and keep their legacy behavior (fail open).

function entryToolResult(entry: SessionEntry): { role?: string; toolName?: string; toolCallId?: string; isError?: boolean } | undefined {
  if (entry.type !== "message") return undefined;
  return (entry as { message?: { role?: string; toolName?: string; toolCallId?: string; isError?: boolean } }).message;
}

/** toolCallIds of successful compress calls present in this branch's log. */
export function compressEvidenceIds(entries: SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const m = entryToolResult(entry);
    if (!m || m.role !== "toolResult" || m.toolName !== "compress" || !m.toolCallId) continue;
    if (m.isError !== true) ids.add(m.toolCallId);
  }
  return ids;
}

export interface ReconcileReport {
  state: CompressionState;
  removed: number;
}

/** Drop blocks whose creating compress call has no evidence in `entries`.
 *  Returns the input state unchanged (same object) when nothing is removed,
 *  so healthy sessions see zero state churn. */
export function reconcileBlocksAgainstBranch(
  state: CompressionState,
  entries: SessionEntry[],
  sessionId: string,
): ReconcileReport {
  if (state.blocks.length === 0) return { state, removed: 0 };
  const evidence = compressEvidenceIds(entries);
  const kept = state.blocks.filter((block) => block.compressCallId == null || evidence.has(block.compressCallId));
  const removed = state.blocks.length - kept.length;
  if (removed === 0) return { state, removed: 0 };
  logInfo("state", { sid: sessionId, event: "branch-state-reconciled", kept: kept.length, removed });
  return { state: { ...state, blocks: kept }, removed };
}
