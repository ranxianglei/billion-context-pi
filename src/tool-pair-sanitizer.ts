import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionMessageEntry["message"];
type AnyBlock = { type?: string; id?: string };

export interface ToolPairSanitizeResult {
  // Same reference as the input when nothing was dropped (byte-for-byte, prefix-cache stable).
  messages: AgentMessage[];
  // toolCallIds of dropped orphan `toolResult` messages whose matching assistant
  // `toolCall` was absent; results without a usable id are listed as "(missing toolCallId)".
  droppedResults: string[];
}

type RoleMsg = { role?: string; content?: unknown; toolCallId?: unknown };

// [#505] Request-time safety net against orphaned tool results.
//
// Compression/pruning is pair-aware (acp-kernel adjustBoundariesForToolPairs +
// computeIntegrityWithdrawals) and the converter preserves toolCallId, but a
// malformed stream that slips through reaches upstream model APIs and is rejected
// with HTTP 400 ("tool_call_id … not found"), silently killing an agentic run.
// An orphan toolResult (its matching assistant toolCall no longer visible),
// as well as one carrying a missing/non-string toolCallId (invalid upstream on
// its own), is always invalid to send, so it is removed before the request goes out; the
// caller logs the drop loudly so the underlying trigger surfaces next time.
//
// One-directional by design: a toolCall with no matching result is IN-FLIGHT
// (dropCompressReasoning never touches such a round), so orphan CALLS are left
// untouched. Pure + idempotent + fail-safe; returns the input unchanged when
// nothing is dropped so well-formed streams keep their prefix-cache identity.
export function sanitizeToolPairing(messages: AgentMessage[]): ToolPairSanitizeResult {
  const empty: ToolPairSanitizeResult = { messages, droppedResults: [] };
  if (!Array.isArray(messages) || messages.length === 0) return empty;
  try {
    const callIds = new Set<string>();
    for (const raw of messages) {
      const msg = raw as RoleMsg | null | undefined;
      if (!msg || typeof msg !== "object" || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const b of msg.content as AnyBlock[]) {
        if (b && b.type === "toolCall" && typeof b.id === "string" && b.id.length > 0) callIds.add(b.id);
      }
    }

    let changed = false;
    const out: AgentMessage[] = [];
    const droppedResults: string[] = [];
    for (const raw of messages) {
      const msg = raw as RoleMsg | null | undefined;
      if (msg && typeof msg === "object" && msg.role === "toolResult") {
        const tcid = msg.toolCallId;
        const label = typeof tcid === "string" && tcid.length > 0 ? tcid : "(missing toolCallId)";
        if (typeof tcid !== "string" || tcid.length === 0 || !callIds.has(tcid)) {
          droppedResults.push(label);
          changed = true;
          continue;
        }
      }
      out.push(raw);
    }

    return changed ? { messages: out, droppedResults } : empty;
  } catch {
    return empty;
  }
}
