// #617 / #1640: opt-in one-shot thinking/effort clamp on the FIRST turn of a
// compression-nudge episode. When enabled, the single request that carries a
// freshly-injected nudge gets its ALREADY-PRESENT effort field lowered toward
// the wire floor, and the next request restores normal effort. Clamp-only: it
// never injects an effort field the client did not send, never raises a value,
// and touches only request parameters that sit outside the message prefix — so
// it cannot bust the prompt cache. Byte-for-byte unchanged when disabled or when
// there is nothing above floor to lower. Mirrors billion-context PR#1780.
//
// Self-contained by design: no acp-kernel dependency, no cross-repo coupling.
// The wire-dialect mapping (pi-ai Api id -> dialect) lives in strip-images.ts
// and is passed in by the caller.

/** Wire dialects the clamp understands. `google` is supported for completeness
 *  even though the current Api-id mapping does not emit it. */
type NudgeWire = "anthropic" | "openai" | "responses" | "google";

const ANTHROPIC_BUDGET_FLOOR = 1024;
const GEMINI_BUDGET_FLOOR = 128;
const EFFORT_FLOOR = "low";
// Ascending effort ranks for OpenAI/Responses-style `reasoning_effort` /
// `reasoning.effort` strings. The clamp floor is "low"; only values strictly
// ABOVE the floor are lowered, always to "low". "none" (no reasoning) and any
// unrecognized string are left untouched so the clamp never raises effort or
// mangles a value it cannot order.
const EFFORT_RANK: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/** One-shot decision: clamp only on the FIRST request of a fresh nudge episode.
 *  A deferred nudge re-sent on consecutive turns does not re-clamp (prev=true);
 *  a later new episode (injected flips back to true) clamps again. `prev` is
 *  this session's previous-request injected flag. */
export function nudgeLowEffortDecision(
  injected: boolean,
  prev: boolean,
  enabled: boolean,
): { clamp: boolean; nextPrev: boolean } {
  return { clamp: enabled && injected && !prev, nextPrev: injected };
}

export interface NudgeEffortOutcome {
  /** Replacement body to send, or undefined when the payload is unchanged. */
  body?: unknown;
  changed: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Lower an effort string to the floor, or undefined when it is at/below floor
 *  or unrecognized (never raise, never mangle). */
function lowerEffortString(value: string): string | undefined {
  const rank = EFFORT_RANK[value];
  const floorRank = EFFORT_RANK[EFFORT_FLOOR];
  if (rank === undefined || floorRank === undefined) return undefined;
  return rank > floorRank ? EFFORT_FLOOR : undefined;
}

/** Lower the present thinking/effort field toward its wire floor in place.
 *  Returns true iff anything was changed. */
function lowerEffort(obj: Record<string, unknown>, protocol: NudgeWire): boolean {
  switch (protocol) {
    case "anthropic": {
      const t = obj.thinking;
      if (isRecord(t) && typeof t.budget_tokens === "number" && t.budget_tokens > ANTHROPIC_BUDGET_FLOOR) {
        t.budget_tokens = ANTHROPIC_BUDGET_FLOOR;
        return true;
      }
      return false;
    }
    case "google": {
      const gc = obj.generationConfig;
      const tc = isRecord(gc) ? gc.thinkingConfig : undefined;
      if (isRecord(tc) && typeof tc.thinkingBudget === "number" && tc.thinkingBudget !== -1 && tc.thinkingBudget > GEMINI_BUDGET_FLOOR) {
        tc.thinkingBudget = GEMINI_BUDGET_FLOOR;
        return true;
      }
      return false;
    }
    case "openai": {
      if (typeof obj.reasoning_effort === "string") {
        const lowered = lowerEffortString(obj.reasoning_effort);
        if (lowered !== undefined) { obj.reasoning_effort = lowered; return true; }
      }
      return false;
    }
    case "responses": {
      const r = obj.reasoning;
      if (isRecord(r) && typeof r.effort === "string") {
        const lowered = lowerEffortString(r.effort);
        if (lowered !== undefined) { r.effort = lowered; return true; }
      }
      return false;
    }
    default:
      return false;
  }
}

/** Clamp the present thinking/effort field down to the wire floor for the given
 *  dialect. Pure w.r.t. the input: clones before mutating and returns NO body
 *  (unchanged reference) when nothing is lowered, so the caller sends a
 *  byte-identical payload. `protocol` is the resolved wire dialect (null = the
 *  Api is unmapped -> no-op). */
export function applyNudgeEffortClamp(body: unknown, protocol: NudgeWire | null): NudgeEffortOutcome {
  if (!protocol || !isRecord(body)) return { changed: false };
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  if (lowerEffort(clone, protocol)) return { body: clone, changed: true };
  return { changed: false };
}
