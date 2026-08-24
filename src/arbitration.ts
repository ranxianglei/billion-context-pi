/**
 * Provider-anchored context arbitration.
 *
 * chars/4×density estimates of the sent view can run far below the provider's
 * real token count (CJK + minified code under-report by 4×+; incident session
 * 01a02d90: estimated 57K = 51.8% while the provider was already rejecting a
 * 134.5K prompt). pi's `getContextUsage().tokens` anchors on the provider-
 * reported usage of the last assistant message (plus an estimated trailing
 * tail), so when that anchor is trustworthy it beats the local estimate
 * outright for nudge/emergency arbitration.
 *
 * The anchor is NOT trustworthy in two regimes, both observed in the wild:
 *
 * 1. Transient post-compression turn: the anchor assistant predates the
 *    compress, so its usage still reflects the pre-compression (much larger)
 *    sent view. Consuming it would fire false EMERGENCY nudges right after a
 *    successful compress (omp issue #18 family). Density's postCompression
 *    skip (density.ts) uses the same guard.
 *
 * 2. Provider-never-reports-usage regime: when no assistant message ever
 *    carried usage, pi falls back to summing the whole session tree
 *    (originals included, never shrinks) — after compression that number can
 *    exceed the window many times over while the real sent view is a few
 *    percent, producing permanent false EMERGENCY nudges (omp issue #18).
 *    Detect it the same way pi's compaction does (compaction.ts
 *    getAssistantUsage): an assistant entry only counts as provider-backed
 *    when it carries a non-zero usage record.
 */

export interface UsageLike {
  tokens: number | null;
}

export interface EntryLike {
  type?: string;
  message?: {
    role?: string;
    usage?: {
      input?: number;
      totalTokens?: number;
    };
  };
}

/**
 * Resolve the provider-anchored token count for arbitration, or null when the
 * anchor must not be consumed this turn.
 *
 * Returns `realUsage.tokens` when ALL hold:
 *  a) it is a positive finite number (pi yields null when it cannot anchor,
 *     e.g. right after a pi-side compaction with no post-compaction usage);
 *  b) this is not a post-compression transient turn (guard 1 above);
 *  c) at least one assistant entry in the merged session view carries a
 *     non-zero provider usage record (guard 2 above) — mirroring how pi
 *     decides between usage-anchoring and tree-summing.
 */
export function providerAnchoredTokens(
  realUsage: UsageLike | undefined,
  entries: readonly EntryLike[],
  postCompression: boolean,
): number | null {
  const tokens = realUsage?.tokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (postCompression) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.message;
    if (message?.role !== "assistant") continue;
    const usage = message.usage;
    if ((usage?.totalTokens ?? 0) > 0 || (usage?.input ?? 0) > 0) return tokens;
  }
  return null;
}
