/** Single source of truth for turn-boundary decisions (#364).
 *
 * "What counts as a new-turn start" used to be decided independently in three
 * places (per-turn token estimation, turnKey scoping, context-entry
 * projection) and disagreed on host-injected custom_message entries: they
 * enter LLM context but started no turn, so multiple real turns collapsed
 * into one turnKey — nudge ledger cells misaligned, retry-cap and throttle
 * cycle stats distorted, reasoning-drop closing against the wrong turn.
 * Every turn-boundary check in the adapter goes through isTurnBoundary.
 */

import { isCustomMessageEntry } from "./messages.js";

/** Minimal structural shape of a session-log entry for boundary checks. Pi's
 *  SessionEntry and the narrower arrays used by token accounting both satisfy
 *  it without casts. */
export interface TurnBoundaryEntry {
  type?: string;
  id?: string;
  customType?: string;
  content?: unknown;
  message?: { role?: string };
}

/** Host multi-session policy (#364). Unset/false = pi-native behavior: only
 *  genuine user-role messages start a turn. Inline multi-session hosts (Prime
 *  RLM & co.) inject agent turns as custom_message entries; set
 *  countCustomMessages to make those delimit turns too. Default-off keeps
 *  standalone pi users' nudge cadence unchanged. */
export interface TurnBoundaryPolicy {
  countCustomMessages?: boolean;
}

/** The ONE turn-boundary predicate (#364): does this entry start a new turn?
 *  Genuine user-role messages always do (pi-native); host-injected
 *  custom_message entries do only when the host opts in via policy. */
export function isTurnBoundary(entry: TurnBoundaryEntry, policy: TurnBoundaryPolicy = {}): boolean {
  if (entry.message?.role === "user") return true;
  return policy.countCustomMessages === true && isCustomMessageEntry(entry);
}

/** Id of the last turn-boundary entry — the per-turn key for nudge
 *  accounting, retry caps and outcome scoping. Defaults to pi-native
 *  boundaries (user-role only); pass a host policy to also count injected
 *  custom_message entries. Returns undefined when no boundary exists yet. */
export function lastTurnBoundaryId(entries: readonly TurnBoundaryEntry[], policy?: TurnBoundaryPolicy): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (isTurnBoundary(e, policy)) return e.id;
  }
  return undefined;
}

/** Index of the last turn-boundary entry — the start of the current turn for
 *  compress-outcome scoping. Same policy semantics as lastTurnBoundaryId;
 *  -1 when no boundary has been seen yet. */
export function lastTurnBoundaryIndex(entries: readonly TurnBoundaryEntry[], policy?: TurnBoundaryPolicy): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isTurnBoundary(entries[i]!, policy)) return i;
  }
  return -1;
}
