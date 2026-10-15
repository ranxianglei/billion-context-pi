// Block-loss sentinel (#635 D2): diagnostic instrumentation for hosts that
// rewrite their in-flight view between turns. The kernel's sync-blocks node
// silently deactivates any block whose covered message ids vanish from the
// presented view, and it discards the deactivation list — so "compressed
// blocks disappeared after several turns" was invisible from the adapter.
// This module compares consecutive INPUT views (base ids + text fingerprints)
// and active-block sets across turns. When blocks are lost it emits ONE
// structured warn event whose fields let support attribute the mechanism:
//   - id-churn-suspected: the host re-mints message ids each turn while the
//     content survives under new ids (high id churn, low text loss) — fixable
//     adapter-side by content-addressing the whole branch on fork hosts.
//   - content-loss-suspected: the host folds/rewrites stored history itself
//     (high text loss) — no plugin-side anchoring can preserve semantics.
//   - state-reset-suspected: the session's persisted state came back empty
//     although the previous turn held active blocks (sidecar load miss /
//     unstable session identity).
// Log-only: it never mutates state, the wire, or tool behavior.

import { createHash } from "node:crypto";
import { baseIdOf, type CoreMessage } from "acp-kernel";

export interface ViewChurn {
  /** Message count of the previous turn's input view. */
  prevSize: number;
  /** Message count of this turn's input view. */
  nowSize: number;
  /** Previous base ids absent from this turn's view. */
  missingIds: number;
  /** Base ids present now but not before (append-only growth ⇒ all additions). */
  addedIds: number;
  /** missingIds / prevSize, rounded to 2 decimals; 0 when prevSize is 0. */
  idChurnPct: number;
  /** Non-empty text payloads (count-weighted) in the previous view. */
  prevTexts: number;
  /** Previous text payloads absent from this view (count-weighted deficit). */
  missingTexts: number;
  /** missingTexts / prevTexts, rounded to 2 decimals; 0 when prevTexts is 0. */
  textLossPct: number;
}

export type LossHint =
  | "id-churn-suspected"
  | "content-loss-suspected"
  | "unclassified"
  | "no-prev-view";

const ID_CHURN_THRESHOLD = 0.2;
const TEXT_LOSS_THRESHOLD = 0.2;
// Text loss tolerated below id churn before the churn verdict flips to loss.
const CHURN_DOMINANCE_RATIO = 0.5;
/** Bounded in-memory footprint: sessions tracked concurrently. */
const MAX_SESSIONS = 32;

interface Signature {
  ids: Set<string>;
  /** sha256-prefix of trimmed message text → occurrence count. */
  texts: Map<string, number>;
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function signatureOf(messages: CoreMessage[]): Signature {
  const ids = new Set<string>();
  const texts = new Map<string, number>();
  for (const m of messages) {
    ids.add(baseIdOf(m.id));
    const t = m.text?.trim();
    if (!t) continue;
    const fp = fingerprint(t);
    texts.set(fp, (texts.get(fp) ?? 0) + 1);
  }
  return { ids, texts };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function classifyLoss(churn: ViewChurn | null): LossHint {
  if (!churn) return "no-prev-view";
  if (churn.idChurnPct >= ID_CHURN_THRESHOLD && churn.textLossPct <= churn.idChurnPct * CHURN_DOMINANCE_RATIO) {
    return "id-churn-suspected";
  }
  if (churn.textLossPct >= TEXT_LOSS_THRESHOLD) return "content-loss-suspected";
  return "unclassified";
}

export interface TurnReport {
  churn: ViewChurn | null;
  /** True when the loaded state holds no active blocks although the previous
   *  turn for this session did (#635 H3: sidecar load miss / identity drift). */
  resetSuspected: boolean;
  /** Active block count of the PREVIOUS turn (0 on first sight); context for resetSuspected. */
  prevActive: number;
}

export class BlockLossSentinel {
  private lastView = new Map<string, Signature>();
  private lastActive = new Map<string, Set<string>>();

  /**
   * Call once per turn with the INPUT view (the exact messages about to be
   * sent) and the active block ids loaded for the turn, BEFORE running
   * processTurn. Returns the churn report vs the previous turn (null on first
   * sight) and flags a suspected state reset; settle() completes the turn.
   */
  beginTurn(sessionId: string, messages: CoreMessage[], activeBlockIds: Iterable<string>): TurnReport {
    const sig = signatureOf(messages);
    const prevSig = this.lastView.get(sessionId);
    const prevActive = this.lastActive.get(sessionId);
    const churn = this.churnOf(prevSig, sig);
    const activeNow = new Set(activeBlockIds);
    const resetSuspected = activeNow.size === 0 && (prevActive?.size ?? 0) > 0;
    this.remember(sessionId, sig, activeNow);
    return { churn, resetSuspected, prevActive: prevActive?.size ?? 0 };
  }

  /**
   * Call once per turn after processTurn with the post-turn active block ids.
   * Emits nothing here — the caller logs; this returns the newly deactivated
   * block ids so the caller can attach whatever context it wants to the event.
   */
  settledLosses(sessionId: string, activeAfter: Iterable<string>): string[] {
    const before = this.lastActive.get(sessionId) ?? new Set<string>();
    const after = new Set(activeAfter);
    this.remember(sessionId, this.lastView.get(sessionId), after);
    return [...before].filter((id) => !after.has(id));
  }

  private remember(sessionId: string, sig: Signature | undefined, active: Set<string>): void {
    if (sig !== undefined) {
      this.lastView.delete(sessionId);
      this.lastView.set(sessionId, sig);
    }
    this.lastActive.delete(sessionId);
    this.lastActive.set(sessionId, active);
    if (this.lastView.size > MAX_SESSIONS) {
      const oldest = this.lastView.keys().next().value;
      if (oldest !== undefined) {
        this.lastView.delete(oldest);
        this.lastActive.delete(oldest);
      }
    }
  }

  private churnOf(prev: Signature | undefined, now: Signature): ViewChurn | null {
    if (!prev) return null;
    let missingIds = 0;
    for (const id of prev.ids) if (!now.ids.has(id)) missingIds++;
    let addedIds = 0;
    for (const id of now.ids) if (!prev.ids.has(id)) addedIds++;
    let prevTexts = 0;
    let missingTexts = 0;
    for (const [fp, count] of prev.texts) {
      prevTexts += count;
      const kept = Math.min(count, now.texts.get(fp) ?? 0);
      missingTexts += count - kept;
    }
    return {
      prevSize: prev.ids.size,
      nowSize: now.ids.size,
      missingIds,
      addedIds,
      idChurnPct: round2(prev.ids.size > 0 ? missingIds / prev.ids.size : 0),
      prevTexts,
      missingTexts,
      textLossPct: round2(prevTexts > 0 ? missingTexts / prevTexts : 0),
    };
  }
}
